import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload } from "@/lib/types";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";

// S2 fix round 1 (review finding 2): exercises the REAL vendor module's
// container-changed guard (header comment delta #10, extended by A1-1's
// delta #11 teardown-handle fix) directly against jsdom --
// GraphCanvas.test.tsx mocks lib/graph/d3-graph-vendor.js (see that file's
// own header comment: the real module does a D3 force layout + SVG
// measurement jsdom doesn't implement), so it can never observe this.
//
// A minimal 1-node, 0-cluster, 0-link payload keeps the real render()
// pipeline jsdom-safe: 0 clusters means measureLabelDims/getBBox-driven
// label measurement is never reached (only called per-cluster), and
// nebula/watermark/knot/tooltip/lodNicety all no-op on 0 clusters even
// though A1-2 waves 1-3 turned them on. `edgeChip` differs: updateEdgeChips
// calls rootNode.getScreenCTM() unconditionally (before it ever looks at
// super_clusters.length), and jsdom implements no SVG geometry methods at
// all (not even a throwing stub -- verified: `typeof svg.getScreenCTM ===
// 'undefined'`). Real browsers always have this (standard
// SVGGraphicsElement API), so the stub below belongs in the test, not
// vendor code -- see the beforeEach.
const ONE_NODE_PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "page-1",
      label: "Test Page",
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

// Task A1-3 Step 5: D3 stores each element's bound datum on `__data__`
// (standard D3 behavior, not a DOM attribute) -- reading it directly is far
// more robust than assuming DOM insertion order matches array order, and
// lets these tests identify which circle.page belongs to which node id
// without the vendor needing a test-only data-* attribute.
function circleOpacityById(container: HTMLElement, id: string): string | null {
  for (const el of Array.from(container.querySelectorAll("circle.page"))) {
    const datum = (el as unknown as { __data__?: { id?: string } }).__data__;
    if (datum && datum.id === id) return el.getAttribute("opacity");
  }
  return null;
}

