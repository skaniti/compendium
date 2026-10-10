import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
import type { GraphDefaults } from "@/lib/graph/constants";

// Delta #36 (the 2026-09-23 nameplate LOD fit-scale plan, private):
// nameplates scale with the fit. Real vendor render() in jsdom, same
// SyncFakeSimWorker / flushSettleChunks / tiny-geometry strategy as
// d3-graph-vendor.sc-separation.test.ts (see that file's header for the
// getScreenCTM/getBBox stub rationale). jsdom has no .search-bar-wrapper,
// so effectiveCanvasHeight(h) === h here: the laptop's measured 771x401
// container (88px search reserve) is emulated as 771x313.
let lastSimStart: SimStartPayload | null = null;
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_scriptURL?: unknown, _options?: unknown) {}
  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return;
    lastSimStart = message as SimStartPayload;
    const engine = createSimEngine(message as SimStartPayload);
    this.emit({ type: "tick", positions: engine.snapshot() });
    if (engine.done) { this.emit({ type: "end", positions: engine.snapshot() }); return; }
    let done = false;
    while (!done) {
      done = engine.step();
      this.emit(done ? { type: "end", positions: engine.snapshot() } : { type: "tick", positions: engine.snapshot() });
    }
  }
  terminate(): void { this.onmessage = null; }
  private emit(message: WorkerToMainMessage): void { this.onmessage?.({ data: message } as MessageEvent<unknown>); }
}
function flushSettleChunks(): void {
  const w = window as unknown as { __d3FlushSettleChunk?: () => boolean };
  for (let i = 0; i < 10 && w.__d3FlushSettleChunk?.(); i++) { /* drain */ }
}
function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix | null }).getScreenCTM = function (this: Element): DOMMatrix | null {
    if (this.getAttribute("data-sc") == null) return null;
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(this.getAttribute("transform") || "");
    return { a: 1, b: 0, c: 0, d: 1, e: m ? parseFloat(m[1]) : 0, f: m ? parseFloat(m[2]) : 0 } as DOMMatrix;
  };
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (this: Element): DOMRect {
    if (this.getAttribute("data-sc")) return { x: 0, y: 0, width: 1, height: 1 } as DOMRect;
    throw new Error("getBBox not stubbed for this element (test scope)");
  };
}
function uninstallTinyGeometryStubs(): void {
  delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
  delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
}
function sizeContainer(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
}
/** `n` single-cluster superclusters (default 4) (>= 2 painted SCs is what makes the
 *  vendor build a __scLayout record at all). */
function payload(prefix: string, n = 4): GraphPayload {
  const nodes: GraphNode[] = []; const clusters: GraphCluster[] = []; const superClusters: GraphSuperCluster[] = [];
  for (let i = 0; i < n; i++) {
    const kw = `${prefix}-sc${i} extremely long supercluster name`; const cid = `${prefix}-c${i}`; const ids: string[] = [];
    for (let p = 0; p < 6; p++) {
      const id = `${prefix}-p${i}-${p}`; ids.push(id);
      nodes.push({ id, label: id, level: 0, kind: "cluster", visit_count: 1, parent_id: cid, children_ids: [], capture_ids: [], page_urls: [`https://example.com/${id}`], first_visited_at: null });
    }
    clusters.push({ id: cid, name: `Cluster ${i}`, page_ids: ids, super_cluster: kw });
    superClusters.push({ keyword: kw, icon_id: `icon-${prefix}` });
  }
  return { nodes, links: [], clusters, super_clusters: superClusters, groups: [] };
}
function iconsFor(prefix: string): Record<string, IconEntry> {
  return { [`icon-${prefix}`]: { label: "T", category: "T", viewBox: "0 0 24 24", paths: ["M0 0 L1 1"] } };
}
type Layout = {
  kFit: number; kFloor: number; plateFitScale: number;
  contentBBox: { minX: number; minY: number; maxX: number; maxY: number };
  fpParams: { baseIconSize: number; baseNameFontPx: number; labelTopPad: number };
  report: Array<{ keyword: string }>;
};
type W = Window & {
  __d3ScLayout?: () => Layout | null;
  __d3ScLayoutRemeasure?: (w: number, h: number) => Layout | null;
  __d3GetZoomScaleExtent?: () => [number, number];
};
const FLOOR_RATIO = 12 / 22;

async function mount(w: number, h: number, prefix: string, opts: { tunerSnapshot?: GraphDefaults } = {}, scCount = 4) {
  const { render, applyTunerOverrides } = await import("@/lib/graph/d3-graph-vendor.js");
  const container = document.createElement("div");
  sizeContainer(container, w, h);
  document.body.appendChild(container);
  render(container, payload(prefix, scCount), { icons: iconsFor(prefix), ...opts });
  flushSettleChunks();
  return { container, render, applyTunerOverrides };
}

