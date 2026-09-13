import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload, GraphCluster, GraphSuperCluster, GraphNode } from "@/lib/types";
import type { IconEntry } from "@/lib/icons";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";
import { shippedParams } from "@/lib/almagest/params";

// Delta #33 (vendor header comment) -- exercises the REAL vendor render()
// pipeline in jsdom, same overall strategy as
// d3-graph-vendor.sc-separation.test.ts (see that file's own header comment
// for the getScreenCTM/getBBox stub rationale): a dev preview swaps the
// default <text> SC-name node for a <g> of generator path glyphs, and
// clearing the preview swaps it back.
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

function flushSettleChunks(): void {
  const w = window as unknown as { __d3FlushSettleChunk?: () => boolean };
  for (let i = 0; i < 10 && w.__d3FlushSettleChunk?.(); i++) {
    // keep draining until nothing is left pending
  }
}

let __ctmGraphRootEnabled = false;

function installTinyGeometryStubs(): void {
  (SVGElement.prototype as unknown as { getScreenCTM: () => DOMMatrix | null }).getScreenCTM = function (
    this: Element,
  ): DOMMatrix | null {
    const isWatermark = this.getAttribute("data-sc") != null;
    const isGraphRoot = __ctmGraphRootEnabled && this.classList.contains("graph-root");
    if (!isWatermark && !isGraphRoot) return null;
    const transform = this.getAttribute("transform") || "";
    const m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(transform);
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    if (isGraphRoot) {
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
    // vendor wraps this in its own try/catch and degrades gracefully -- the
    // preview <g> (data-almagest-preview) is one such caller (path glyphs
    // are laid out from the generator's own metrics, not measured via
    // getBBox), so it never reaches here.
    throw new Error("getBBox not stubbed for this element (test scope)");
  };
}

function uninstallTinyGeometryStubs(): void {
  delete (SVGElement.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
  delete (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
}

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
function sizeContainer(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
}

type W = Window & { __d3SetAlmagestPreview?: (p: unknown) => void; __d3SetAlmagestTierTint?: (on: boolean) => void };

// Batch A tint-by-tier debug aid (spec docs/project-plans/2026-09-13-183006-
// graph-interaction-followups/): jsdom's CSSStyleDeclaration normalizes a
// hex color assigned via .style.fill to "rgb(r, g, b)" when read back (the
// same normalization d3's own .style() call goes through), so the expected
// values are derived through the same round-trip rather than hardcoded as
// hex strings that would never match.
function normalizedColor(hex: string): string {
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "text");
  probe.style.fill = hex;
  return probe.style.fill;
}

describe("d3-graph-vendor Almagest preview (delta #33)", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    installTinyGeometryStubs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame"] });
  });
  afterEach(() => {
    flushSettleChunks();
    vi.useRealTimers();
    uninstallTinyGeometryStubs();
    __ctmGraphRootEnabled = false;
    document.documentElement.style.removeProperty("--galaxy-0");
    vi.unstubAllGlobals();
  });

  it("renders SC names as path glyphs while a preview is set, and as text again when cleared", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 900, 700);
    document.body.appendChild(container);
    render(container, crowdedPayload("prev", 2, 4), { icons: iconsFor("prev") });
    flushSettleChunks();
    expect(container.querySelectorAll("text.supercluster-label").length).toBe(2);
    (window as W).__d3SetAlmagestPreview!(shippedParams());
    const groups = container.querySelectorAll("g.supercluster-label[data-almagest-preview='1']");
    expect(groups.length).toBe(2);
    expect(container.querySelectorAll("text.supercluster-label").length).toBe(0);
    for (const gEl of Array.from(groups)) {
      const paths = gEl.querySelectorAll("path");
      // "prev-sc0 extremely long supercluster name" -> 36-char cap, wrapped; every non-space char is one path
      const kw = gEl.closest("g.watermark")!.getAttribute("data-sc")!;
      const nonSpace = kw.slice(0, 36).replace(/\s/g, "").length;
      expect(paths.length).toBe(nonSpace);
      expect(gEl.getAttribute("transform")).toBeNull(); // positioned via child transforms, class kept on the group
      for (const p of Array.from(paths)) {
        // Review fix: theme.css's `.watermark path { stroke: var(--ink) }`
        // would otherwise put a hairline stroke on every glyph -- renderScName
        // kills it with an inline style (a presentation attribute would lose).
        expect((p as SVGPathElement).style.stroke).toBe("none");
      }
    }
    (window as W).__d3SetAlmagestPreview!(null);
    expect(container.querySelectorAll("text.supercluster-label").length).toBe(2);
    expect(container.querySelectorAll("g.supercluster-label").length).toBe(0);
  });

  it("preview glyph scale follows the painted font size: doubling the tuned stroke changes every path", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 900, 700);
    document.body.appendChild(container);
    render(container, crowdedPayload("prv2", 1, 4), { icons: iconsFor("prv2") });
    flushSettleChunks();
    const p = shippedParams();
    (window as W).__d3SetAlmagestPreview!(p);
    const d1 = Array.from(container.querySelectorAll("g.supercluster-label path")).map((e) => e.getAttribute("d"));
    p.tiers.Display.stroke *= 2; p.tiers.Mid.stroke *= 2; p.tiers.Text.stroke *= 2;
    (window as W).__d3SetAlmagestPreview!(p);
    const d2 = Array.from(container.querySelectorAll("g.supercluster-label path")).map((e) => e.getAttribute("d"));
    expect(d2.length).toBe(d1.length);
    expect(d2.some((d, i) => d !== d1[i])).toBe(true);
    (window as W).__d3SetAlmagestPreview!(null);
  });

  it("tints every SC nameplate by tier when __d3SetAlmagestTierTint is on, and clears back to CSS ink when off", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 900, 700);
    document.body.appendChild(container);
    render(container, crowdedPayload("tint", 2, 4), { icons: iconsFor("tint") });
    flushSettleChunks();
    const tintColors = ["#ff7a59", "#4fc3f7", "#c5e17a"].map(normalizedColor);
    const labels = () => Array.from(container.querySelectorAll("text.supercluster-label")) as SVGTextElement[];
    expect(labels().length).toBe(2);
    for (const el of labels()) expect(el.style.fill).toBe("");

    (window as W).__d3SetAlmagestTierTint!(true);
    expect(labels().length).toBe(2);
    for (const el of labels()) expect(tintColors).toContain(el.style.fill);

    (window as W).__d3SetAlmagestTierTint!(false);
    expect(labels().length).toBe(2);
    for (const el of labels()) expect(el.style.fill).toBe("");
  });
});