// Task A1-3 Step 4: one featured singleton (never hidden by the noise
// toggle -- filterOutNoise only strips kind === "unclustered") plus one
// unclustered "noise" node, 0 clusters/links (same jsdom-safety rationale
// as ONE_NODE_PAYLOAD above).
const NOISE_PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "page-1",
      label: "Featured Page",
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/1"],
      first_visited_at: null,
    },
    {
      id: "page-2",
      label: "Background Noise Page",
      level: 0,
      kind: "unclustered",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/2"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

// Task group W (batch 03 Web Worker force sim): the real, unmocked vendor
// module now starts a Web Worker (lib/graph/sim.worker.ts, via
// lib/graph/useWorkerSim.ts) on every render() call -- jsdom implements no
// `Worker` at all (verified: `"Worker" in new JSDOM(...).window` is
// false), so every `it` in this file would otherwise throw the moment
// render() reaches that call, same class of gap this file's header
// comment already documents for `getScreenCTM`/ResizeObserver (jsdom-
// missing-API, stubbed in the TEST, not vendor code).
//
// Rather than a dumb no-op stub, this runs the REAL pipeline
// (lib/graph/sim-layout.ts's SimEngine, the same module sim.worker.ts
// itself drives) SYNCHRONOUSLY inside `postMessage` -- entirely in-
// process, no actual OS thread -- so render() completes (SVG built,
// dots painted, hulls/labels/nebula drawn, `dispose()` returned) within
// the SAME synchronous call every existing test in this file already
// expects (this file predates task group W and asserts synchronously
// right after `render(...)`, no `waitFor`/`await` gap -- rewriting every
// one of those assertions was out of scope for what this file actually
// tests: container-swap/dispose/toggleNoise/setFilterDim behavior, none
// of which is about the async settle timing task group W introduces).
// The real async pacing (paced `setTimeout`, live streamed positions) is
// covered elsewhere: lib/graph/sim-protocol.test.ts (the client
// contract, mocked Worker) and the W4 CDP acceptance trace
// (task-W-report.md) against a real browser.
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  // Signature matches `new Worker(url, options)` -- both args ignored,
  // this fake never actually loads a script.
  constructor(_scriptURL?: unknown, _options?: unknown) {}

  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return; // stop/reheat: unexercised by this file's tests
    const engine = createSimEngine(message as SimStartPayload);
    this.emit({ type: "tick", positions: engine.snapshot() });
    if (engine.done) {
      this.emit({ type: "end", positions: engine.snapshot() });
      return;
    }
    let done = false;
    while (!done) {
      done = engine.step();
      this.emit(done ? { type: "end", positions: engine.snapshot() } : { type: "tick", positions: engine.snapshot() });
    }
  }

  terminate(): void {
    this.onmessage = null;
  }

  private emit(message: WorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

// Task group W fix round 1 (dispose-mid-settle coverage): SyncFakeSimWorker
// above always runs a `start` to full completion (tick..end) within ONE
// synchronous `postMessage` call -- there is no "mid-settle" moment a test
// could dispose() into. This fake gives the TEST manual control over
// pacing instead: `postMessage({type:"start",...})` emits only the FIRST
// tick (the phyllotaxis seed, matching the real worker's own contract),
// then waits for the test to call `step()` explicitly to advance one tick
// at a time. `postMessage({type:"stop"})` mirrors sim.worker.ts's own
// handleStop (nulls the engine) so a `step()` call after `stop` is a
// no-op -- the same observable a REAL worker would produce once it's
// processed a `stop` message, letting a test simulate "the vendor's
// createWorkerSim.stop() already suppressed delivery client-side, AND
// separately the worker itself has stopped ticking" in one object.
class ManualStepSimWorker {
  // Self-registers the most recently constructed instance -- tests have
  // no other handle onto whatever instance createWorkerSim's internal
  // `new Worker(...)` produced (it's constructed deep inside the vendor
  // module, not returned anywhere), so this is how a test reaches in to
  // call `step()` on it.
  static lastInstance: ManualStepSimWorker | null = null;

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  private engine: ReturnType<typeof createSimEngine> | null = null;

  constructor(_scriptURL?: unknown, _options?: unknown) {
    ManualStepSimWorker.lastInstance = this;
  }

  postMessage(message: MainToWorkerMessage): void {
    if (message.type === "stop") {
      this.engine = null;
      return;
    }
    if (message.type !== "start") return;
    const engine = createSimEngine(message as SimStartPayload);
    this.engine = engine;
    this.emit({ type: "tick", positions: engine.snapshot() });
    if (engine.done) this.emit({ type: "end", positions: engine.snapshot() });
  }

  /** Test-only: advance one tick and emit the resulting tick/end message.
   *  A no-op once `stop` has nulled the engine -- matches
   *  sim.worker.ts's own scheduleFrame, which checks `if (!engine)
   *  return;` before ever ticking again. */
  step(): void {
    const engine = this.engine;
    if (!engine || engine.done) return;
    const done = engine.step();
    this.emit(done ? { type: "end", positions: engine.snapshot() } : { type: "tick", positions: engine.snapshot() });
  }

  terminate(): void {
    this.engine = null;
    this.onmessage = null;
  }

  private emit(message: WorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

// Batch 03 final whole-branch review fix (vendor header comment delta
// #23): this project's jsdom environment implements no ResizeObserver at
// all (see the "container-changed guard" describe block's own comment
// below), so the vendor's `if (typeof ResizeObserver !== 'undefined')`
// guard is always false here and `__resizeObserverHandle` never gets
// set -- every OTHER test in this file that touches dispose()/remount
// can only observe that gap's Escape-listener half. The one new test
// below needs to observe the ResizeObserver half too (that's exactly
// what delta #23 fixed), so it stubs this minimal fake in for its own
// scope only -- `vi.unstubAllGlobals()` in the top-level `afterEach`
// below removes it again before the next test.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observedElements: Element[] = [];
  disconnected = false;

  constructor(_callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observedElements.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

// One real 2-page cluster (no super_cluster -- keeps Phase 1.5/1.75's
// SC-pass complexity out of scope, this payload only needs to make Phase
// 2 actually tick instead of settling immediately) -- Phase 2 always runs
// a FIXED 150 ticks per cluster regardless of member count
// (lib/graph/sim-layout.ts's own header comment), so `engine.done` stays
// false for many `step()` calls no matter how few nodes are in it; that
// fixed-count guarantee is what makes "dispose after a couple of manual
// steps, well before the 150th" a reliable mid-settle window rather than
// a race.
const MID_SETTLE_PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "page-1",
      label: "Page One",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: "c1",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/1"],
      first_visited_at: null,
    },
    {
      id: "page-2",
      label: "Page Two",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: "c1",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/2"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [{ id: "c1", name: "Cluster One", page_ids: ["page-1", "page-2"] }],
  super_clusters: [],
  groups: [],
};

beforeEach(() => {
  vi.stubGlobal("Worker", SyncFakeSimWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Task group W fix round 1 (chunking finishRenderAfterSettle): every
// render() call that reaches settle now schedules 2 more rAF-deferred
// chunks (jsdom has no real requestAnimationFrame, so these fall back to
// `setTimeout(cb, 16)` -- see the vendor's own __rafSchedule comment) on
// top of SyncFakeSimWorker's own fully-synchronous tick-to-end delivery.
// Left undrained, those become LEAKED pending timers that fire during a
// LATER, unrelated test -- and since chunk 3 calls fitToContent ->
// updateEdgeChips -> getScreenCTM(), a leaked chunk firing after some
// LATER test's own afterEach has already removed ITS getScreenCTM stub
// would throw in that later test, not this one. window.__d3FlushSettleChunk
// (dev/test-only, wired in d3-graph-vendor.js right next to
// window.__d3GraphRender) synchronously drains every still-pending chunk
// for the CURRENT run -- called from the FIRST line of each describe
// block's own afterEach below, deliberately BEFORE that block's own
// getScreenCTM stub gets removed a few lines later in the SAME afterEach
// callback (so this doesn't depend on any cross-scope --
// describe-block-local vs top-level-file -- afterEach ordering guarantee,
// only on statements within one callback running top-to-bottom).
function flushSettleChunks(): void {
  const w = window as unknown as { __d3FlushSettleChunk?: () => boolean };
  for (let i = 0; i < 10 && w.__d3FlushSettleChunk?.(); i++) {
    // keep draining until nothing is left pending (bounded so a bug
    // in the flush itself can't hang the test suite)
  }
}

describe("d3-graph-vendor render() container-changed guard", () => {
  beforeEach(() => {
    // Pre-seeds a real --galaxy-0 custom property so render()'s
    // retryColors() self-scheduling setTimeout loop (up to 15x/200ms,
    // polling for real CSS custom properties) finds one immediately and
    // never schedules a timer -- keeps the test deterministic and avoids
    // leaking pending timers across tests.
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    // jsdom stub for SVGGraphicsElement.getScreenCTM (see the module
    // comment above for why this belongs here, not in vendor code).
    // Identity-ish matrix is enough -- ONE_NODE_PAYLOAD has 0
    // super_clusters, so updateEdgeChips's own forEach over them never
    // executes; this only needs to keep the unconditional call from
    // throwing.
    (
      SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }
    ).getScreenCTM = () =>
      ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
  });

  afterEach(() => {
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown })
      .getScreenCTM;
  });

  it("builds a fresh SVG in a newly mounted container after a remount", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, {});
    expect(containerA.querySelector("svg")).not.toBeNull();

    // Simulate GraphCanvas unmounting (its container leaves the document)
    // and remounting into a brand-new container -- e.g. a client-side nav
    // away from and back to the app shell's center panel.
    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    render(containerB, ONE_NODE_PAYLOAD, {});

    // Pre-fix: the module-level `svg` still pointed at containerA's
    // (detached) <svg>, so the internal render()'s `if (!svg)` block never
    // ran again -- nothing got appended to containerB at all (the "blank
    // canvas, no error" bug from the review finding).
    expect(containerB.querySelector("svg")).not.toBeNull();
  });

  it("accepts a second mount's tunerSnapshot without throwing (finding 2's __tunerInitialized half)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    // Pre-fix, __tunerInitialized never reset past the first mount, so a
    // second mount's tunerSnapshot was silently ignored rather than
    // erroring -- there's no public getter to read the applied tuner state
    // back through, so this is a smoke check (doesn't throw, still paints)
    // rather than a pixel-level assertion. The container-changed guard's
    // `__tunerInitialized = false` reset is what makes applyTunerSnapshot
    // run again here at all.
    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, { tunerSnapshot: GRAPH_DEFAULTS });

    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    expect(() =>
      render(containerB, ONE_NODE_PAYLOAD, {
        tunerSnapshot: { ...GRAPH_DEFAULTS, BASE_LABEL_FONT_SIZE: 11 },
      }),
    ).not.toThrow();
    expect(containerB.querySelector("svg")).not.toBeNull();
  });

  // A1-1 fix round 1 (review finding: the real dispose() path had zero
  // coverage -- GraphCanvas.test.tsx's own dispose test only proves
  // GraphCanvas calls whatever render() returns, against a `disposeMock`
  // the test's own vi.mock factory fabricates; it can't catch a future
  // edit that drops `return dispose` or guts teardownContainerHandlers()
  // in the REAL vendor. These three tests close that gap against the
  // unmocked module (vendor header comment delta #11).
  //
  // ResizeObserver is not present in this project's jsdom environment
  // (verified: `"ResizeObserver" in new JSDOM(...).window` is false, and
  // vitest.setup.ts adds no polyfill) -- the vendor's own
  // `typeof ResizeObserver !== 'undefined'` guard is therefore false here,
  // so `__resizeObserverHandle` never gets set and its disconnect() half
  // of teardownContainerHandlers() is a no-op in this suite. The Escape
  // keydown listener has no such environment gap, so these tests exercise
  // that half directly via document.addEventListener/removeEventListener
  // spies -- the same observable the review specifically asked for.
  it("render() returns a dispose() function (the teardown handle exists on the real module)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const dispose = render(container, ONE_NODE_PAYLOAD, {});

    expect(typeof dispose).toBe("function");
  });

  it("dispose() removes the exact Escape keydown listener render() registered", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const addSpy = vi.spyOn(document, "addEventListener");
    const dispose = render(container, ONE_NODE_PAYLOAD, {});

    // Find the keydown handler this render() call registered -- asserting
    // against the EXACT function reference (not just "was called with
    // 'keydown', expect.any(Function)") proves dispose() removes the SAME
    // listener render() added, not merely some keydown listener.
    const keydownCall = addSpy.mock.calls.find(([type]) => type === "keydown");
    expect(keydownCall).toBeDefined();
    const registeredHandler = keydownCall![1];
    addSpy.mockRestore();

    const removeSpy = vi.spyOn(document, "removeEventListener");
    expect(removeSpy).not.toHaveBeenCalled();

    dispose();

    expect(removeSpy).toHaveBeenCalledWith("keydown", registeredHandler);
    removeSpy.mockRestore();
  });

  it("a stale dispose() from a superseded mount does not tear down the current mount's handlers", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    const disposeA = render(containerA, ONE_NODE_PAYLOAD, {});

    // Remount against a fresh container -- the container-swap guard inside
    // render() already tears down containerA's OWN Escape listener as part
    // of THIS call (covered by the "builds a fresh SVG" test above); what
    // it must NOT do is leave disposeA() able to reach in and remove
    // containerB's listener later.
    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);

    const addSpy = vi.spyOn(document, "addEventListener");
    render(containerB, ONE_NODE_PAYLOAD, {});
    const bKeydownCall = addSpy.mock.calls.find(([type]) => type === "keydown");
    expect(bKeydownCall).toBeDefined();
    const bHandler = bKeydownCall![1];
    addSpy.mockRestore();

    const removeSpy = vi.spyOn(document, "removeEventListener");

    // Stale: disposeA closed over containerA, which is no longer the
    // mounted container -- the `__mountedContainer !== container` guard
    // inside the returned dispose() must make this a no-op rather than
    // reaching in and removing containerB's live listener.
    expect(() => disposeA()).not.toThrow();
    expect(removeSpy).not.toHaveBeenCalledWith("keydown", bHandler);

    removeSpy.mockRestore();
  });

  // Task group W fix round 1 (review finding, Medium): dispose() only
  // tore down the container/Escape/ResizeObserver handlers -- the sim run
  // itself kept ticking after final unmount, painting into a DETACHED svg
  // (up to 60Hz) until it settled, then still running the full
  // finishRenderAfterSettle tail for a container nobody can see anymore.
  // Uses ManualStepSimWorker (not the file's default SyncFakeSimWorker,
  // which always completes a run in one synchronous call and so has no
  // "mid-settle" moment to dispose() into) to genuinely pause the run
  // between ticks.
  it("unmount mid-settle stops the run -- no further paints, no post-dispose onFirstPaint, no settle-tail draw", async () => {
    vi.stubGlobal("Worker", ManualStepSimWorker);
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onFirstPaint = vi.fn();
    const dispose = render(container, MID_SETTLE_PAYLOAD, { onFirstPaint });

    // First tick (the phyllotaxis seed) already painted synchronously,
    // exactly as it does with the real worker.
    expect(onFirstPaint).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("circle.page").length).toBe(2);

    const worker = ManualStepSimWorker.lastInstance;
    expect(worker).toBeTruthy();
    const postMessageSpy = vi.spyOn(worker!, "postMessage");

    // Advance a handful of ticks -- Phase 2 always runs a FIXED 150 ticks
    // per cluster regardless of member count (sim-layout.ts's own header
    // comment), so this is reliably still mid-settle, not a race.
    for (let i = 0; i < 5; i++) worker!.step();

    const dotBefore = container.querySelector("circle.page")!;
    const cxBefore = dotBefore.getAttribute("cx");
    const cyBefore = dotBefore.getAttribute("cy");

    dispose();

    // The fix: dispose() must have told the sim client to stop.
    expect(postMessageSpy).toHaveBeenCalledWith({ type: "stop" });

    // Simulate the worker "still trying" to deliver more messages after
    // dispose() -- including driving it all the way to a hypothetical
    // `end` -- exercising BOTH createWorkerSim's own client-side
    // suppression AND the vendor's own belt-and-suspenders __simRunCtx
    // null-out (handleSimTick/handleSimEnd's `if (!ctx) return;` guards).
    for (let i = 0; i < 200; i++) worker!.step();

    const dotAfter = container.querySelector("circle.page")!;
    expect(dotAfter.getAttribute("cx")).toBe(cxBefore);
    expect(dotAfter.getAttribute("cy")).toBe(cyBefore);
    expect(onFirstPaint).toHaveBeenCalledTimes(1); // not called again
    // finishRenderAfterSettle (chunk 1's drawHulls) never ran for this
    // disposed run -- it never reached a live `end`.
    expect(container.querySelector(".hull-label")).toBeNull();
  });

  // Task group W fix round 1: the TRAP the review explicitly flagged --
  // dispose() must call __simClient.stop(), never __simClient.dispose(),
  // or render()'s own `if (!__simClient) { __simClient =
  // createWorkerSim(...); }` guard (header comment delta #19b) would
  // never recreate a permanently-disposed controller, silently breaking
  // every future mount in the app's lifetime (not just this container's).
  it("remount after a full unmount still works -- __simClient stays usable, not permanently disposed", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    const disposeA = render(containerA, ONE_NODE_PAYLOAD, {});
    expect(containerA.querySelectorAll("circle.page").length).toBe(1);

    disposeA();

    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);

    // If __simClient were dead (the trapped `.dispose()` mistake), this
    // .start() would be a silent no-op and containerB would stay empty
    // forever -- SyncFakeSimWorker's synchronous delivery means a real
    // failure here shows up as an immediate, deterministic assertion
    // failure, not a flaky timing gap.
    expect(() => render(containerB, ONE_NODE_PAYLOAD, {})).not.toThrow();
    expect(containerB.querySelectorAll("circle.page").length).toBe(1);
  });

  // Task group W fix round 1: confirms the dispose() edit above left the
  // (already-working, unrelated) container-swap path alone -- a swap
  // falls through to the SAME render() call's own `.start()`, which
  // already supersedes any prior run as part of its normal contract, so
  // there was never a detached-worker gap on this path to begin with.
  // Same shape as "builds a fresh SVG..." above, plus the circle.page
  // count check that test doesn't make, closing the gap explicitly rather
  // than only by inference from the other test passing.
  it("container-swap (remount WITHOUT disposing first) still paints the new container -- unregressed by the dispose fix", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, {});
    expect(containerA.querySelectorAll("circle.page").length).toBe(1);

    // No dispose() call here -- e.g. GraphCanvas re-rendering into a
    // fresh container without an intervening full unmount.
    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    render(containerB, ONE_NODE_PAYLOAD, {});

    expect(containerB.querySelectorAll("circle.page").length).toBe(1);
  });

  // Batch 03 final whole-branch review fix (header comment delta #23):
  // the third geometry alongside "builds a fresh SVG in a newly mounted
  // container..." (dispose -> new container) and "container-swap...
  // WITHOUT disposing first" (new container, no dispose) above --
  // dispose(), THEN render() again into the SAME container, e.g.
  // GraphCanvas.tsx's mount effect disposing on a `hasNodes` true->false
  // transition and re-mounting on the next true against the same
  // never-swapped container div. Pre-fix: `svg` stayed non-null across
  // dispose() (only teardownContainerHandlers() ran), so the
  // container-swap guard saw no container change and render()'s `if
  // (!svg)` block -- the only construction site for the Escape listener
  // and the ResizeObserver alike -- never ran again on the second
  // render(), leaving both permanently dead for that mount.
  it("dispose() then render() into the SAME container rebuilds the Escape listener and ResizeObserver (not just leaves them dead)", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const container = document.createElement("div");
    document.body.appendChild(container);

    const firstAddSpy = vi.spyOn(document, "addEventListener");
    const dispose = render(container, ONE_NODE_PAYLOAD, {});
    const firstKeydownCall = firstAddSpy.mock.calls.find(([type]) => type === "keydown");
    expect(firstKeydownCall).toBeDefined();
    const firstHandler = firstKeydownCall![1];
    firstAddSpy.mockRestore();

    expect(FakeResizeObserver.instances).toHaveLength(1);
    const firstObserver = FakeResizeObserver.instances[0];
    expect(firstObserver.observedElements).toContain(container);
    expect(firstObserver.disconnected).toBe(false);

    // The hasNodes true->false transition: GraphCanvas's mount-effect
    // cleanup disposes, but the container div itself is never removed
    // from the document (it's unconditionally rendered regardless of
    // hasNodes) -- simulated here by disposing WITHOUT touching
    // `container` at all.
    dispose();
    expect(firstObserver.disconnected).toBe(true); // teardownContainerHandlers() ran

    // The hasNodes false->true transition: re-render into the exact same
    // container node.
    const secondAddSpy = vi.spyOn(document, "addEventListener");
    render(container, ONE_NODE_PAYLOAD, {});
    const secondKeydownCall = secondAddSpy.mock.calls.find(([type]) => type === "keydown");
    secondAddSpy.mockRestore();

    // The fix: a NEW Escape listener was registered (not silently
    // skipped because `if (!svg)` saw a still-non-null `svg`) --
    // asserting a DIFFERENT function reference than firstHandler proves
    // reconstruction, not merely that some keydown listener exists
    // (which could be the pre-fix leaked original still sitting there).
    expect(secondKeydownCall).toBeDefined();
    expect(secondKeydownCall![1]).not.toBe(firstHandler);

    // The fix: a NEW ResizeObserver was constructed and is observing the
    // (same) container -- pre-fix, FakeResizeObserver.instances would
    // still have length 1 here (the first, already-disconnected one).
    expect(FakeResizeObserver.instances).toHaveLength(2);
    const secondObserver = FakeResizeObserver.instances[1];
    expect(secondObserver.observedElements).toContain(container);
    expect(secondObserver.disconnected).toBe(false);

    // Regression guard for the fix's OWN documented risk (delta #23's
    // "would stack a second <svg>" paragraph): exactly one <svg>, not
    // two, inside the reused container.
    expect(container.querySelectorAll("svg").length).toBe(1);
    expect(container.querySelectorAll("circle.page").length).toBe(1);
  });
});

