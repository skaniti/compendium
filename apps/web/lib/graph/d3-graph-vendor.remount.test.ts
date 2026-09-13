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

// Batch 03 graph fix wave V4, item 1 (header comment delta #30): the
// interim zoom clamp. window.__d3GetZoomScaleExtent is a dev/test-only
// escape hatch (same class as window.__d3FlushSettleChunk) exposing the
// CURRENT render cycle's live zoom behavior's scaleExtent -- reading it
// directly is far simpler and more deterministic than driving a real
// d3-zoom wheel gesture/transition through jsdom.
describe("d3-graph-vendor render() interim zoom clamp (header comment delta #30)", () => {
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

  function zoomScaleExtent(): [number, number] | null {
    const w = window as unknown as { __d3GetZoomScaleExtent?: () => [number, number] | null };
    return w.__d3GetZoomScaleExtent?.() ?? null;
  }

  it("seeds the interim scaleExtent from the PRIOR cycle's already-settled fitZoom instead of the wide-open absolute default", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    // Let chunk 3's fitToContent run -- this sets the real, settled fitZoom
    // and the fit-relative scaleExtent (fitZoom*MIN_ZOOM_RATIO..fitZoom*4).
    flushSettleChunks();
    const settledExtent = zoomScaleExtent();
    expect(settledExtent).toBeTruthy();
    // Sanity: for a real (non-degenerate) fit, this is never the absolute
    // default -- if it were, the rest of this test couldn't discriminate.
    expect(settledExtent).not.toEqual([0.05, 6]);

    // Second render() cycle on the SAME mount (e.g. a noise toggle / tuner
    // change / knot-expand re-render) -- read the scaleExtent SYNCHRONOUSLY,
    // right after render() returns and BEFORE this cycle's own settle (and
    // therefore its own fitToContent) has had any chance to run. This is
    // exactly the interim window the fix targets.
    render(container, ONE_NODE_PAYLOAD, {});
    const interimExtent = zoomScaleExtent();

    // Fix: seeded from the prior cycle's already-settled fitZoom, so the
    // interim extent is IDENTICAL to the settled one above -- not the
    // wide-open [0.05, 6] absolute default. Pre-fix, this would read
    // [0.05, 6] here regardless of settledExtent.
    expect(interimExtent).toEqual(settledExtent);
    expect(interimExtent).not.toEqual([0.05, 6]);

    flushSettleChunks();
  });

  it("keeps the wide-open absolute default on the VERY FIRST render (no prior fitZoom for this mount)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    // Read SYNCHRONOUSLY, before this first cycle's own settle/fitToContent
    // has run -- there is no prior mount for this container to seed from.
    expect(zoomScaleExtent()).toEqual([0.05, 6]);

    flushSettleChunks();
  });

  it("keeps the wide-open absolute default on the first render after a container swap (no prior fit for the NEW mount)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, {});
    flushSettleChunks();
    // Sanity: containerA really did settle to a real (non-default) fit.
    expect(zoomScaleExtent()).not.toEqual([0.05, 6]);

    // A container swap (S2 fix round 1 / A1-1, header comment delta #10/#11)
    // nulls `svg` -- the NEW mount has no prior fit of its own to seed
    // from, even though the module-level `fitZoom` var still holds
    // containerA's stale value.
    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    render(containerB, ONE_NODE_PAYLOAD, {});
    expect(zoomScaleExtent()).toEqual([0.05, 6]);

    flushSettleChunks();
  });
});

