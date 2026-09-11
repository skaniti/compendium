import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { plateFootprintAtRatio, plateRect, rectsOverlap } from "@/lib/graph/sc-separation";

// Delta #32 (vendor header comment) -- exercises the REAL vendor render()
// pipeline in jsdom, same overall strategy as
// d3-graph-vendor.watermark-glide.test.ts (see that file's own header
// comment for the getScreenCTM/getBBox stub rationale). Here the getBBox
// stub returns a TINY box so the R6 resolver (drawWatermarks) never finds
// an overlap to resolve on its own -- isolating applyScLayoutSeparation's
// post-settle correction pass as the thing under test.
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_scriptURL?: unknown, _options?: unknown) {}
  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return;
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

// Same drain helper as d3-graph-vendor.watermark-glide.test.ts -- synchronously
// fast-forwards finishRenderAfterSettle's chunked tail (colors+hulls,
// nebula+watermarks, fit+Delaunay) instead of waiting on real/fake timers.
function flushSettleChunks(): void {
  const w = window as unknown as { __d3FlushSettleChunk?: () => boolean };
  for (let i = 0; i < 10 && w.__d3FlushSettleChunk?.(); i++) {
    // keep draining until nothing is left pending
  }
}

// Review fix (Task 5 follow-up): off by default -- gates whether
// installTinyGeometryStubs' getScreenCTM stub also answers for
// `.graph-root` (a REAL, scale-aware CTM parsed from its own "translate(x,y)
// scale(k)" transform) instead of falling through to jsdom's real (absent)
// behavior. Every test except the clamp test below relies on
// clampPlateCenterToViewport hitting its documented "DOM cannot be
// measured" fallback, matching real unstubbed jsdom; only that one test
// flips this on, and afterEach always clears it so it can't leak.
let __ctmGraphRootEnabled = false;

function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix | null }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix | null {
    // Scoped to g.watermark (identified by data-sc) -- the only elements
    // screenBBoxOf (R6 resolver) ever calls this on in this test file --
    // plus, when __ctmGraphRootEnabled is set, .graph-root itself (the only
    // other element clampPlateCenterToViewport ever calls this on). Real
    // jsdom has no getScreenCTM at all (verified: undefined, not merely
    // throwing); every other element stays unstubbed.
    const isWatermark = this.getAttribute("data-sc") != null;
    const isGraphRoot = __ctmGraphRootEnabled && this.classList.contains("graph-root");
    if (!isWatermark && !isGraphRoot) return null;
    const transform = this.getAttribute("transform") || "";
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform);
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    if (isGraphRoot) {
      // .graph-root's transform carries the d3-zoom SCALE
      // ("translate(x,y) scale(k)") -- unlike a g.watermark's bare
      // translate, this one needs the real k for the clamp test to exercise
      // genuine screen-space arithmetic.
      const s = /scale\(([-\d.eE]+)\)/.exec(transform);
      const k = s ? parseFloat(s[1]) : 1;
      return { a: k, b: 0, c: 0, d: k, e: tx, f: ty } as DOMMatrix;
    }
    return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty } as DOMMatrix;
  };
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (this: Element): DOMRect {
    if (this.getAttribute("data-sc")) {
      return { x: 0, y: 0, width: 1, height: 1 } as DOMRect;
    }
    // Matches real (unstubbed) jsdom: every other caller of getBBox in the
    // vendor wraps this in its own try/catch and degrades gracefully.
    throw new Error("getBBox not stubbed for this element (test scope)");
  };
}

function uninstallTinyGeometryStubs(): void {
  delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
  delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
}

function watermarkTransform(container: HTMLElement, keyword: string): string | null {
  const el = Array.from(container.querySelectorAll("g.watermark")).find(
    (n) => n.getAttribute("data-sc") === keyword,
  );
  return el ? el.getAttribute("transform") : null;
}

function parseTranslate(transform: string | null): { x: number; y: number } {
  const m = transform ? /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform) : null;
  return { x: m ? parseFloat(m[1]) : NaN, y: m ? parseFloat(m[2]) : NaN };
}

/** N single-cluster superclusters, each with `pagesPer` pages, names long
 *  enough to wrap to 2-3 lines, so their floor footprints overlap when the
 *  tiny sim packs them close. */