// Task A1-3 Step 4 (header comment delta #14): the DOM-mirror seam
// (#noise-toggle-json) is gone -- these exercise the REAL toggleNoise(show)
// setter against the real module, since GraphCanvas.test.tsx's mocked
// vendor can't observe whether the module's own state/re-render actually
// changed. Explicitly calls toggleNoise() to a KNOWN value before each
// assertion (not relying on the module's own `true` default) since
// __showNoise is module-level state that persists across tests in this
// file, same class of shared-state concern __mountedContainer/rawData
// already have here.
describe("d3-graph-vendor toggleNoise() (Task A1-3 Step 4)", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    (
      SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }
    ).getScreenCTM = () =>
      ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
  });

  afterEach(() => {
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown })
      .getScreenCTM;
  });

  it("show=true renders both the featured singleton and the unclustered noise page", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    toggleNoise(true);
    render(container, NOISE_PAYLOAD, {});

    expect(container.querySelectorAll("circle.page").length).toBe(2);
  });

  it("show=false filters the unclustered noise page out of the rendered set", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    toggleNoise(true);
    render(container, NOISE_PAYLOAD, {});
    expect(container.querySelectorAll("circle.page").length).toBe(2);

    toggleNoise(false);
    expect(container.querySelectorAll("circle.page").length).toBe(1);
    expect(container.querySelector("circle.page.unclustered")).toBeNull();
  });

  it("toggling back to show=true restores the noise page (re-render from rawData, not a one-shot filter)", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    toggleNoise(true);
    render(container, NOISE_PAYLOAD, {});
    toggleNoise(false);
    expect(container.querySelectorAll("circle.page").length).toBe(1);

    toggleNoise(true);
    expect(container.querySelectorAll("circle.page").length).toBe(2);
  });

  it("a toggleNoise() call BEFORE the first render() still records the intended state for that first render", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    // No render() yet -- rawData is null, so this must not throw, and must
    // not silently drop the intended state either (the fix: __showNoise is
    // written BEFORE the `if (!rawData) return;` guard).
    expect(() => toggleNoise(false)).not.toThrow();

    render(container, NOISE_PAYLOAD, {});
    expect(container.querySelectorAll("circle.page").length).toBe(1);

    toggleNoise(true); // restore for any test ordering after this one
  });

  it("toggleNoise(false) with no dataset rendered yet is a safe no-op (nothing to re-render)", async () => {
    const { toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    expect(() => toggleNoise(false)).not.toThrow();
    toggleNoise(true); // restore
  });
});

