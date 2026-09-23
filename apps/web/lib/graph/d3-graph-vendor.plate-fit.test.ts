import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
import type { GraphDefaults } from "@/lib/graph/constants";

// Delta #36 (spec docs/project-plans/2026-09-23-151626-nameplate-lod-fit-scale/):
// nameplates scale with the fit. Real vendor render() in jsdom, same
// SyncFakeSimWorker / flushSettleChunks / tiny-geometry strategy as
// d3-graph-vendor.sc-separation.test.ts (see that file's header for the
// getScreenCTM/getBBox stub rationale). jsdom has no .search-bar-wrapper,
// so effectiveCanvasHeight(h) === h here: the laptop's measured 771x401
// container (88px search reserve) is emulated as 771x313.
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_scriptURL?: unknown, _options?: unknown) {}
  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return;
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
/** Four single-cluster superclusters (>= 2 painted SCs is what makes the
 *  vendor build a __scLayout record at all). */
function payload(prefix: string): GraphPayload {
  const nodes: GraphNode[] = []; const clusters: GraphCluster[] = []; const superClusters: GraphSuperCluster[] = [];
  for (let i = 0; i < 4; i++) {
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
  report: Array<{ keyword: string; overflow: boolean; kExile: number }>;
};
type W = Window & {
  __d3ScLayout?: () => Layout | null;
  __d3ScLayoutRemeasure?: (w: number, h: number) => Layout | null;
  __d3GetZoomScaleExtent?: () => [number, number];
};
const FLOOR_RATIO = 12 / 22;

async function mount(w: number, h: number, prefix: string, opts: { tunerSnapshot?: GraphDefaults } = {}) {
  const { render, applyTunerOverrides } = await import("@/lib/graph/d3-graph-vendor.js");
  const container = document.createElement("div");
  sizeContainer(container, w, h);
  document.body.appendChild(container);
  render(container, payload(prefix), { icons: iconsFor(prefix), ...opts });
  flushSettleChunks();
  return { container, render, applyTunerOverrides };
}

describe("d3-graph-vendor plate-fit scale (delta #36)", () => {
  beforeEach(() => {
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
});