// Batch 03 graph fix wave V4, item 2 (header comment delta #31): the
// settle lifecycle callbacks onRenderCycleStart/onSettleEnd, and the
// generalized carry-forward that keeps both alive across an opts-omitted
// OR opts-sparse re-render (delta #31 generalizes delta #28's mechanism,
// which only ever covered onFirstPaint on an entirely-omitted opts).
describe("d3-graph-vendor render() settle lifecycle callbacks (header comment delta #31)", () => {
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

  it("fires onRenderCycleStart synchronously at render() entry, and onSettleEnd once chunk 3 completes", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onRenderCycleStart = vi.fn();
    const onSettleEnd = vi.fn();
    render(container, ONE_NODE_PAYLOAD, { onRenderCycleStart, onSettleEnd });

    // Synchronous: already fired by the time render() returns.
    expect(onRenderCycleStart).toHaveBeenCalledTimes(1);
    // NOT yet fired -- settle (the worker's async tick->end plus the
    // rAF-chunked finishRenderAfterSettle tail) hasn't completed.
    expect(onSettleEnd).not.toHaveBeenCalled();

    flushSettleChunks();
    expect(onSettleEnd).toHaveBeenCalledTimes(1);
  });

  it("does not fire either callback for a zero-node payload (render()'s own empty-payload guard runs first)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onRenderCycleStart = vi.fn();
    const onSettleEnd = vi.fn();

    render(
      container,
      { nodes: [], links: [], clusters: [], super_clusters: [], groups: [] },
      { onRenderCycleStart, onSettleEnd },
    );

    expect(onRenderCycleStart).not.toHaveBeenCalled();
    expect(onSettleEnd).not.toHaveBeenCalled();
  });

  it("carries both callbacks through an opts-OMITTED re-render (toggleNoise's render(rawData) tail)", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onRenderCycleStart = vi.fn();
    const onSettleEnd = vi.fn();
    toggleNoise(true);
    render(container, NOISE_PAYLOAD, { onRenderCycleStart, onSettleEnd });
    flushSettleChunks();
    expect(onRenderCycleStart).toHaveBeenCalledTimes(1);
    expect(onSettleEnd).toHaveBeenCalledTimes(1);

    toggleNoise(false); // internally: render(rawData) -- opts omitted entirely
    // Discriminating: pre-fix, this second cycle's callbacks would never
    // fire at all (opts silently dropped, same class of bug delta #28
    // originally fixed for onFirstPaint alone).
    expect(onRenderCycleStart).toHaveBeenCalledTimes(2);
    flushSettleChunks();
    expect(onSettleEnd).toHaveBeenCalledTimes(2);

    toggleNoise(true); // restore for any test ordering after this one
    flushSettleChunks();
  });

  // toggleGroupExpansion's knot-expand render(rawData, {preserveView,
  // frameGroupId}) call passes a REAL but SPARSE opts object -- neither
  // key is omitted-opts in the literal sense delta #28 originally handled,
  // which is exactly why item 2's brief calls this site out by name as
  // needing the generalized carry-forward (delta #31), not just delta #28's
  // original opts-omitted-entirely fallback.
  it("carries both callbacks through an opts-SPARSE re-render (toggleGroupExpansion's knot-expand render call)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const GROUP_ID = 90210;
    function member(id: string, parent: string): GraphPayload["nodes"][number] {
      return {
        id,
        label: id,
        level: 0,
        kind: "cluster",
        visit_count: 1,
        parent_id: parent,
        children_ids: [],
        capture_ids: [],
        page_urls: ["https://example.com/" + id],
        first_visited_at: null,
      };
    }
    const payload: GraphPayload = {
      nodes: [member("page-1", "solo"), member("page-2", "grp"), member("page-3", "grp")],
      links: [],
      clusters: [
        { id: "solo", name: "Solo Cluster", page_ids: ["page-1"] },
        {
          id: "grp",
          name: "Group Cluster",
          page_ids: ["page-2", "page-3"],
          group_id: GROUP_ID,
          group_tier: "casual",
          group_label: "Delta 31 Test Group",
        },
      ],
      super_clusters: [],
      groups: [],
    };

    const onRenderCycleStart = vi.fn();
    const onSettleEnd = vi.fn();
    render(container, payload, { onRenderCycleStart, onSettleEnd });
    flushSettleChunks();
    expect(onRenderCycleStart).toHaveBeenCalledTimes(1);
    expect(onSettleEnd).toHaveBeenCalledTimes(1);

    const groups = Array.from(container.querySelectorAll("g.group-label-group"));
    const target = groups.find((g) => g.querySelector("text")?.textContent?.includes("Delta 31 Test Group"));
    expect(target).toBeTruthy();
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); // expand

    expect(onRenderCycleStart).toHaveBeenCalledTimes(2);
    flushSettleChunks();
    expect(onSettleEnd).toHaveBeenCalledTimes(2);
  });
});

