import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { plateFootprintAtRatio, rectsOverlap } from "@/lib/graph/sc-separation";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";

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

function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix | null }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix | null {
    // Scoped to g.watermark (identified by data-sc) -- the only elements
    // screenBBoxOf (R6 resolver) ever calls this on in this test file. Real
    // jsdom has no getScreenCTM at all (verified: undefined, not merely
    // throwing); every other element stays unstubbed.
    if (this.getAttribute("data-sc") == null) return null;
    const transform = this.getAttribute("transform") || "";
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform);
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
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
 *  tiny sim packs them close. `nameSuffix` defaults to the original fixture
 *  text; a handful of tests below pass a longer one -- see their own
 *  comments for why (2026-09-13 Almagest bake: the shipped font's average
 *  glyph advance narrowed from ~0.83em to ~0.6129em, so SC_NAME_CHAR_WIDTH
 *  -- the vendor's derived per-char footprint width -- dropped from ~24.78
 *  to ~18.39px at the 30px reference size; some fixtures need a longer name
 *  to reach the same overflow/exile preconditions the old, wider glyphs
 *  produced at this default suffix). */
function crowdedPayload(
  prefix: string,
  n: number,
  pagesPer: number,
  nameSuffix = "extremely long supercluster name",
): GraphPayload {
  const nodes: GraphNode[] = [];
  const clusters: GraphCluster[] = [];
  const superClusters: GraphSuperCluster[] = [];
  for (let i = 0; i < n; i++) {
    const kw = `${prefix}-sc${i} ${nameSuffix}`;
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
type Report = Array<{ keyword: string; pages: number; shiftPx: number; budgetPx: number }>;
type Layout = { kFit: number; kFloor: number; cloudBBox: { minX: number; minY: number; maxX: number; maxY: number }; contentBBox: { minX: number; minY: number; maxX: number; maxY: number }; fitBBox: { minX: number; minY: number; maxX: number; maxY: number }; plates: Record<string, { anchor: { x: number; y: number } | null; shiftPx: number; budgetPx: number }>; fpParams: Parameters<typeof plateFootprintAtRatio>[2]; report: Report };
type PlacementPlate = { pointer: boolean; cx: number; cy: number; iconPx: number; namePx: number; padPx: number; nameHidden: boolean; band: "L" | "R" | "T" | "B" | null; column: 0 | 1 | null };
type Placement = { c: number; cap: number; t: number; phase: "none" | "graded" | "names" | "icons" | "ring"; fallback: boolean; plates: Record<string, PlacementPlate> };
type SeparationOptions = {
  budgetRatio?: number;
  budgetMinPx?: number;
  exileMarginPx?: number;
};
type W = Window & {
  __d3ScLayoutReport?: () => Report | null;
  __d3ScLayout?: () => Layout | null;
  __d3ScLayoutRemeasure?: (w: number, h: number) => Layout | null;
  __d3SetScSeparationOptions?: (o: SeparationOptions) => void;
  __d3GetScSeparationOptions?: () => Required<SeparationOptions>;
  __d3ZoomTo?: (k: number) => boolean;
  __d3PanBy?: (dx: number, dy: number) => boolean;
  __d3GetZoomScaleExtent?: () => [number, number];
  __d3ScPlacement?: () => Placement | null;
};

// Final fix wave (item 2): the module defaults, captured ONCE here rather
// than re-hardcoded at every afterEach restore -- SC_SEPARATION_BUDGET_RATIO
// / SC_SEPARATION_BUDGET_MIN_PX in the vendor.
const DEFAULT_SC_SEPARATION_BUDGET_RATIO = 0.5;
const DEFAULT_SC_SEPARATION_BUDGET_MIN_PX = 60;
// Same idea for the ring-fallback margin -- SC_EXILE_MARGIN_PX in the vendor.
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
      exileMarginPx: DEFAULT_SC_EXILE_MARGIN_PX,
    });
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("the settle pass shifts SCs apart within each SC's budget", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // 1100x850: roomy enough that the correction pass shifts plates within
    // their budgets instead of leaving every pair unresolved (at 420x320
    // every overlap exceeds its budget and no partial shift is applied).
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);
    render(container, crowdedPayload("sep", 4, 6), { icons: iconsFor("sep") });
    flushSettleChunks();
    const report = (window as W).__d3ScLayoutReport?.();
    expect(report).toBeTruthy();
    expect(report!.length).toBe(4);
    // At least one plate genuinely shifted, and none beyond its budget.
    expect(report!.some((r) => r.shiftPx > 0)).toBe(true);
    for (const r of report!) {
      expect(r.shiftPx).toBeLessThanOrEqual(r.budgetPx + 1e-6);
    }
  });

  it("__d3ScLayoutRemeasure re-derives kFit and kFloor for a new canvas size without moving nodes (resize path)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // 2670x2076: a large canvas so halving it (1335x1038) is a clean 2x
    // change of both fit ratios; kFit/kFloor then scale exactly by 0.5.
    sizeContainer(container, 2670, 2076);
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
    const half = (window as W).__d3ScLayoutRemeasure!(1335, 1038)!;
    expect(half).toBeTruthy();
    expect(half.kFloor).toBeCloseTo(before.kFloor * 0.5, 9);
    // Review Minor 3(d): kFit itself (not just kFloor) halves exactly.
    expect(Math.abs(half.kFit - before.kFit * 0.5)).toBeLessThan(1e-9);
    // Review Minor 3(a): fitBBox is the node-only content bbox at both
    // sizes -- it must be IDENTICAL at both canvas sizes, since it
    // depends only on unmoved node positions, never on canvasW/canvasH.
    // Without this, "halving the canvas exactly halves kFit" would hold by
    // coincidence rather than because the two measurements are actually
    // comparing the same content.
    expect(half.fitBBox).toEqual(before.fitBBox);
    // Idempotence: remeasuring back at the ORIGINAL canvas size reproduces
    // the settle-time record exactly (deterministic given unmoved nodes).
    const restored = (window as W).__d3ScLayoutRemeasure!(2670, 2076)!;
    expect(restored.kFloor).toBeCloseTo(before.kFloor, 9);
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

  function placement(): Placement {
    const p = (window as W).__d3ScPlacement!();
    expect(p).toBeTruthy();
    return p!;
  }
  function plateEl(container: HTMLElement, kw: string): Element {
    return Array.from(container.querySelectorAll("g.watermark")).find((n) => n.getAttribute("data-sc") === kw)!;
  }
  function worldRect(g: Element): { minX: number; maxX: number; minY: number; maxY: number } {
    const t = parseTranslate(g.getAttribute("transform"));
    const cx = t.x + parseFloat(g.getAttribute("data-plate-cx")!), cy = t.y + parseFloat(g.getAttribute("data-plate-cy")!);
    const hw = parseFloat(g.getAttribute("data-plate-hw")!), hh = parseFloat(g.getAttribute("data-plate-hh")!);
    return { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
  }
  function rootTransform(container: HTMLElement): { x: number; y: number; k: number } {
    const tr = container.querySelector("g.graph-root")!.getAttribute("transform") || "";
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(tr), s = /scale\(([-\d.eE]+)\)/.exec(tr);
    return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2]) : 0, k: s ? parseFloat(s[1]) : 1 };
  }
  // Wide and short: the user's case; room left and right only. 900x240: at
  // 900x320 the "ptr" fixture produced no pointers at fit (its sim layout
  // spreads the anchors apart), 280 still none, 240 gives pointers and bands
  // for every prefix used below. Never read the size from anywhere but these.
  const CROWD_W = 900, CROWD_H = 240;
  async function mountCrowded(prefix: string, w = CROWD_W, h = CROWD_H) {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, w, h);
    document.body.appendChild(container);
    const dispose = render(container, crowdedPayload(prefix, 4, 2), { icons: iconsFor(prefix) });
    flushSettleChunks();
    await vi.advanceTimersByTimeAsync(2000);
    return { container, dispose };
  }

  it("crowded plates: one shared crowd scale, then pointers one at a time, lowest priority first", async () => {
    const { container } = await mountCrowded("ptr");
    const p = placement();
    expect(p.c).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(p.c).toBeLessThanOrEqual(1);
    const keys = Object.keys(p.plates).sort();
    const pointers = keys.filter((k) => p.plates[k].pointer);
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.length).toBeLessThan(keys.length);
    // Equal pages (crowdedPayload) -> ties break by keyword, so the first key
    // has top priority and never gives way. (A low-priority plate that
    // collides with nothing stays in place, so "pointers are the last keys"
    // is NOT a valid expectation.)
    expect(p.plates[keys[0]].pointer).toBe(false);
    for (const kw of keys) {
      const g = plateEl(container, kw);
      const leader = container.querySelector(`g.watermark-leader[data-sc="${kw}"]`);
      if (p.plates[kw].pointer) {
        expect(g.getAttribute("data-exiled")).toBe("1");
        expect(leader).toBeTruthy();
        expect(leader!.querySelector("circle.watermark-anchor-dot")).toBeTruthy();
      } else {
        expect(g.getAttribute("data-exiled")).toBeNull();
        expect(leader).toBeNull();
        const t = parseTranslate(g.getAttribute("transform"));
        expect(t.x).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-x")!), 3);
        expect(t.y).toBeCloseTo(parseFloat(g.getAttribute("data-anchor-y")!), 3);
      }
    }
  });

  it("a pointer's leader starts at the anchor dot and ends on its plate rect", async () => {
    const { container } = await mountCrowded("ldr");
    const p = placement();
    const kw = Object.keys(p.plates).find((k) => p.plates[k].pointer)!;
    const g = plateEl(container, kw);
    const leader = container.querySelector(`g.watermark-leader[data-sc="${kw}"]`)!;
    const dot = leader.querySelector("circle.watermark-anchor-dot")!;
    const line = leader.querySelector("line.watermark-leader-line")!;
    expect(parseFloat(line.getAttribute("x1")!)).toBeCloseTo(parseFloat(dot.getAttribute("cx")!), 6);
    const r = worldRect(g);
    const x2 = parseFloat(line.getAttribute("x2")!), y2 = parseFloat(line.getAttribute("y2")!);
    const onV = Math.abs(x2 - r.minX) < 1e-6 || Math.abs(x2 - r.maxX) < 1e-6;
    const onH = Math.abs(y2 - r.minY) < 1e-6 || Math.abs(y2 - r.maxY) < 1e-6;
    expect(onV || onH).toBe(true);
  });

  it("band pointers on a wide, short canvas sit left or right, inside the canvas", async () => {
    const { container } = await mountCrowded("bnd");
    const p = placement();
    expect(p.fallback).toBe(false);
    const rt = rootTransform(container);
    for (const kw of Object.keys(p.plates).filter((k) => p.plates[k].pointer)) {
      expect(["L", "R"]).toContain(p.plates[kw].band);
      const r = worldRect(plateEl(container, kw));
      const s = { minX: r.minX * rt.k + rt.x, maxX: r.maxX * rt.k + rt.x, minY: r.minY * rt.k + rt.y, maxY: r.maxY * rt.k + rt.y };
      expect(s.minX).toBeGreaterThanOrEqual(-1e-3);
      expect(s.maxX).toBeLessThanOrEqual(CROWD_W + 1e-3);
      expect(s.minY).toBeGreaterThanOrEqual(-1e-3);
      expect(s.maxY).toBeLessThanOrEqual(CROWD_H + 1e-3);
    }
  });

  it("plates in place never overlap, at fit and at the zoom floor, and their names stay readable", async () => {
    const { container } = await mountCrowded("flr");
    const check = () => {
      const p = placement();
      const inPlace = Array.from(container.querySelectorAll("g.watermark")).filter((g) => g.getAttribute("data-exiled") !== "1");
      for (let i = 0; i < inPlace.length; i++) for (let j = i + 1; j < inPlace.length; j++) {
        expect(rectsOverlap(worldRect(inPlace[i]), worldRect(inPlace[j]))).toBe(false);
      }
      const layout = (window as W).__d3ScLayout!()!;
      const k = rootTransform(container).k;
      const ratio = k / layout.kFit;
      const nameAtZoom = 22 * (layout as unknown as { plateFitScale: number }).plateFitScale * Math.min(2, Math.max(0.75, ratio));
      for (const g of inPlace) {
        const text = g.querySelector("text.supercluster-label") as SVGTextElement | null;
        if (!text) continue;
        const painted = parseFloat(text.style.fontSize) * k;
        expect(painted).toBeGreaterThanOrEqual(Math.min(12, nameAtZoom) - 1e-6);
      }
      return p;
    };
    check();
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    check();
  });

  it("zooming in brings pointers back to their place", async () => {
    const { container } = await mountCrowded("ret");
    const before = placement();
    const pointers = Object.keys(before.plates).filter((k) => before.plates[k].pointer);
    expect(pointers.length).toBeGreaterThan(0);
    const layout = (window as W).__d3ScLayout!()!;
    const [, kMax] = (window as W).__d3GetZoomScaleExtent!();
    expect((window as W).__d3ZoomTo!(Math.min(layout.kFit * 3, kMax))).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    const after = placement();
    const still = Object.keys(after.plates).filter((k) => after.plates[k].pointer);
    expect(still.length).toBeLessThan(pointers.length);
    const back = pointers.find((k) => !after.plates[k].pointer)!;
    expect(container.querySelector(`g.watermark-leader[data-sc="${back}"]`)).toBeNull();
  });

  it("when no band is usable, pointers go on the ring as icon-only plates whose hover still names them", async () => {
    const { applyTunerOverrides } = await import("@/lib/graph/d3-graph-vendor.js");
    const tip = document.createElement("div");
    tip.id = "node-tooltip";
    document.body.appendChild(tip);
    try {
      const { container } = await mountCrowded("ring");
      applyTunerOverrides({ SC_BAND_GAP_PX: 5000 });   // every band thinner than any plate
      flushSettleChunks();
      await vi.advanceTimersByTimeAsync(2000);
      const p = placement();
      expect(p.fallback).toBe(true);
      expect(p.phase).toBe("ring");
      const kw = Object.keys(p.plates).find((k) => p.plates[k].pointer)!;
      expect(p.plates[kw].nameHidden).toBe(true);
      const g = plateEl(container, kw);
      expect(g.querySelector("text.supercluster-label")).toBeNull();
      g.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(tip.textContent).toContain(kw);
    } finally {
      tip.remove();
      // Tuner state is module-level: restore it so later tests in this file see the default.
      applyTunerOverrides({ SC_BAND_GAP_PX: GRAPH_DEFAULTS.SC_BAND_GAP_PX });
      flushSettleChunks();
    }
  });

  it("fit is the content bbox whatever the pointer count (the cliff's feedback loop is gone)", async () => {
    await mountCrowded("fit");
    const fitPlacement = placement();
    expect(Object.values(fitPlacement.plates).some((pl) => pl.pointer)).toBe(true);
    const layout = (window as W).__d3ScLayout!()!;
    expect(layout.fitBBox).toEqual(layout.contentBBox);
    const [kMin] = (window as W).__d3GetZoomScaleExtent!();
    expect(kMin).toBeCloseTo(0.5 * Math.min(
      CROWD_W / (layout.contentBBox.maxX - layout.contentBBox.minX),
      CROWD_H / (layout.contentBBox.maxY - layout.contentBBox.minY),
    ), 9);
  });

  it("a pan tick keeps the last placement: pointers ride with the graph", async () => {
    await mountCrowded("pan");
    const before = placement();
    expect((window as W).__d3PanBy!(40, 0)).toBe(true);
    expect(placement()).toBe(before);   // same object: no re-placement mid-pan
  });

  it("pointers re-place once the pan has been idle for SC_PAN_SETTLE_MS", async () => {
    const { container } = await mountCrowded("set");
    const before = placement();
    (window as W).__d3PanBy!(40, 0);
    await vi.advanceTimersByTimeAsync(GRAPH_DEFAULTS.SC_PAN_SETTLE_MS - 20);
    expect(placement()).toBe(before);
    (window as W).__d3PanBy!(40, 0);    // a second tick restarts the wait
    await vi.advanceTimersByTimeAsync(GRAPH_DEFAULTS.SC_PAN_SETTLE_MS - 20);
    expect(placement()).toBe(before);
    await vi.advanceTimersByTimeAsync(40);
    const after = placement();
    expect(after).not.toBe(before);
    // Re-placed in the panned view: every band pointer is still on the canvas.
    const tr = rootTransform(container);
    const bandPtrs = Object.keys(after.plates).filter((k) => after.plates[k].pointer && after.plates[k].band);
    expect(bandPtrs.length).toBeGreaterThan(0);
    for (const kw of bandPtrs) {
      const r = worldRect(plateEl(container, kw));
      expect(r.minX * tr.k + tr.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.maxX * tr.k + tr.x).toBeLessThanOrEqual(CROWD_W + 1e-6);
      expect(r.minY * tr.k + tr.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.maxY * tr.k + tr.y).toBeLessThanOrEqual(CROWD_H + 1e-6);
    }
  });

  it("dispose cancels a pending pan-settle redraw", async () => {
    const { dispose } = await mountCrowded("dsp");
    const before = placement();
    (window as W).__d3PanBy!(40, 0);
    (dispose as () => void)();
    await vi.advanceTimersByTimeAsync(GRAPH_DEFAULTS.SC_PAN_SETTLE_MS * 3);
    expect(placement()).toBe(before);
  });

  it("a draw right after a re-render never reuses a placement built for another plate set", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const { container } = await mountCrowded("gen");
    expect(Object.keys(placement().plates)).toHaveLength(4);
    // A worker that never answers keeps the new layout from settling, which
    // is the window where the old placement used to be served from cache.
    vi.stubGlobal("Worker", class { onmessage = null; postMessage() {} terminate() {} });
    render(container, crowdedPayload("gen", 3, 2), { icons: iconsFor("gen") });
    (window as W).__d3PanBy!(10, 0);   // a draw before the new layout has settled
    expect(Object.keys(placement().plates).filter((k) => k.includes("sc3"))).toEqual([]);
  });

  it("a refresh while zoomed out forgets the old zoom's pointers: same placement as a fresh mount", async () => {
    const { render, applyTunerOverrides } = await import("@/lib/graph/d3-graph-vendor.js");
    const ptrs = (p: Placement) => Object.keys(p.plates).filter((k) => p.plates[k].pointer).sort();
    // A wide hysteresis makes an inherited pointer stick, so the test fails
    // if the memory survives the refresh's settle.
    const wide = async () => {
      applyTunerOverrides({ SC_FLIP_HYSTERESIS: 0.5 });
      flushSettleChunks();
      await vi.advanceTimersByTimeAsync(2000);
    };
    try {
      const { container } = await mountCrowded("ref");
      await wide();
      const [kMin] = (window as W).__d3GetZoomScaleExtent!();
      expect((window as W).__d3ZoomTo!(kMin)).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(ptrs(placement()).length).toBeGreaterThan(0);
      render(container, crowdedPayload("ref", 4, 2), { icons: iconsFor("ref") });
      flushSettleChunks();
      await vi.advanceTimersByTimeAsync(2000);
      const refreshed = ptrs(placement());
      await mountCrowded("ref");
      await wide();
      expect(refreshed).toEqual(ptrs(placement()));
    } finally {
      applyTunerOverrides({ SC_FLIP_HYSTERESIS: GRAPH_DEFAULTS.SC_FLIP_HYSTERESIS });
      flushSettleChunks();
    }
  });

  it("growing the panel by 2px never evicts a plate that the shrink had kept in place", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 1300, 620);
    document.body.appendChild(container);
    render(container, crowdedPayload("u", 14, 1, "x"), { icons: iconsFor("u") });
    flushSettleChunks();
    await vi.advanceTimersByTimeAsync(2000);
    const ptrs = () => Object.keys(placement().plates).filter((k) => placement().plates[k].pointer).sort();
    const resize = (h: number) => { sizeContainer(container, 1300, h); callbacks.forEach((cb) => cb()); };
    for (let h = 620; h >= 430; h -= 2) resize(h);
    const atMin = ptrs();
    expect(atMin.length).toBeGreaterThan(0);
    resize(432);
    const grown = ptrs();
    expect(grown.filter((k) => !atMin.includes(k))).toEqual([]);
  }, 30000);

  it("the pan clamp follows the current canvas size after a resize (graph stays centred)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 1010, 781);
    document.body.appendChild(container);
    render(container, crowdedPayload("ctr", 4, 2), { icons: iconsFor("ctr") });
    flushSettleChunks();
    await vi.advanceTimersByTimeAsync(2000);
    const resize = (w: number) => { sizeContainer(container, w, 781); callbacks.forEach((cb) => cb()); };
    const centreX = () => {
      const bb = (window as W).__d3ScLayout!()!.contentBBox;
      const t = rootTransform(container);
      return t.x + t.k * (bb.minX + bb.maxX) / 2;
    };
    expect(Math.abs(centreX() - 505)).toBeLessThan(1);
    resize(410);
    expect(Math.abs(centreX() - 205)).toBeLessThan(1);
    // A zoom tick at fit runs the clamp again; it must not drag the graph back.
    expect((window as W).__d3ZoomTo!((window as W).__d3ScLayout!()!.kFit)).toBe(true);
    expect(Math.abs(centreX() - 205)).toBeLessThan(1);
    resize(1010);
    expect(Math.abs(centreX() - 505)).toBeLessThan(1);
  }, 30000);

  it("the crowd scale holds when a plate becomes a pointer and lifts once one returns", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (window as W).__d3SetScSeparationOptions!({ budgetRatio: 0, budgetMinPx: 0 });
    const container = document.createElement("div");
    sizeContainer(container, 1300, 620);
    document.body.appendChild(container);
    render(container, crowdedPayload("cap", 14, 1, "x"), { icons: iconsFor("cap") });
    flushSettleChunks();
    await vi.advanceTimersByTimeAsync(2000);
    const ptrCount = () => Object.values(placement().plates).filter((p) => p.pointer).length;
    const resize = (h: number) => { sizeContainer(container, 1300, h); callbacks.forEach((cb) => cb()); };
    let prevC = placement().c;
    let prevN = ptrCount();
    let evictions = 0;
    for (let h = 620; h >= 400 && evictions < 2; h -= 2) {
      resize(h);
      const c = placement().c, n = ptrCount();
      if (n >= prevN) expect(c).toBeLessThanOrEqual(prevC + 1e-9);
      if (n > prevN) evictions++;
      prevC = c; prevN = n;
    }
    expect(evictions).toBeGreaterThanOrEqual(2);
    // Growing back past the return point lifts the cap, so c rises again.
    const peak = ptrCount();
    let returned = false;
    for (let h = 400; h <= 900 && !returned; h += 2) {
      resize(h);
      returned = ptrCount() < peak;
    }
    expect(returned).toBe(true);
    expect(placement().cap).toBe(1);
    const atReturn = placement().c;
    let max = atReturn;
    for (let h = 900; h <= 1100; h += 2) { resize(h); max = Math.max(max, placement().c); }
    expect(max).toBeGreaterThan(atReturn + 1e-6);
  }, 30000);

  it("cloudBBox is the content bbox minus the flat fit pad", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    // Default separation options (generous budget) + a roomy canvas: with
    // nothing left to separate, fitBBox === contentBBox exactly (the plain,
    // padded computeFitBBox(nodes) result) -- isolating the unpadFitBBox
    // arithmetic.
    sizeContainer(container, 1600, 1240);
    document.body.appendChild(container);
    render(container, crowdedPayload("pad", 2, 4), { icons: iconsFor("pad") });
    flushSettleChunks();
    const layout = (window as W).__d3ScLayout!()!;
    // HULL_PADDING (20) + FIT_WORLD_PAD (155) = 175 on left/right/bottom;
    // +20 more (195) on top -- see computeFitBBox's own flat-pad step.
    expect(layout.cloudBBox.minX - layout.fitBBox.minX).toBeCloseTo(175, 6);
    expect(layout.fitBBox.maxX - layout.cloudBBox.maxX).toBeCloseTo(175, 6);
    expect(layout.cloudBBox.minY - layout.fitBBox.minY).toBeCloseTo(195, 6);
    expect(layout.fitBBox.maxY - layout.cloudBBox.maxY).toBeCloseTo(175, 6);
  });
});
