import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload } from "@/lib/types";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";

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
});