// Graph interaction follow-ups, Batch B (spec docs/project-plans/2026-09-13-
// 183006-graph-interaction-followups/spec.md; header comment delta #34):
// onViewChange fires on every 'zoom' tick -- pan, wheel, __d3ZoomTo alike --
// with the just-clamped transform plus the most recent fit's own transform.
describe("d3-graph-vendor render() onViewChange (header comment delta #34)", () => {
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

  function zoomTo(k: number): boolean {
    const w = window as unknown as { __d3ZoomTo?: (k: number) => boolean };
    return w.__d3ZoomTo?.(k) ?? false;
  }

  type ViewCall = { x: number; y: number; k: number; fitX: number; fitY: number; fitK: number; cx: number; cy: number };

  it("fires with {x, y, k, fitX, fitY, fitK, cx, cy} on the fit tick, and again (fit fields unchanged) on a later __d3ZoomTo", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onViewChange = vi.fn();
    render(container, ONE_NODE_PAYLOAD, { onViewChange });
    flushSettleChunks(); // runs fitToContent -- fires the fit tick synchronously

    expect(onViewChange).toHaveBeenCalled();
    const fitCall = onViewChange.mock.calls[onViewChange.mock.calls.length - 1][0] as ViewCall;
    expect(fitCall).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      k: expect.any(Number),
      fitX: expect.any(Number),
      fitY: expect.any(Number),
      fitK: expect.any(Number),
      cx: expect.any(Number),
      cy: expect.any(Number),
    });
    // Fix review I1: __fitTransform is now recorded BEFORE
    // `svg.call(zoomBehavior.transform, transform)` (which dispatches
    // 'zoom' synchronously) -- so the fit tick's own onViewChange call
    // reads the transform IT JUST ESTABLISHED, not a stale prior one, and
    // x/y/k are therefore EXACTLY equal to fitX/fitY/fitK (not merely
    // "close to" -- this is the fixed behavior the pre-fix code got wrong,
    // see that assignment's own comment for the full writeup).
    expect(fitCall.x).toBe(fitCall.fitX);
    expect(fitCall.y).toBe(fitCall.fitY);
    expect(fitCall.k).toBe(fitCall.fitK);

    onViewChange.mockClear();
    const newK = fitCall.fitK * 2; // within fitToContent's [fitK*0.5, fitK*4] scaleExtent
    expect(zoomTo(newK)).toBe(true);

    expect(onViewChange).toHaveBeenCalledTimes(1);
    const zoomCall = onViewChange.mock.calls[0][0] as ViewCall;
    expect(zoomCall.k).toBeCloseTo(newK);
    // Reference point unchanged -- still the transform (and canvas center)
    // the earlier fit established, not this zoom's own transform.
    expect(zoomCall.fitX).toBeCloseTo(fitCall.fitX);
    expect(zoomCall.fitY).toBeCloseTo(fitCall.fitY);
    expect(zoomCall.fitK).toBeCloseTo(fitCall.fitK);
    expect(zoomCall.cx).toBeCloseTo(fitCall.cx);
    expect(zoomCall.cy).toBeCloseTo(fitCall.cy);
  });

  // Fix review I1: the bug was that __fitTransform got recorded AFTER
  // dispatching 'zoom', so EVERY refit (not just the very first one) read
  // stale fitX/fitY/fitK on its own fit tick -- a resize's re-fit is the
  // most visible case (Starfield.tsx would sit at half the correct
  // parallax offset until the user's next pan/zoom). A container-SWAP
  // would NOT discriminate this bug (delta #34 already resets
  // __fitTransform to null on a swap, so a swapped mount's first fit
  // trivially satisfies x===fitX either way) -- this instead re-renders
  // into the SAME, non-swapped container at a DIFFERENT canvas size.
  // render() re-reads container.getBoundingClientRect() fresh on every
  // call, so this reaches a genuinely NEW fitToContent call (different
  // canvasW/canvasH -> different transform) while __fitTransform (a module
  // var that survives across render() calls for the SAME mount) still
  // holds the FIRST fit's value until this cycle's own fitToContent
  // reassigns it -- exactly the window the pre-fix assignment-order bug
  // exposed: pre-fix, `x` (the new, different-size fit) would NOT equal
  // `fitX` (the stale first fit) on this tick.
  it("a SECOND fit (same mount, different canvas size) also publishes x === fitX on its own tick, not the stale prior fit", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, ONE_NODE_PAYLOAD, {}); // first fit at jsdom's 800x600 fallback size
    flushSettleChunks();

    container.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 900, right: 1200, bottom: 900, toJSON() { return {}; } }) as DOMRect;
    const onViewChange = vi.fn();
    render(container, ONE_NODE_PAYLOAD, { onViewChange }); // re-render, SAME container -- not a swap
    flushSettleChunks();

    expect(onViewChange).toHaveBeenCalled();
    const fitCall = onViewChange.mock.calls[onViewChange.mock.calls.length - 1][0] as ViewCall;
    expect(fitCall.x).toBe(fitCall.fitX);
    expect(fitCall.y).toBe(fitCall.fitY);
    expect(fitCall.k).toBe(fitCall.fitK);
  });

  it("never throws when onViewChange is omitted from opts", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    expect(() => render(container, ONE_NODE_PAYLOAD, {})).not.toThrow();
    flushSettleChunks();
    expect(zoomTo(1)).toBe(true); // the 'zoom' handler's onViewChange guard doesn't throw either
  });

  // Fix review I2: onViewChange joined the opts-carry-forward set
  // (delta #28/#31's Object.assign({}, carried, opts) mechanism) so an
  // opts-omitted internal re-render (toggleNoise's own `render(rawData)`
  // tail) doesn't silently freeze Starfield.tsx on the pan/zoom state from
  // before the toggle.
  it("carries onViewChange through an opts-omitted toggleNoise() re-render", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onViewChange = vi.fn();
    toggleNoise(true);
    render(container, ONE_NODE_PAYLOAD, { onViewChange });
    flushSettleChunks();
    expect(onViewChange).toHaveBeenCalled();

    onViewChange.mockClear();
    toggleNoise(false); // internally: render(rawData) -- opts omitted entirely
    flushSettleChunks();

    // Discriminating: pre-fix, onViewChange would never fire again for this
    // mount once an opts-omitted re-render happened, since the fresh
    // zoomBehavior/'zoom' closure that internal render() built captured
    // opts WITHOUT onViewChange.
    expect(zoomTo(1)).toBe(true);
    expect(onViewChange).toHaveBeenCalled();

    toggleNoise(true); // restore for any test ordering after this one
    flushSettleChunks();
  });
});