describe("d3-graph-vendor plate-fit scale (delta #36)", () => {
  beforeEach(() => {
    lastSimStart = null;
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    installTinyGeometryStubs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame"] });
  });
  afterEach(async () => {
    flushSettleChunks();
    // restore code defaults so an override in one test never leaks into the next
    const { resetTunerToDefaults } = await import("@/lib/graph/d3-graph-vendor.js");
    resetTunerToDefaults();
    flushSettleChunks();
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("reports plateFitScale 1 when the smaller canvas side is at least REF (pixel parity with today)", async () => {
    await mount(1100, 850, "big");
    const layout = (window as W).__d3ScLayout!()!;
    expect(layout.plateFitScale).toBe(1);
  });

  it("reports S/REF on a mid canvas", async () => {
    await mount(900, 480, "mid");   // S = 480 -> 480/640
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBeCloseTo(0.75, 6);
  });

  it("clamps at the name floor on the laptop-class canvas", async () => {
    await mount(771, 313, "lap");   // S = 313 -> 0.489 < 12/22
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBeCloseTo(FLOOR_RATIO, 6);
  });

  it("applyTunerOverrides re-derives the scale (REF lowered to the canvas -> 1)", async () => {
    const { applyTunerOverrides } = await mount(900, 480, "ovr");
    applyTunerOverrides({ SC_PLATE_FIT_REF_PX: 480 });
    flushSettleChunks();
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBe(1);
  });

  it("a floor override at or above the base name size clamps the scale to 1", async () => {
    const { applyTunerOverrides } = await mount(771, 313, "flr");
    applyTunerOverrides({ SC_NAME_FIT_FLOOR_PX: 22 });
    flushSettleChunks();
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBe(1);
    applyTunerOverrides({ SC_NAME_FIT_FLOOR_PX: 30 });
    flushSettleChunks();
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBe(1);
  });

  it("the remeasure (resize) path re-derives the scale for the new canvas size", async () => {
    await mount(1100, 850, "rsz");
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBe(1);
    const after = (window as W).__d3ScLayoutRemeasure!(771, 313)!;
    expect(after.plateFitScale).toBeCloseTo(FLOOR_RATIO, 6);
  });

  it("a stale-TYPO_V tunerSnapshot does not apply the plate-fit keys", async () => {
    // REF 300 would lift the laptop canvas to scale 1; a v4-stamped profile must be ignored for these keys
    await mount(771, 313, "stale", { tunerSnapshot: { ...GRAPH_DEFAULTS, TYPO_V: 4, SC_PLATE_FIT_REF_PX: 300 } });
    expect((window as W).__d3ScLayout!()!.plateFitScale).toBeCloseTo(FLOOR_RATIO, 6);
  });

  function fitZoomOf(): number { return (window as W).__d3GetZoomScaleExtent!()[1] / 4; }  // extent max = 4 * fit
  function paintedNamePxAtFit(container: HTMLElement): number {
    // <text class="supercluster-label" style="font-size: <world px>px"> (renderScName's text branch,
    // active whenever the Almagest preview is off). World font px * k at fit = painted px.
    const el = container.querySelector("text.supercluster-label") as SVGTextElement | null;
    expect(el).not.toBeNull();
    return parseFloat(el!.style.fontSize) * fitZoomOf();
  }
  function paintedIconPxAtFit(container: HTMLElement): number {
    // icon path transform is scale(ICON_SIZE / viewBoxWidth); fixture viewBox is 24 wide
    const p = container.querySelector("g.watermark path") as SVGPathElement | null;
    expect(p).not.toBeNull();
    const m = /scale\(([-\d.eE]+)\)/.exec(p!.getAttribute("transform") || "");
    return parseFloat(m![1]) * 24 * fitZoomOf();
  }

  it("paints the name at the floor size at fit on the laptop-class canvas", async () => {
    const { container } = await mount(771, 313, "pn");
    expect(paintedNamePxAtFit(container)).toBeCloseTo(12, 1);
  });

  it("paints the name at the base size at fit on a large canvas (pixel parity)", async () => {
    const { container } = await mount(1100, 850, "pb");
    expect(paintedNamePxAtFit(container)).toBeCloseTo(22, 1);
    expect(paintedIconPxAtFit(container)).toBeCloseTo(100, 1);
  });

  it("paints the icon at BASE * floor at fit on the laptop-class canvas", async () => {
    const { container } = await mount(771, 313, "pi");
    expect(paintedIconPxAtFit(container)).toBeCloseTo(100 * FLOOR_RATIO, 1);
  });

  it("footprint params carry the scale so the estimator and the fit-inclusion loop follow", async () => {
    await mount(771, 313, "fp");
    const fp = (window as W).__d3ScLayout!()!.fpParams;
    expect(fp.baseIconSize).toBeCloseTo(100 * FLOOR_RATIO, 6);
    expect(fp.baseNameFontPx).toBeCloseTo(12, 6);
    expect(fp.labelTopPad).toBeCloseTo(10 * FLOOR_RATIO, 6);
  });

  it("computeFitBBox's plate padding carries the scale (single SC: no separation pass, so fitToContent frames the raw bbox)", async () => {
    // With ONE painted SC, applyScLayoutSeparation and remeasureScLayout both
    // return early (they need >= 2 plates), so nothing shifts nodes and
    // fitToContent frames computeFitBBox(nodes) directly; the zoom extent's
    // max is 4 x that fit. The plate padding below the SC centroid is
    // (icon/2 + pad + lines x 22 x 1.3) x plateFitScale + 8 world units. The
    // prefix "b" is chosen so the 36-char slice keeps a fifth word ("b-sc0
    // extremely long supercluster na" -> b-sc0 / extremely / long /
    // supercluster / na = 5 lines with the 12-char budget), so it is 203 x s
    // + 8: 211 at scale 1, ~119 at the 12/22 floor. The fog term for an
    // SC-member cluster is max(maxDist x NEBULA_RADIUS_MULT, 380) x
    // NEBULA_FIT_CORE, which is >= 304 under shipped constants and masks the
    // padding at every scale; the two overrides below bring it to 152. So the
    // PLATE sets maxY at scale 1 (211 > 152) and the FOG does at the floor
    // (119 < 152): the bbox is shorter at the floor and fitZoom rises WITH
    // the padding seam, and stays identical WITHOUT it (the multi-SC variant
    // of this test could not tell, because scaled footprints also change the
    // separation pass's node shifts).
    const { applyTunerOverrides } = await mount(1100, 850, "b", {}, 1);
    // Under shipped constants the SC-member fog floor (380 x 0.8 = 304 world
    // units) exceeds the largest plate padding (211), masking the padding term
    // at every scale. Two non-degenerate overrides make it observable: a
    // radius multiplier of 1 so the 380 floor is guaranteed to win over
    // maxDist x MULT regardless of fixture spread, and a fit core of 0.4 so
    // the fog core is 152 -- between the plate's 211 at scale 1
    // and ~119 at the floor. Overrides always rebuild from code defaults plus
    // the partial, so the second call restates both fog keys.
    applyTunerOverrides({ NEBULA_RADIUS_MULT: 1, NEBULA_FIT_CORE: 0.4 });
    flushSettleChunks();
    const fitAtOne = fitZoomOf();
    expect(Number.isFinite(fitAtOne) && fitAtOne > 0).toBe(true);
    applyTunerOverrides({ NEBULA_RADIUS_MULT: 1, NEBULA_FIT_CORE: 0.4, SC_PLATE_FIT_REF_PX: 1600 });  // 850/1600 = 0.53 -> floor 12/22
    flushSettleChunks();
    const fitAtFloor = fitZoomOf();
    expect(fitAtFloor).toBeGreaterThan(fitAtOne * 1.01);
  });

  it("the sim-start payload's footprint is planned for a canvas of at least 640px per side (delta #40), not the short load canvas", async () => {
    // Task 13: buildSimStartPayload used to embed the plate-fit scale of the
    // load canvas (12/22 floor on 771x313), which inflated world-unit
    // footprints ~15x. Planning now floors the canvas at SC_PLATE_FIT_REF_PX,
    // so the footprint is the unscaled plate and the payload names the floor.
    await mount(771, 313, "seed");
    expect(lastSimStart).not.toBeNull();
    const sep = lastSimStart!.scSeparation!;
    expect(sep.footprint.baseNameFontPx).toBeCloseTo(22, 6);
    expect(sep.footprint.baseIconSize).toBeCloseTo(100, 6);
    expect(sep.minCanvasPx).toBe(640);
  });

  it("the icon->name pad follows the plate-fit scale (name y offset at fit is 110 x scale painted px)", async () => {
    // renderScName is called with y = ICON_SIZE + SC_LABEL_TOP_PAD * plateFitScale * iconScale
    // (world units); at fit iconScale = 1 / fitZoom, so y * fitZoom = (100 + 10) * scale.
    const { container } = await mount(771, 313, "pad");
    const el = container.querySelector("text.supercluster-label") as SVGTextElement | null;
    expect(el).not.toBeNull();
    expect(parseFloat(el!.getAttribute("y") || "NaN") * fitZoomOf()).toBeCloseTo(110 * FLOOR_RATIO, 1);
  });

  it("the sim-start payload's footprint is the same planning footprint for a short and a large canvas on re-render", async () => {
    const { container, render } = await mount(1100, 850, "rr");
    expect(lastSimStart!.scSeparation!.footprint.baseNameFontPx).toBeCloseTo(22, 6);
    sizeContainer(container, 771, 313);
    render(container, payload("rr"), { icons: iconsFor("rr") });
    flushSettleChunks();
    expect(lastSimStart!.scSeparation!.footprint.baseNameFontPx).toBeCloseTo(22, 6);
  });
});
