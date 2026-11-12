import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload } from "@/lib/types";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";

// Header comment delta #43: group collapse is OFF (GROUP_COLLAPSE_ENABLED).
// A casual/binge group renders in its expanded state with no caption and no
// knot, and every member cluster draws its own hull label. Drives the REAL
// vendor render() in jsdom with a synchronous fake sim worker, same strategy
// as d3-graph-vendor.page-titles.test.ts. Data is synthetic.
class SyncFakeSimWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  static lastStart: SimStartPayload | null = null;
  constructor(_scriptURL?: unknown, _options?: unknown) {}
  postMessage(message: MainToWorkerMessage): void {
    if (message.type !== "start") return;
    SyncFakeSimWorker.lastStart = message as SimStartPayload;
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

function page(id: string, parent: string): GraphPayload["nodes"][number] {
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

// One group that would collapse today (tier casual, two member clusters)
// plus one ungrouped cluster.
function groupPayload(): GraphPayload {
  return {
    nodes: [
      page("p1", "solo"), page("p2", "solo"), page("p3", "solo"),
      page("p4", "a"), page("p5", "a"), page("p6", "a"),
      page("p7", "b"), page("p8", "b"), page("p9", "b"),
    ],
    links: [],
    clusters: [
      { id: "solo", name: "Solo Cluster", page_ids: ["p1", "p2", "p3"] },
      { id: "a", name: "Member Alpha", page_ids: ["p4", "p5", "p6"], group_id: 7, group_tier: "casual", group_label: "Test Group" },
      { id: "b", name: "Member Beta", page_ids: ["p7", "p8", "p9"], group_id: 7, group_tier: "casual", group_label: "Test Group" },
    ],
    super_clusters: [],
    groups: [],
  };
}

function sizeContainer(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
}

function hullLabelText(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("text.hull-label")).map((t) => t.textContent ?? "");
}

describe("d3-graph-vendor group collapse switch (header comment delta #43)", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    SyncFakeSimWorker.lastStart = null;
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    proto.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
    proto.getBBox = () => ({ x: 100, y: 100, width: 40, height: 10 });
  });

  afterEach(async () => {
    (await import("@/lib/graph/d3-graph-vendor.js")).setGroupCollapseEnabled(false);
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    delete proto.getScreenCTM;
    delete proto.getBBox;
    vi.unstubAllGlobals();
  });

  async function mount(collapseOn: boolean) {
    const vendor = await import("@/lib/graph/d3-graph-vendor.js");
    vendor.setGroupCollapseEnabled(collapseOn);
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);
    vendor.render(container, groupPayload(), {});
    flushSettleChunks();
    return { vendor, container };
  }

  it("is off by default: no group caption, no knot hit-target, each member cluster has its own name", async () => {
    vi.resetModules();
    const vendor = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);
    vendor.render(container, groupPayload(), {});
    flushSettleChunks();
    expect(container.querySelectorAll("text.group-label").length).toBe(0);
    expect(container.querySelectorAll("g.group-label-group").length).toBe(0);
    expect(container.querySelectorAll("circle.knot-hit").length).toBe(0);
    const names = hullLabelText(container).join(" | ");
    expect(names).toContain("Member Alpha");
    expect(names).toContain("Member Beta");
    expect(names).toContain("Solo Cluster");
    expect(container.textContent).not.toContain("Test Group");
  });

  it("tells the layout worker not to pack the group", async () => {
    await mount(false);
    expect(SyncFakeSimWorker.lastStart?.groupCollapse).toBe(false);
  });

  it("toggleGroupExpansion-style state stays untouched: no expandedGroups entry is written", async () => {
    const { vendor } = await mount(false);
    expect(Object.keys(vendor.expandedGroups)).toHaveLength(0);
  });

  it("with the switch on, the July machinery is back: a caption and no member hull labels", async () => {
    const { container } = await mount(true);
    expect(SyncFakeSimWorker.lastStart?.groupCollapse).toBe(true);
    expect(container.querySelectorAll("text.group-label").length).toBe(1);
    const names = hullLabelText(container).join(" | ");
    expect(names).not.toContain("Member Alpha");
    expect(names).toContain("Solo Cluster");
  });

  it("with the switch on, turning it off and re-rendering leaves no caption behind", async () => {
    const { vendor, container } = await mount(true);
    expect(container.querySelectorAll("text.group-label").length).toBe(1);
    vendor.setGroupCollapseEnabled(false);
    vendor.render(container, groupPayload(), {});
    flushSettleChunks();
    expect(container.querySelectorAll("text.group-label").length).toBe(0);
  });
});
