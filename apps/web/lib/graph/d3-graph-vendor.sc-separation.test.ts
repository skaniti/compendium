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

function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix {
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(this.getAttribute("transform") || "");
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    flushSettleChunks();
    (window as W).__d3SetScSeparationOptions?.({ budgetRatio: 0.5 });
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
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
});