function crowdedPayload(prefix: string, n: number, pagesPer: number): GraphPayload {
  const nodes: GraphNode[] = [];
  const clusters: GraphCluster[] = [];
  const superClusters: GraphSuperCluster[] = [];
  for (let i = 0; i < n; i++) {
    const kw = `${prefix}-sc${i} extremely long supercluster name`;
    const cid = `${prefix}-c${i}`;
    const ids: string[] = [];
    for (let p = 0; p < pagesPer; p++) {
      const id = `${prefix}-p${i}-${p}`;
      ids.push(id);
      nodes.push({ id, label: id, level: 0, kind: "cluster", visit_count: 1, parent_id: cid,
        children_ids: [], capture_ids: [], page_urls: [`https://example.com/${id}`], first_visited_at: null });
    }
    clusters.push({ id: cid, name: `Cluster ${i}`, page_ids: ids, super_cluster: kw });
    superClusters.push({ keyword: kw, icon_id: `icon-${prefix}` });
  }
  return { nodes, links: [], clusters, super_clusters: superClusters, groups: [] };
}
function iconsFor(prefix: string): Record<string, IconEntry> {
  return { [`icon-${prefix}`]: { label: "T", category: "T", viewBox: "0 0 24 24", paths: ["M0 0 L1 1"] } };
}
/** jsdom's getBoundingClientRect is all zeros and render() falls back to
 *  800x600 (vendor ~:4890). Force a SMALL canvas so several long-named plates
 *  cannot all fit at the floor without the correction pass moving something
 *  or flagging overflow. */
function sizeContainer(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
}
type Report = Array<{ keyword: string; pages: number; shiftPx: number; budgetPx: number; overflow: boolean; kExile: number }>;
type W = Window & { __d3ScLayoutReport?: () => Report | null; __d3SetScSeparationOptions?: (o: { budgetRatio?: number }) => void; __d3ZoomTo?: (k: number) => boolean; __d3GetZoomScaleExtent?: () => [number, number] };