// Task A1-3 Step 5 (header comment delta #15): three singletons, 0
// clusters/links (same jsdom-safety rationale as ONE_NODE_PAYLOAD) --
// enough to test composition (a selected node, a filter-visible node, and
// a plain node that neither layer keeps visible) without needing the
// cluster-label code paths.
function threeNodePayload(): GraphPayload {
  function singleton(id: string): GraphPayload["nodes"][number] {
    return {
      id,
      label: id,
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/" + id],
      first_visited_at: null,
    };
  }
  return {
    nodes: [singleton("page-1"), singleton("page-2"), singleton("page-3")],
    links: [],
    clusters: [],
    super_clusters: [],
    groups: [],
  };
}

describe("d3-graph-vendor setFilterDim() composes with selection (Task A1-3 Step 5)", () => {
  beforeEach(async () => {
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    (
      SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }
    ).getScreenCTM = () =>
      ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
    // selectedNodeId/selectedClusterId/.../filterDimNodeIds are module-level
    // singletons that persist across tests in this file (same class of
    // shared-state concern __mountedContainer/rawData/__showNoise already
    // have here) -- reset BOTH selection and filter to a known-clear state
    // before every test rather than assuming whatever the previous test
    // left behind. updateHighlighting() itself no-ops harmlessly here since
    // no container/svg exists yet at this point in a fresh test.
    const { setSelection, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    setSelection("node", null); // null id clears every internal selection var (__vendorSetSelection)
    setFilterDim([]);
  });

  afterEach(() => {
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown })
      .getScreenCTM;
  });

  it("no selection, no filter -- everything full opacity", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("1");
    expect(circleOpacityById(container, "page-3")).toBe("1");
  });

  it("filter alone dims everything NOT in the filter set", async () => {
    const { render, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setFilterDim(["page-2"]);

    expect(circleOpacityById(container, "page-1")).toBe("0.15");
    expect(circleOpacityById(container, "page-2")).toBe("1");
    expect(circleOpacityById(container, "page-3")).toBe("0.15");
  });

  it("selection alone (no filter) dims everything except the selected node -- pre-existing behavior, unchanged", async () => {
    const { render, setSelection } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setSelection("node", "page-1");

    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("0.15");
    expect(circleOpacityById(container, "page-3")).toBe("0.15");
  });

  it("selection AND filter compose (union): a selected node inside a dimmed-out set stays visible, PLUS the filter's own set stays visible -- neither clobbers the other", async () => {
    const { render, setSelection, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    // Filter keeps page-2 visible; page-1 (selected below) would otherwise
    // be OUTSIDE that filter set -- this is exactly the brief's own
    // "selected node inside a dimmed-out set" scenario.
    setFilterDim(["page-2"]);
    setSelection("node", "page-1");

    expect(circleOpacityById(container, "page-1")).toBe("1"); // selection layer
    expect(circleOpacityById(container, "page-2")).toBe("1"); // filter layer
    expect(circleOpacityById(container, "page-3")).toBe("0.15"); // excluded by BOTH layers
  });

  it("setFilterDim does not clobber the current selection -- selection survives filter changes and clears", async () => {
    const { render, setSelection, setFilterDim, debugGetSelection } = await import(
      "@/lib/graph/d3-graph-vendor.js"
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setSelection("node", "page-1");
    expect(debugGetSelection().selectedNodeId).toBe("page-1");

    setFilterDim(["page-2"]);
    expect(debugGetSelection().selectedNodeId).toBe("page-1"); // untouched by the filter call

    setFilterDim([]); // clear the filter
    expect(debugGetSelection().selectedNodeId).toBe("page-1"); // still untouched

    // Back to selection-only behavior once the filter clears.
    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("0.15");
    expect(circleOpacityById(container, "page-3")).toBe("0.15");
  });

  it("clearing the filter (empty array) with NO selection restores full visibility for everyone", async () => {
    const { render, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setFilterDim(["page-2"]);
    expect(circleOpacityById(container, "page-1")).toBe("0.15");

    setFilterDim([]);

    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("1");
    expect(circleOpacityById(container, "page-3")).toBe("1");
  });
});
