import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { plateFootprintAtRatio, plateRect, rectsOverlap, segmentsCross } from "@/lib/graph/sc-separation";

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
// placeExiledPlates' radial clamp (env.viewport) hitting its documented
// "DOM cannot be measured" fallback -- env.viewport stays unset and the
// clamp never runs -- matching real unstubbed jsdom; only that one test
// flips this on, and afterEach always clears it so it can't leak.
let __ctmGraphRootEnabled = false;

function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix | null }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix | null {
    // Scoped to g.watermark (identified by data-sc) -- the only elements
    // screenBBoxOf (R6 resolver) ever calls this on in this test file --
    // plus, when __ctmGraphRootEnabled is set, .graph-root itself (the only
    // other element the drawWatermarks exile pre-pass calls this on, to
    // build placeExiledPlates' env.viewport for its radial clamp). Real
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
type Layout = { kFit: number; kFloor: number; cloudBBox: { minX: number; minY: number; maxX: number; maxY: number }; contentBBox: { minX: number; minY: number; maxX: number; maxY: number }; fitBBox: { minX: number; minY: number; maxX: number; maxY: number }; plates: Record<string, { anchor: { x: number; y: number } | null; shiftPx: number; budgetPx: number; overflow: boolean; kExile: number }>; fpParams: Parameters<typeof plateFootprintAtRatio>[2]; report: Report };
type ExileClampMode = "periphery" | "viewport";
type SeparationOptions = {
  budgetRatio?: number;
  budgetMinPx?: number;
  exileClampMode?: ExileClampMode;
  exileMarginPx?: number;
};
type W = Window & {
  __d3ScLayoutReport?: () => Report | null;
  __d3ScLayout?: () => Layout | null;
  __d3ScLayoutRemeasure?: (w: number, h: number) => Layout | null;
  __d3SetScSeparationOptions?: (o: SeparationOptions) => void;
  __d3GetScSeparationOptions?: () => Required<SeparationOptions>;
  __d3ZoomTo?: (k: number) => boolean;
  __d3GetZoomScaleExtent?: () => [number, number];
};

// Final fix wave (item 2): the module defaults, captured ONCE here rather
// than re-hardcoded at every afterEach restore -- SC_SEPARATION_BUDGET_RATIO
// / SC_SEPARATION_BUDGET_MIN_PX in the vendor.
const DEFAULT_SC_SEPARATION_BUDGET_RATIO = 0.5;
const DEFAULT_SC_SEPARATION_BUDGET_MIN_PX = 60;
// Followups item 3: same idea for the exile-clamp knobs -- SC_EXILE_CLAMP_MODE
// / SC_EXILE_MARGIN_PX in the vendor.
const DEFAULT_SC_EXILE_CLAMP_MODE: ExileClampMode = "periphery";
const DEFAULT_SC_EXILE_MARGIN_PX = 16;

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
    (window as W).__d3SetScSeparationOptions?.({
      budgetRatio: DEFAULT_SC_SEPARATION_BUDGET_RATIO,
      budgetMinPx: DEFAULT_SC_SEPARATION_BUDGET_MIN_PX,
      exileClampMode: DEFAULT_SC_EXILE_CLAMP_MODE,
      exileMarginPx: DEFAULT_SC_EXILE_MARGIN_PX,
    });
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
    __ctmGraphRootEnabled = false;
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("separates anchored plates so floor footprints are pairwise disjoint and shifts stay within budget", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // 1100x850 (not the brief's illustrative 420x320, and not this test's
    // prior 900x700): at 420x320 every plate's overlap so vastly exceeds
    // its budget that solveSeparation's all-or-nothing pair rule
    // (sc-separation.ts) marks every non-top plate overflow WITHOUT
    // applying any partial shift at all (shiftPx stays 0 for all four,
    // observed and recorded in task-3-report.md) -- the OR assertion below
    // still passes on overflow alone, but the budget-bound shift path and
    // the "two anchored, pairwise disjoint" branch go unexercised. 900x700
    // moved (2026-09-13, fit-includes-exiles fix): at that size sc3's
    // floor-level kExile already sits above kFit, so remeasureScLayout's
    // new fixed-point loop (d3-graph-vendor.js) grows the fit bbox to
    // include it -- shrinking kFit/kFloor enough to cascade two MORE
    // plates into overflow (verified: only 1 of 4 stays anchored), which
    // starves the pairwise-disjoint branch this test exists to exercise.
    // 1100x850 keeps every plate's kExile below kFit (no plate is exiled
    // AT FIT), so the new loop is a no-op here and the original two-plates-
    // shift / two-plates-overflow split is preserved; the fit-inclusion
    // loop itself is exercised by the dedicated tests below instead.
    sizeContainer(container, 1100, 850);
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
    const layout = (window as W).__d3ScLayout!()!;
    // Review Minor 3(b): checked precondition -- 1100x850 was chosen
    // specifically so nothing here is exiled AT FIT (the fit-inclusion loop
    // is a no-op), which is what makes the rest of this test's floor-only
    // assertions meaningful in isolation from that loop.
    expect(layout.report.every((r) => !(r.overflow && r.kExile > layout.kFit))).toBe(true);
    const keys = Object.keys(layout.plates).filter((k) => !layout.plates[k].overflow);
    // The pairwise-disjoint loop below is vacuous with fewer than 2
    // anchored plates -- pin that it actually has pairs to check.
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = layout.plates[keys[i]].anchor!, b = layout.plates[keys[j]].anchor!;
      const ra = plateRect(a.x * layout.kFloor, a.y * layout.kFloor, plateFootprintAtRatio(keys[i], 0.5, layout.fpParams));
      const rb = plateRect(b.x * layout.kFloor, b.y * layout.kFloor, plateFootprintAtRatio(keys[j], 0.5, layout.fpParams));
      expect(rectsOverlap(ra, rb)).toBe(false);
    }
  });

  it("__d3ScLayoutRemeasure re-derives kFloor and exile onsets for a new canvas size without moving nodes (resize path)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // 3600x2800 (not this test's prior 900x700): 2026-09-13 fit-includes-
    // exiles fix -- remeasureScLayout's fixed-point loop recomputes
    // kFit/kFloor from a fitBBox that grows to include any plate exiled AT
    // fit, so a canvas size where that loop actually engages breaks the
    // clean "halving the canvas exactly halves kFit" arithmetic this test
    // exists to pin (verified: at 900x700 -> 450x350 kFloor lands at ~14%
    // of before.kFloor, not 50%). 3600x2800 keeps every plate's kExile
    // below kFit at BOTH this size and its half (1800x1400) -- the loop is
    // a no-op at both, so the linear-scaling arithmetic holds exactly, and
    // halving alone (unrelated to the new loop) still pushes one plate
    // into overflow, preserving this test's original intent. The
    // fit-inclusion loop itself is exercised by the dedicated tests below.
    sizeContainer(container, 3600, 2800);
    document.body.appendChild(container);
    render(container, crowdedPayload("rsz", 4, 6), { icons: iconsFor("rsz") });
    flushSettleChunks();
    const before = (window as W).__d3ScLayout!()!;
    expect(before).toBeTruthy();

    // Halving BOTH canvas dimensions halves kFit (and therefore kFloor)
    // exactly -- the fit scale is a min() of two ratios that both scale by
    // the same factor -- without moving a single node (remeasureScLayout is
    // node-immutable; contrast with applyScLayoutSeparation's own movement
    // phase, which never runs here).
    const half = (window as W).__d3ScLayoutRemeasure!(1800, 1400)!;
    expect(half).toBeTruthy();
    expect(half.kFloor).toBeCloseTo(before.kFloor * 0.5, 9);
    // Review Minor 3(d): kFit itself (not just kFloor) halves exactly.
    expect(Math.abs(half.kFit - before.kFit * 0.5)).toBeLessThan(1e-9);
    // Review Minor 3(a): fitBBox is the node-only content bbox at both
    // sizes (the fit-inclusion loop is a no-op here, by design -- see the
    // comment above) -- it must be IDENTICAL at both canvas sizes, since it
    // depends only on unmoved node positions, never on canvasW/canvasH.
    // Without this, "halving the canvas exactly halves kFit" would hold by
    // coincidence rather than because the two measurements are actually
    // comparing the same content.
    expect(half.fitBBox).toEqual(before.fitBBox);
    // A smaller canvas packs the SAME anchors (unmoved) into a SMALLER
    // screen area while footprints (sized off a fixed ratio, not kFloor)
    // stay the same screen size -- overlap can only get worse, so the
    // settle-time overflow set persists or grows (at this size it grows
    // from empty at "before" to one plate at "half").
    const halfOverflow = Object.keys(half.plates).filter((k) => half.plates[k].overflow);
    expect(halfOverflow.length).toBeGreaterThan(0);
    for (const kw of halfOverflow) {
      expect(half.plates[kw].kExile).toBeGreaterThan(half.kFloor * 1.0001);
    }

    // Idempotence: remeasuring back at the ORIGINAL canvas size reproduces
    // the settle-time record exactly (deterministic given unmoved nodes).
    const restored = (window as W).__d3ScLayoutRemeasure!(3600, 2800)!;
    expect(restored.kFloor).toBeCloseTo(before.kFloor, 9);
    const beforeOverflow = Object.keys(before.plates).filter((k) => before.plates[k].overflow).sort();
    const restoredOverflow = Object.keys(restored.plates).filter((k) => restored.plates[k].overflow).sort();
    expect(restoredOverflow).toEqual(beforeOverflow);
    for (const kw of Object.keys(before.plates)) {
      const b = before.plates[kw].kExile, r = restored.plates[kw].kExile;
      if (!isFinite(b) && !isFinite(r)) continue; // both Infinity: never resolves at either canvas size
      expect(r).toBeCloseTo(b, 6);
    }
  });

  it("with a zero budget every unresolved pair flags the smaller plate as overflow with a finite or infinite kExile", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
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
    // Task 7: an overflow plate overlaps SOMEONE at the floor by definition, so
    // its exile onset must sit strictly above the floor -- a floor-level kExile
    // means it never exiles and falls back to the old push-apart slide.
    const kFloor = (window as unknown as { __d3ScLayout: () => { kFloor: number } }).__d3ScLayout().kFloor;
    for (const o of overflow) expect(o.kExile).toBeGreaterThan(kFloor * 1.0001);
  });

  it("exiled plates yield to anchored plates in the resolver: an anchored plate never moves off its anchor at rest", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 420, 320);
    document.body.appendChild(container);
    render(container, crowdedPayload("yld", 4, 2), { icons: iconsFor("yld") });
    flushSettleChunks();
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    for (const g of Array.from(container.querySelectorAll("g.watermark"))) {
      if (g.getAttribute("data-exiled") === "1") continue;
      const t = parseTranslate(g.getAttribute("transform"));
      expect(t.x).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-x")!), 3);
      expect(t.y).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-y")!), 3);
    }
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
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
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
    // Task 8: no two rendered leaders (anchor -> clipped plate edge) cross.
    const leaderLines = Array.from(container.querySelectorAll("g.watermark-leader line.watermark-leader-line")).map((el) => ({
      x1: parseFloat(el.getAttribute("x1")!), y1: parseFloat(el.getAttribute("y1")!),
      x2: parseFloat(el.getAttribute("x2")!), y2: parseFloat(el.getAttribute("y2")!),
    }));
    for (let i = 0; i < leaderLines.length; i++) for (let j = i + 1; j < leaderLines.length; j++) {
      const a = leaderLines[i], b = leaderLines[j];
      expect(segmentsCross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)).toBe(false);
    }
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
    // Followups item 3: this is the 'viewport' clamp mode specifically --
    // the module default is now 'periphery' (no clamp), so opt into the
    // shipped-2026-09-11 radial clamp explicitly.
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0, exileClampMode: "viewport" });
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
    // Every other test in this file exercises placeExiledPlates' radial
    // clamp (env.viewport) "DOM cannot be measured" fallback -- env.viewport
    // stays unset so the clamp never runs (real, unstubbed jsdom has no
    // getScreenCTM at all). This test targets the clamp arithmetic itself:
    // flip on the .graph-root CTM stub and redraw at the SAME k -- d3-zoom's
    // imperative `.transform()` setter dispatches the 'zoom' event (and
    // therefore drawWatermarks) regardless of whether the value changed, so
    // this re-runs the exile pre-pass with a REAL, scale-aware CTM this
    // time.
    __ctmGraphRootEnabled = true;
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);

    // Same CTM the drawWatermarks exile pre-pass itself reads to build
    // placeExiledPlates' env.viewport: .graph-root's own "translate(tx,ty)
    // scale(k)" transform, parsed the same way the stub (and the production
    // `ctm.a*wx + ctm.c*wy + ctm.e` mapping) does.
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

  it("in the default periphery mode, an exiled plate stays off the cloud and may leave the viewport (no clamp)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    // 260x200: smaller than the 420x320 the 'viewport' clamp test above
    // uses. At 420x320 the periphery placement (this fixture, this margin)
    // never actually leaves the container -- the cloud's own screen extent
    // at that fit scale still comfortably contains the ring point. Shrunk
    // until at least one exiled plate's screen rect crosses an edge
    // (verified empirically): 260x200 does it for this 3-SC/2-page fixture.
    sizeContainer(container, 260, 200);
    document.body.appendChild(container);
    render(container, crowdedPayload("per", 3, 2), { icons: iconsFor("per") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport!()!;
    const overflowKeywords = report.filter((r) => r.overflow).map((r) => r.keyword);
    expect(overflowKeywords.length).toBeGreaterThan(0);
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    // Same gated .graph-root CTM stub as the 'viewport' clamp test above --
    // a real, scale-aware CTM is on, so a viewport clamp WOULD engage here
    // if exileClampMode were 'viewport'. Left at its module default
    // ('periphery') this test asserts no clamp happens.
    __ctmGraphRootEnabled = true;
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);

    expect((window as W).__d3GetScSeparationOptions!().exileClampMode).toBe("periphery");

    const rootEl = container.querySelector(".graph-root")!;
    const rootTransform = rootEl.getAttribute("transform") || "";
    const tm = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(rootTransform)!;
    const sm = /scale\(([-\d.eE]+)\)/.exec(rootTransform);
    const rtx = parseFloat(tm[1]), rty = parseFloat(tm[2]), k = sm ? parseFloat(sm[1]) : 1;
    const crect = container.getBoundingClientRect();
    const layout = (window as W).__d3ScLayout!()!;

    let anyBeyondContainer = false;
    let exiledCount = 0;
    for (const keyword of overflowKeywords) {
      const g = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === keyword)!;
      if (g.getAttribute("data-exiled") !== "1") continue; // above its own kExile at kMin -- nothing exiled to check
      exiledCount++;
      const t = parseTranslate(g.getAttribute("transform"));
      const plateCx = parseFloat(g.getAttribute("data-plate-cx")!), plateCy = parseFloat(g.getAttribute("data-plate-cy")!);
      const hw = parseFloat(g.getAttribute("data-plate-hw")!), hh = parseFloat(g.getAttribute("data-plate-hh")!);
      // World-space footprint center + half-sizes (data-plate-hw/hh are
      // already world units, unlike the 'viewport' clamp test's screen-space
      // comparison) -- cloudBBox is in the SAME world space, so this checks
      // the plate rect against it directly, no CTM involved.
      const cx = t.x + plateCx, cy = t.y + plateCy;
      const plateRectWorld = { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
      expect(rectsOverlap(plateRectWorld, layout.cloudBBox)).toBe(false);

      // Screen-space rect (same conversion the 'viewport' clamp test uses)
      // to check whether this plate's footprint crosses the container edge.
      const screenCx = k * cx + rtx - crect.left;
      const screenCy = k * cy + rty - crect.top;
      const screenHw = hw * k, screenHh = hh * k;
      const beyond = screenCx - screenHw < 0 || screenCx + screenHw > crect.width ||
        screenCy - screenHh < 0 || screenCy + screenHh > crect.height;
      if (beyond) anyBeyondContainer = true;
    }
    expect(exiledCount).toBeGreaterThan(0);
    expect(anyBeyondContainer).toBe(true);
  });

  it("returns an exiled plate to its anchor above kExile and removes its leader", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    // 1200x920 (not the brief's illustrative 420x320): at 420x320 this
    // fixture's zero budget forces such extreme floor overlap that BOTH
    // overflow plates' kExile search (computeExileRatio, sc-separation.ts)
    // never finds clearance within its rMax=4 bound -- every candidate this
    // test needs (`isFinite(r.kExile)`) is Infinity (verified empirically).
    // 1200x920 keeps two plates overflow with a FINITE kExile, both still
    // below kFit (nothing is exiled AT FIT here, so the 2026-09-13
    // fit-includes-exiles loop is a no-op) -- the "zoom just above kExile
    // returns it to anchor" behavior this test targets.
    sizeContainer(container, 1200, 920);
    document.body.appendChild(container);
    render(container, crowdedPayload("ret", 3, 2), { icons: iconsFor("ret") });
    flushSettleChunks();
    const victim = (window as W).__d3ScLayoutReport!()!.find((r) => r.overflow && isFinite(r.kExile))!;
    expect(victim).toBeTruthy();
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

  // 2026-09-13 fit-includes-exiles fix (user report: at 50%/floor zoom
  // exiled nameplates are cut off at the viewport edge, and at 100%/"fit"
  // they are outside the view -- 100% must always equal zoom-to-fit
  // INCLUDING the exiled labels, plus a small margin; since the floor is
  // 0.5x fit, fixing fit fixes the floor).
  it("fit includes every plate exiled at fit, plus a small margin", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    // 800x620, 2 SCs (crowdedPayload("cvg", 2, 4)): zero budget forces the
    // lower-priority SC (cvg-sc1 -- same page count as cvg-sc0, so priority
    // ties break by key, sc0 < sc1) into overflow with a floor-level
    // kExile (~1.15) comfortably ABOVE kFit (~0.45) at this canvas size --
    // i.e. genuinely exiled AT FIT (100% zoom), the exact pre-fix bug: with
    // the old single-pass computeFitBBox, fitToContent had no idea this
    // plate would be drawn off in the periphery and framed only the
    // content, cropping it at 100% (and therefore at the 0.5x floor too).
    sizeContainer(container, 800, 620);
    document.body.appendChild(container);
    render(container, crowdedPayload("cvg", 2, 4), { icons: iconsFor("cvg") });
    flushSettleChunks();
    const layout = (window as W).__d3ScLayout!()!;
    expect(layout.fitBBox).toBeTruthy();

    // fitBBox contains cloudBBox (the unpadded content bbox, ring perimeter
    // for exile placement).
    expect(layout.fitBBox.minX).toBeLessThanOrEqual(layout.cloudBBox.minX);
    expect(layout.fitBBox.minY).toBeLessThanOrEqual(layout.cloudBBox.minY);
    expect(layout.fitBBox.maxX).toBeGreaterThanOrEqual(layout.cloudBBox.maxX);
    expect(layout.fitBBox.maxY).toBeGreaterThanOrEqual(layout.cloudBBox.maxY);

    const exiledAtFit = layout.report.filter((r) => r.overflow && r.kExile > layout.kFit);
    expect(exiledAtFit.length).toBeGreaterThan(0);
    for (const r of exiledAtFit) {
      // render() draws at fit by default (currentZoomK === fitZoom, ratio
      // 1.0) -- no zoom needed to observe the exile placement fitToContent
      // must already account for.
      const g = Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === r.keyword)!;
      expect(g.getAttribute("data-exiled")).toBe("1");
      const t = parseTranslate(g.getAttribute("transform"));
      const plateCx = parseFloat(g.getAttribute("data-plate-cx")!), plateCy = parseFloat(g.getAttribute("data-plate-cy")!);
      const hw = parseFloat(g.getAttribute("data-plate-hw")!), hh = parseFloat(g.getAttribute("data-plate-hh")!);
      const cx = t.x + plateCx, cy = t.y + plateCy;
      const rect = { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
      expect(rect.minX).toBeGreaterThanOrEqual(layout.fitBBox.minX - 1e-6);
      expect(rect.maxX).toBeLessThanOrEqual(layout.fitBBox.maxX + 1e-6);
      expect(rect.minY).toBeGreaterThanOrEqual(layout.fitBBox.minY - 1e-6);
      expect(rect.maxY).toBeLessThanOrEqual(layout.fitBBox.maxY + 1e-6);
      expect(rectsOverlap(rect, layout.cloudBBox)).toBe(false);
    }

    // extent[0] (the 0.5x zoom-out floor) is derived from fitToContent's
    // own scale computation over THIS SAME fitBBox -- effectiveCanvasHeight
    // is a no-op here (no .search-bar-wrapper mounted in this test's DOM),
    // so W/H are exactly the sizeContainer dims passed above.
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    const expectedKMin = 0.5 * Math.min(
      800 / (layout.fitBBox.maxX - layout.fitBBox.minX),
      620 / (layout.fitBBox.maxY - layout.fitBBox.minY),
    );
    expect(kMin).toBeCloseTo(expectedKMin, 9);
    // Review Minor 3(c): after the Important-1 fix, __scLayout.kFit is
    // ALWAYS measured from the SAME bbox that ends up stored as fitBBox
    // (measureAtBBox runs immediately whenever fitBBox changes, never on a
    // deferred later pass) -- so layout.kFit now equals the fit the app
    // actually applies, not merely something close to it modulo a one-pass
    // lag. Checked directly, alongside the independent W/H-derived
    // computation above.
    expect(Math.abs(kMin - 0.5 * layout.kFit)).toBeLessThan(1e-9);
  });

  // Task 9 (2026-09-13 user direction): the union above centers the UNION,
  // so a one-sided exile shifts the nebula off the viewport center at 100%
  // zoom. remeasureScLayout must expand fitBBox symmetrically about the
  // content bbox's own center instead (equal empty margin on the lighter
  // side).
  it("fit bbox is symmetric about the content bbox center, so the nebula stays centered at 100%", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 800, 620);
    document.body.appendChild(container);
    render(container, crowdedPayload("ctr", 2, 4), { icons: iconsFor("ctr") });
    flushSettleChunks();
    const layout = (window as W).__d3ScLayout!()!;
    const exiledAtFit = layout.report.filter((r) => r.overflow && r.kExile > layout.kFit);
    expect(exiledAtFit.length).toBeGreaterThan(0);
    // contentBBox is the padded content bbox (cloudBBox re-padded) -- its
    // center differs from cloudBBox's (unpadded) by 10 on y, since the pad
    // is symmetric on x but +20 extra on top -- so the symmetry center MUST
    // be read from contentBBox, not derived from cloudBBox.
    const cx = (layout.contentBBox.minX + layout.contentBBox.maxX) / 2;
    const cy = (layout.contentBBox.minY + layout.contentBBox.maxY) / 2;
    expect(Math.abs((layout.fitBBox.minX + layout.fitBBox.maxX) / 2 - cx)).toBeLessThan(1e-6);
    expect(Math.abs((layout.fitBBox.minY + layout.fitBBox.maxY) / 2 - cy)).toBeLessThan(1e-6);
    // and it still contains every exiled plate's rect (existing containment test covers the DOM rects)
    expect(layout.fitBBox.minX).toBeLessThanOrEqual(layout.cloudBBox.minX);
    expect(layout.fitBBox.maxX).toBeGreaterThanOrEqual(layout.cloudBBox.maxX);
  });

  it("cloudBBox is the unpadded content bbox when no plate is exiled at fit", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // Default separation options (generous budget) + a roomy canvas: the
    // report shows no overflow at all, so remeasureScLayout's fixed-point
    // loop breaks on iteration 0 with fitBBox === contentBBox exactly (the
    // plain, padded computeFitBBox(nodes) result) -- isolating the
    // unpadFitBBox arithmetic from the exile-inclusion loop.
    sizeContainer(container, 1600, 1240);
    document.body.appendChild(container);
    render(container, crowdedPayload("pad", 2, 4), { icons: iconsFor("pad") });
    flushSettleChunks();
    const layout = (window as W).__d3ScLayout!()!;
    expect(layout.report.some((r) => r.overflow)).toBe(false);
    // HULL_PADDING (20) + FIT_WORLD_PAD (155) = 175 on left/right/bottom;
    // +20 more (195) on top -- see computeFitBBox's own flat-pad step.
    expect(layout.cloudBBox.minX - layout.fitBBox.minX).toBeCloseTo(175, 6);
    expect(layout.fitBBox.maxX - layout.cloudBBox.maxX).toBeCloseTo(175, 6);
    expect(layout.cloudBBox.minY - layout.fitBBox.minY).toBeCloseTo(195, 6);
    expect(layout.fitBBox.maxY - layout.cloudBBox.maxY).toBeCloseTo(175, 6);
  });
});