describe("d3-graph-vendor SC layout separation (delta #32)", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    installTinyGeometryStubs();
    // Task 5 addition: "requestAnimationFrame" joins the fake set. jsdom (this
    // project's vitest environment) DOES define a real requestAnimationFrame
    // (unlike getScreenCTM/getBBox, which are simply absent) -- but it is
    // wired to genuine wall-clock time, independent of vi's fake setTimeout,
    // so __wmRafSchedule's rAF branch (delta #29, drawWatermarks) never fires
    // deterministically under `advanceTimersByTimeAsync` without this. The
    // existing Task 3 tests never exercise that continuation (no zoom, no
    // exile) so adding it here is a no-op for them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame"] });
  });
  afterEach(() => {
    flushSettleChunks();
    (window as W).__d3SetScSeparationOptions?.({ budgetRatio: 0.5 });
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
    __ctmGraphRootEnabled = false;
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("separates anchored plates so floor footprints are pairwise disjoint and shifts stay within budget", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // 900x700 (not the brief's illustrative 420x320): at 420x320 every
    // plate's overlap so vastly exceeds its budget that solveSeparation's
    // all-or-nothing pair rule (sc-separation.ts) marks every non-top plate
    // overflow WITHOUT applying any partial shift at all (shiftPx stays 0
    // for all four; observed and recorded in task-3-report.md) -- the OR
    // assertion below still passes on overflow alone, but the budget-bound
    // shift path and the "two anchored, pairwise disjoint" branch of the
    // assertions below go unexercised. 900x700 lands in the middle of the
    // pass's own effect range (same fixture, canvas size is the only knob
    // turned): two plates land within budget (partial shift, non-overflow)
    // and two exceed it (overflow, zero shift) -- exercising both branches.
    sizeContainer(container, 900, 700);
    document.body.appendChild(container);
    render(container, crowdedPayload("sep", 4, 6), { icons: iconsFor("sep") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport?.();
    expect(report).toBeTruthy();
    expect(report!.length).toBe(4);
    // Both branches the rest of this test exercises must actually occur:
    // at least one plate genuinely shifted within budget (not merely
    // overflowed -- an OR here would pass on overflow alone and leave the
    // budget-bound shift path unpinned), and at least one plate overflowed.
    expect(report!.some((r) => r.shiftPx > 0 && !r.overflow)).toBe(true);
    expect(report!.some((r) => r.overflow)).toBe(true);
    for (const r of report!) {
      expect(r.shiftPx).toBeLessThanOrEqual(r.budgetPx + 1e-6);
    }
    // Anchors (from the report's world positions exposed alongside) are disjoint at the floor.
    const layout = (window as unknown as { __d3ScLayout?: () => { kFloor: number; plates: Record<string, { anchor: { x: number; y: number }; overflow: boolean }>; fpParams: Parameters<typeof plateFootprintAtRatio>[2] } }).__d3ScLayout!();
    const keys = Object.keys(layout.plates).filter((k) => !layout.plates[k].overflow);
    // The pairwise-disjoint loop below is vacuous with fewer than 2
    // anchored plates -- pin that it actually has pairs to check.
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = layout.plates[keys[i]].anchor, b = layout.plates[keys[j]].anchor;
      const ra = plateRect(a.x * layout.kFloor, a.y * layout.kFloor, plateFootprintAtRatio(keys[i], 0.5, layout.fpParams));
      const rb = plateRect(b.x * layout.kFloor, b.y * layout.kFloor, plateFootprintAtRatio(keys[j], 0.5, layout.fpParams));
      expect(rectsOverlap(ra, rb)).toBe(false);
    }
  });

  it("with a zero budget every unresolved pair flags the smaller plate as overflow with a finite or infinite kExile", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 420, 320);
    document.body.appendChild(container);
    render(container, crowdedPayload("ovf", 3, 2), { icons: iconsFor("ovf") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport!()!;
    const overflow = report.filter((r) => r.overflow);
    expect(overflow.length).toBeGreaterThan(0);
    for (const o of overflow) {
      expect(o.shiftPx).toBe(0);
      expect(o.kExile).toBeGreaterThan(0); // finite k or Infinity, never 0
    }
    // The plate with the MOST pages is never overflow (priority order).
    const top = report.slice().sort((a, b) => b.pages - a.pages || (a.keyword < b.keyword ? -1 : 1))[0];
    expect(top.overflow).toBe(false);
  });

  it("is a no-op for a single supercluster", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(container, crowdedPayload("one", 1, 3), { icons: iconsFor("one") });
    flushSettleChunks();
    expect((window as W).__d3ScLayoutReport!()).toBeNull();
  });

  it("exiles an overflow plate below kExile: data-exiled, dot + leader present, leader ends on the plate rect", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 420, 320);
    document.body.appendChild(container);
    render(container, crowdedPayload("exl", 3, 2), { icons: iconsFor("exl") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport!()!;
    const victim = report.find((r) => r.overflow)!;
    expect(victim).toBeTruthy();
    // Zoom to the floor so currentZoomK < kExile for every overflow plate.
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    // The exile displacement rides the delta-#29 glide: let it converge
    // before reading transforms (requestAnimationFrame is faked in
    // beforeEach, so this deterministically drains the rAF continuation).
    await vi.advanceTimersByTimeAsync(2000);
    const g = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === victim.keyword)!;
    expect(g.getAttribute("data-exiled")).toBe("1");
    const leader = container.querySelector(`g.watermark-leader[data-sc="${victim.keyword}"]`)!;
    expect(leader).toBeTruthy();
    const dot = leader.querySelector("circle.watermark-anchor-dot")!;
    const line = leader.querySelector("line.watermark-leader-line")!;
    expect(dot).toBeTruthy(); expect(line).toBeTruthy();
    // Dot sits at the anchor; leader starts there.
    const ax = parseFloat(g.getAttribute("data-anchor-x")!), ay = parseFloat(g.getAttribute("data-anchor-y")!);
    const hw = parseFloat(g.getAttribute("data-plate-hw")!);
    const hh = parseFloat(g.getAttribute("data-plate-hh")!);
    expect(parseFloat(line.getAttribute("x1")!)).toBeCloseTo(parseFloat(dot.getAttribute("cx")!), 6);
    // The plate's transform differs from its anchor (it was moved to the periphery).
    const t = parseTranslate(g.getAttribute("transform"));
    expect(Math.hypot(t.x - ax, t.y - ay)).toBeGreaterThan(hw);
    // Item 3 (review fix): the leader's far endpoint lands ON the plate's
    // rect boundary, not merely somewhere unconstrained -- derive the rect
    // from the SAME transform + data-plate-* attrs updateLeaderEnd itself
    // reads, and require the endpoint sit on one edge while staying inside
    // the rect on the other axis (clipSegmentToRect always exits on exactly
    // one edge for a segment from outside to inside).
    const cx = t.x + parseFloat(g.getAttribute("data-plate-cx")!);
    const cy = t.y + parseFloat(g.getAttribute("data-plate-cy")!);
    const x2 = parseFloat(line.getAttribute("x2")!), y2 = parseFloat(line.getAttribute("y2")!);
    const onVerticalEdge = Math.abs(Math.abs(x2 - cx) - hw) < 1e-6;
    const onHorizontalEdge = Math.abs(Math.abs(y2 - cy) - hh) < 1e-6;
    expect(onVerticalEdge || onHorizontalEdge).toBe(true);
    if (onVerticalEdge) expect(Math.abs(y2 - cy)).toBeLessThanOrEqual(hh + 1e-6);
    if (onHorizontalEdge) expect(Math.abs(x2 - cx)).toBeLessThanOrEqual(hw + 1e-6);
    // A non-overflow plate stays at its anchor (zero displacement) after the glide settles.
    await vi.advanceTimersByTimeAsync(2000);
    const keeper = report.find((r) => !r.overflow)!;
    const gk = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === keeper.keyword)!;
    const tk = parseTranslate(gk.getAttribute("transform"));
    expect(tk.x).toBeCloseTo(parseFloat(gk.getAttribute("data-anchor-x")!), 3);
    expect(tk.y).toBeCloseTo(parseFloat(gk.getAttribute("data-anchor-y")!), 3);
  });

  it("clamps every exiled plate's footprint inside the viewport with symmetric half-sizes about its center", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 420, 320);
    document.body.appendChild(container);
    render(container, crowdedPayload("clp", 3, 2), { icons: iconsFor("clp") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport!()!;
    const overflowKeywords = report.filter((r) => r.overflow).map((r) => r.keyword);
    expect(overflowKeywords.length).toBeGreaterThan(0);
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    // Every other test in this file exercises clampPlateCenterToViewport's
    // "DOM cannot be measured" fallback (real, unstubbed jsdom has no
    // getScreenCTM at all). This test targets the clamp arithmetic itself:
    // flip on the .graph-root CTM stub and redraw at the SAME k -- d3-zoom's
    // imperative `.transform()` setter dispatches the 'zoom' event (and
    // therefore drawWatermarks) regardless of whether the value changed, so
    // this re-runs the exile pre-pass with a REAL, scale-aware CTM this
    // time.
    __ctmGraphRootEnabled = true;
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);

    // Same CTM clampPlateCenterToViewport itself used: .graph-root's own
    // "translate(tx,ty) scale(k)" transform, parsed the same way the stub
    // (and the production `ctm.a*wx + ctm.c*wy + ctm.e` mapping) does.
    const rootEl = container.querySelector(".graph-root")!;
    const rootTransform = rootEl.getAttribute("transform") || "";
    const tm = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(rootTransform)!;
    const sm = /scale\(([-\d.eE]+)\)/.exec(rootTransform);
    const rtx = parseFloat(tm[1]), rty = parseFloat(tm[2]), k = sm ? parseFloat(sm[1]) : 1;
    const crect = container.getBoundingClientRect();
    const M = 28; // SC_EXILE_VIEWPORT_MARGIN_PX

    // Every overflow SC, not just the first: the pre-fix bug was a
    // DIRECTIONAL asymmetry (fp.top and fp.bottom differ, since the label
    // extends further below the icon than the icon extends above its own
    // center) -- a plate exiled toward the BOTTOM of the viewport was
    // over-clamped (harmless), while one exiled toward the TOP could
    // overshoot past the margin. Asserting on only one keyword risks
    // picking the direction that happens not to expose the bug.
    for (const keyword of overflowKeywords) {
      const g = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === keyword)!;
      if (g.getAttribute("data-exiled") !== "1") continue; // above its own kExile at kMin -- nothing to clamp
      const t = parseTranslate(g.getAttribute("transform"));
      const plateCx = parseFloat(g.getAttribute("data-plate-cx")!), plateCy = parseFloat(g.getAttribute("data-plate-cy")!);
      const hw = parseFloat(g.getAttribute("data-plate-hw")!), hh = parseFloat(g.getAttribute("data-plate-hh")!);
      const cx = t.x + plateCx, cy = t.y + plateCy;
      const screenCx = k * cx + rtx - crect.left;
      const screenCy = k * cy + rty - crect.top;
      // data-plate-hw/hh are WORLD half-sizes (already divided by
      // currentZoomK when drawWatermarks recorded them) -- multiply back by
      // k to get the screen-space half-sizes the clamp itself reasoned in.
      const screenHw = hw * k, screenHh = hh * k;

      expect(screenCy - screenHh).toBeGreaterThanOrEqual(M - 1e-6);
      expect(screenCy + screenHh).toBeLessThanOrEqual(crect.height - M + 1e-6);
      expect(screenCx - screenHw).toBeGreaterThanOrEqual(M - 1e-6);
      expect(screenCx + screenHw).toBeLessThanOrEqual(crect.width - M + 1e-6);
    }
  });

  it("returns an exiled plate to its anchor above kExile and removes its leader", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 420, 320);
    document.body.appendChild(container);
    render(container, crowdedPayload("ret", 3, 2), { icons: iconsFor("ret") });
    flushSettleChunks();
    const victim = (window as W).__d3ScLayoutReport!()!.find((r) => r.overflow && isFinite(r.kExile));
    if (!victim) return; // Infinity kExile means always exiled; nothing to assert for this fixture
    // __d3ZoomTo applies the transform directly with no scaleExtent clamp --
    // clamp to the extent's max here so the transform stays in range (Task 3
    // review carry-over).
    const [, kMax] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(Math.min(victim.kExile * 1.05, kMax))).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    const g = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === victim.keyword)!;
    expect(g.getAttribute("data-exiled")).toBeNull();
    expect(container.querySelector(`g.watermark-leader[data-sc="${victim.keyword}"]`)).toBeNull();
    const t = parseTranslate(g.getAttribute("transform"));
    expect(t.x).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-x")!), 3);
    expect(t.y).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-y")!), 3);
  });
});