// Graph interaction follow-ups, Batch C (decision: user, 2026-09-13; header
// comment delta #35): plain wheel pans, Ctrl/Cmd+wheel zooms. Real jsdom
// WheelEvent dispatches on the rendered <svg> -- exercises zoomBehavior's
// own `.filter()` AND the new `svg.on('wheel.pan', ...)` listener exactly as
// a browser would deliver them, not a direct function call into either.
describe("d3-graph-vendor render() wheel mapping (header comment delta #35)", () => {
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

  // 1100x850 (same choice, same rationale, as d3-graph-vendor.sc-separation.
  // test.ts's own sizeContainer callers): plenty of clamp slack for a
  // 1-node payload's tiny contentBBox, so a plain wheel's pan isn't
  // silently absorbed by the pan clamp.
  function sizeContainer(el: HTMLElement, w: number, h: number): void {
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
  }

  function rootTransform(container: HTMLElement): { x: number; y: number; k: number } {
    const root = container.querySelector(".graph-root");
    const transform = root?.getAttribute("transform") || "";
    const t = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform);
    const s = /scale\(([-\d.eE]+)\)/.exec(transform);
    return {
      x: t ? parseFloat(t[1]) : NaN,
      y: t ? parseFloat(t[2]) : NaN,
      k: s ? parseFloat(s[1]) : NaN,
    };
  }

  it("a plain wheel pans y by exactly the dispatched deltaY, x and k unchanged", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    flushSettleChunks();
    const before = rootTransform(container);

    const svgEl = container.querySelector("svg")!;
    svgEl.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 0, deltaY: 100, bubbles: true, cancelable: true }),
    );

    const after = rootTransform(container);
    // Fix review minor: exact assertions -- the 1100x850 fixture has
    // plenty of clamp slack (d3-graph-vendor.sc-separation.test.ts's own
    // rationale for that size), so the wheel.pan listener's
    // `-event.deltaY * mult / t.k` (mult=1 at deltaMode 0, t.k unchanged)
    // lands on EXACTLY -100 screen px of y-translate, not merely "some
    // change".
    expect(after.y).toBeCloseTo(before.y - 100, 6);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.k).toBeCloseTo(before.k, 6);
  });

  it("a Ctrl+wheel zooms (k changes) instead of panning", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    flushSettleChunks();
    const before = rootTransform(container);

    const svgEl = container.querySelector("svg")!;
    svgEl.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
    );

    const after = rootTransform(container);
    expect(after.k).not.toBeCloseTo(before.k);
  });

  // Fix review C2: d3-zoom's own default wheelDelta multiplies a ctrlKey
  // wheel's delta by 10 (meant for a real trackpad pinch's tiny per-tick
  // deltaY) -- unclamped, a real mouse's Ctrl+wheel notch (deltaY ~100,
  // the SAME magnitude a plain wheel pan tick delivers) zoomed ~4x
  // (2^2) in one notch. The vendor's own .wheelDelta() override caps a
  // single event's exponent to [-0.5, 0.5], bounding one notch to at most
  // ~1.41x (2^0.5). Negative deltaY (zoom IN) matches this file's own
  // existing Ctrl+wheel convention above and d3-zoom's default formula
  // (`-event.deltaY * ... * 10`, verified against the installed d3-zoom
  // source) -- a negative deltaY produces a positive wheelDelta exponent,
  // i.e. `k` increases.
  it("a single Ctrl+wheel notch zooms in by at most ~1.41x (2^0.5), not the uncapped ~4x", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    flushSettleChunks();
    const before = rootTransform(container);

    const svgEl = container.querySelector("svg")!;
    svgEl.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
    );

    const after = rootTransform(container);
    expect(after.k).toBeGreaterThan(before.k);
    expect(after.k).toBeLessThanOrEqual(before.k * 1.5);
  });

  it("a Cmd (metaKey)+wheel also zooms", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);

    render(container, ONE_NODE_PAYLOAD, {});
    flushSettleChunks();
    const before = rootTransform(container);

    const svgEl = container.querySelector("svg")!;
    svgEl.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, metaKey: true, bubbles: true, cancelable: true }),
    );

    const after = rootTransform(container);
    expect(after.k).not.toBeCloseTo(before.k);
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

  // Task V3 item 3 fix (header comment delta #28): root-caused the "tutorial
  // replays on every refresh" bug to THIS exact seam -- toggleNoise()'s own
  // re-render tail (:5936-ish, `render(rawData)`) omits `opts` BY DESIGN
  // ("re-run with whatever's already configured"), which used to silently
  // drop `onFirstPaint` from the run that actually wins the race to paint
  // -- CompendiumLoader.tsx's tryDismiss() never saw
  // window.__compendiumGraphRendered flip true, so its first-run dismiss
  // (and the seen-flag PATCH inside it) never fired. Discriminating test:
  // this FAILS on the pre-fix code (onFirstPaint called once, not twice).
  it("Task V3 item 3 fix: toggleNoise()'s opts-omitted re-render still fires onFirstPaint (the persisted signal survives losing the caller's opts object)", async () => {
    const { render, toggleNoise } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const onFirstPaint = vi.fn();
    toggleNoise(true);
    render(container, NOISE_PAYLOAD, { onFirstPaint });
    expect(onFirstPaint).toHaveBeenCalledTimes(1);

    toggleNoise(false); // internally: render(rawData) -- opts omitted
    expect(onFirstPaint).toHaveBeenCalledTimes(2);

    toggleNoise(true); // restore for any test ordering after this one
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

describe("d3-graph-vendor setFilterDim() precedence vs. selection (Task A1-3 Step 5, reversed by Task V3 item 1)", () => {
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

  it("selection wins over filter (Task V3 item 1, user ruling 2026-08-10, P1): a selection present drops the filter layer entirely, matching Dash's dispatch", async () => {
    const { render, setSelection, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    // Filter would otherwise keep page-2 visible, but a selection is
    // present (page-1) -- delta #15's union composition is REJECTED by
    // user ruling; selection wins outright and the filter layer does not
    // render at all while a selection is active.
    setFilterDim(["page-2"]);
    setSelection("node", "page-1");

    expect(circleOpacityById(container, "page-1")).toBe("1"); // selection layer
    expect(circleOpacityById(container, "page-2")).toBe("0.15"); // filter dropped, not selected
    expect(circleOpacityById(container, "page-3")).toBe("0.15"); // excluded by selection
  });

  it("selection wins regardless of call order: setSelection then setFilterDim still drops the filter layer", async () => {
    const { render, setSelection, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setSelection("node", "page-1");
    setFilterDim(["page-2"]); // applied AFTER the selection -- must still not compose

    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("0.15");
    expect(circleOpacityById(container, "page-3")).toBe("0.15");
  });

  // Coordinator-flagged (V3 fix-round, after item 1's review): the second
  // half of the ruling -- "no selection -> filter dim" -- was correct in
  // source (updateHighlighting()'s `!hasSelection` guard, delta #27) but
  // had no discriminating test of its own: every existing test here either
  // starts from no selection, or never clears one back to none while a
  // filter stays active. This is the RESTORE path: selection wins only
  // while it's actually present -- clearing it (setSelection(type, null),
  // which resets every selectedNodeId/selectedClusterId/selectedNodeIds/
  // selectedSessionId var and re-runs updateHighlighting()) must bring the
  // still-active filter-dim layer back, not leave the graph stuck at full
  // visibility from the selection-wins state that preceded it.
  it("clearing the selection while a filter is still active RESTORES the filter-dim layer (ruling's second half: selection wins only while present)", async () => {
    const { render, setSelection, setFilterDim } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, threeNodePayload(), {});

    setFilterDim(["page-2"]);
    setSelection("node", "page-1"); // selection wins -- filter dropped entirely
    expect(circleOpacityById(container, "page-1")).toBe("1");
    expect(circleOpacityById(container, "page-2")).toBe("0.15");
    expect(circleOpacityById(container, "page-3")).toBe("0.15");

    setSelection("node", null); // clear the selection -- filter is STILL active
    expect(circleOpacityById(container, "page-1")).toBe("0.15"); // no longer selected
    expect(circleOpacityById(container, "page-2")).toBe("1"); // filter-dim layer restored
    expect(circleOpacityById(container, "page-3")).toBe("0.15");
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

// Task V2 (vision-review F5): knot expand loses its frame on Next. Root
// cause (task-V2-report.md has the full instrumentation writeup): Dash's
// own toggleGroupExpansion calls render() SYNCHRONOUSLY, so by the time it
// calls frameWorldBBox, render()'s own preserveView restore already ran and
// the frame is the last word. Task group W's async worker relayout broke
// that ordering -- render() only kicks off the worker and returns
// immediately, so the OLD code's synchronous frameWorldBBox call (a) read a
// stale, pre-relayout bbox and (b) started a transition the settle-end
// preserveView restore (finishRenderAfterSettle, running seconds later once
// the worker actually finishes) unconditionally overwrote. The fix hands
// the group id to render() as `frameGroupId`, applied by
// finishRenderAfterSettle AFTER its own preserveView restore -- same net
// order as Dash, triggered by the worker's `end` instead of render()
// returning.
describe("d3-graph-vendor toggleGroupExpansion() frame (Task V2, vision-review F5)", () => {
  const GROUP_ID = 42;

  // One plain solo cluster (keeps the overall fit-to-content bbox large)
  // plus one casual/binge group cluster (page_ids tight enough that
  // frameWorldBBox's clamp -- the SAME {minRatio:1.6, maxRatio:2.6} call
  // toggleGroupExpansion has always used -- pins the framed scale well
  // above the plain fit scale). Fresh object graph per call: render()
  // mutates node.x/y in place, and this file's existing payload factories
  // (e.g. threeNodePayload above) follow the same per-call-fresh pattern
  // to avoid cross-test contamination.
  function twoClusterGroupPayload(): GraphPayload {
    function member(id: string, parent: string): GraphPayload["nodes"][number] {
      return {
        id,
        label: id,
        level: 0,
        kind: "cluster",
        visit_count: 1,
        parent_id: parent,
        children_ids: [],
        capture_ids: [],
        page_urls: ["https://example.com/" + id],
        first_visited_at: null,
      };
    }
    return {
      nodes: [member("page-1", "solo"), member("page-2", "grp"), member("page-3", "grp")],
      links: [],
      clusters: [
        { id: "solo", name: "Solo Cluster", page_ids: ["page-1"] },
        {
          id: "grp",
          name: "Group Cluster",
          page_ids: ["page-2", "page-3"],
          group_id: GROUP_ID,
          group_tier: "casual",
          group_label: "Test Group",
        },
      ],
      super_clusters: [],
      groups: [],
    };
  }

  function graphRootTransform(container: HTMLElement): string | null {
    return container.querySelector("svg g.graph-root")?.getAttribute("transform") ?? null;
  }
  function parseScale(transform: string | null): number {
    const m = transform?.match(/scale\(([^)]+)\)/);
    return m ? parseFloat(m[1]) : NaN;
  }
  function clickCaption(container: HTMLElement, label: string): void {
    const groups = Array.from(container.querySelectorAll("g.group-label-group"));
    const target = groups.find((g) => g.querySelector("text")?.textContent?.includes(label));
    if (!target) throw new Error("caption not found for label: " + label);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  beforeEach(() => {
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    (
      SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }
    ).getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
    // expandedGroups is a module-level singleton (same shared-state class
    // as selection/filter above) -- reset the one group id these tests use
    // so a previous test's expand/collapse doesn't leak into this one.
    const w = window as unknown as { __d3ExpandedGroups?: Record<number, boolean> };
    if (w.__d3ExpandedGroups) delete w.__d3ExpandedGroups[GROUP_ID];
  });

  afterEach(() => {
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown })
      .getScreenCTM;
  });

  it("expand -> settle -> frames the expanded group instead of restoring the pre-click transform", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, twoClusterGroupPayload(), {});
    // Mount's own settle-tail (chunks 2/3, incl. the FIRST fitToContent)
    // is rAF-deferred -- drain it so .graph-root carries its baseline
    // fit-to-content transform before this test reads it.
    flushSettleChunks();

    const baselineTransform = graphRootTransform(container);
    expect(baselineTransform).toBeTruthy();
    const baselineScale = parseScale(baselineTransform);
    expect(Number.isNaN(baselineScale)).toBe(false);

    clickCaption(container, "Test Group");
    // SyncFakeSimWorker (this file's default Worker stub) runs the click's
    // render(rawData, {preserveView:true, frameGroupId}) call synchronously
    // to `end`, but finishRenderAfterSettle's own chunk 2/3 are still
    // rAF-deferred (jsdom: setTimeout(cb,16) fallback) -- drain them so the
    // frame (chunk 3) has actually run before asserting.
    flushSettleChunks();

    // frameWorldBBox itself applies via `svg.transition().duration(500)`
    // (unchanged by this fix -- same call toggleGroupExpansion always
    // made), which schedules real, ANIMATED interpolation through d3's own
    // timer queue -- a completely separate scheduling system from the
    // vendor's __rafSchedule/scheduleSettleChunk that flushSettleChunks()
    // drains above, so it needs real elapsed wall-clock time (this file
    // never stubs timers) rather than another synchronous flush. Confirmed
    // empirically: reading immediately after flushSettleChunks() (no wait)
    // sees the transition still parked at its start value -- indistinguishable
    // from the pre-fix bug's own byte-identical restore, which is exactly
    // why this wait is load-bearing, not padding.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const afterTransform = graphRootTransform(container);
    // Pre-fix: settle-end unconditionally restored ctx.prevTransform, so
    // afterTransform === baselineTransform (the F5 bug, byte-for-byte --
    // verified against the pre-fix code, see task-V2-report.md). Post-fix:
    // the frame is the last word, and its {minRatio:1.6, maxRatio:2.6}
    // clamp (unchanged from the removed synchronous call site) puts a group
    // this tight relative to the solo cluster's much larger fit bbox well
    // above the plain fit scale.
    expect(afterTransform).not.toBe(baselineTransform);
    const afterScale = parseScale(afterTransform);
    expect(afterScale).toBeGreaterThan(baselineScale * 1.5);
  });

  it("collapse never re-frames -- the camera stays exactly where the expand click's own settle left it (Dash parity)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, twoClusterGroupPayload(), {});
    flushSettleChunks();

    clickCaption(container, "Test Group"); // expand
    flushSettleChunks();
    // Let the expand's frameWorldBBox transition (real d3 timer, not the
    // vendor's own rAF fallback flushSettleChunks() drains -- see the
    // sibling "expand -> settle" test's own comment) actually finish
    // before capturing "where the frame left the camera" and clicking
    // collapse -- otherwise this test would only prove collapse leaves an
    // UN-transitioned transform alone, which is true but not what "Dash
    // parity" actually means here.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const framedTransform = graphRootTransform(container);
    expect(framedTransform).toBeTruthy();

    clickCaption(container, "Test Group"); // collapse (same caption, now "▾ ...")
    flushSettleChunks();

    const afterCollapseTransform = graphRootTransform(container);
    // toggleGroupExpansion only ever sets frameGroupId when `expanding` is
    // true -- a collapse's settle-end restores ctx.prevTransform (the
    // transform captured right when the collapse click fired, i.e. the
    // framed view) and applies no frame on top of it, exactly like Dash's
    // own "collapsing never moves the camera" contract (vendor R4.3
    // comment).
    expect(afterCollapseTransform).toBe(framedTransform);
  });

  // Task group W fix round 1 established the dispose-mid-settle contract
  // (the "unmount mid-settle" test above) for the plain preserveView
  // restore; this closes the SAME gap for the frame this task adds. Uses
  // ManualStepSimWorker (not SyncFakeSimWorker, which always completes a
  // run in one synchronous call) to genuinely pause the expand's run
  // between ticks before disposing.
  it("dispose() mid-expand-settle applies no late frame (no restore either -- the DOM is untouched past whatever was last painted)", async () => {
    vi.stubGlobal("Worker", ManualStepSimWorker);
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);

    const dispose = render(container, twoClusterGroupPayload(), {});
    const mountWorker = ManualStepSimWorker.lastInstance!;
    expect(mountWorker).toBeTruthy();
    // Drive the mount's own run fully to `end` and flush its settle tail
    // so there's a real, painted baseline transform to compare against.
    for (let i = 0; i < 200; i++) mountWorker.step();
    flushSettleChunks();
    const baselineTransform = graphRootTransform(container);
    expect(baselineTransform).toBeTruthy();

    // Expand click -- starts a NEW run (createWorkerSim.start() always
    // tears down the prior worker and constructs a fresh one, see
    // lib/graph/useWorkerSim.ts's own attachWorker).
    clickCaption(container, "Test Group");
    const expandWorker = ManualStepSimWorker.lastInstance!;
    expect(expandWorker).not.toBe(mountWorker);

    // Phase 2 always runs a FIXED 150 ticks per cluster regardless of
    // member count (sim-layout.ts's own header comment) -- a handful of
    // manual steps is reliably still mid-settle, not a race.
    for (let i = 0; i < 5; i++) expandWorker.step();

    dispose();

    // Simulate the worker "still trying" to deliver more messages after
    // dispose() -- including driving it all the way to a hypothetical
    // `end` -- exercising both createWorkerSim's client-side suppression
    // AND the vendor's own __simRunCtx null-out.
    for (let i = 0; i < 200; i++) expandWorker.step();
    flushSettleChunks();

    const afterTransform = graphRootTransform(container);
    // No restore AND no frame -- dispose() deliberately does not touch the
    // DOM (vendor comment on the dispose() function itself), so whatever
    // was last painted (the mount's baseline fit) simply stays.
    expect(afterTransform).toBe(baselineTransform);
    // Belt-and-suspenders: the expanded group's caption text never even
    // flipped to "▾" (chunk 1's drawGroupLabels never ran for this
    // disposed run either -- same "reached a live end" gate as chunk 3).
    const captionTexts = Array.from(container.querySelectorAll("g.group-label-group text")).map(
      (t) => t.textContent,
    );
    expect(captionTexts.some((t) => t?.startsWith("▾"))).toBe(false);
  });
});
