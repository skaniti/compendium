import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GraphPayload } from "@/lib/types";
import { createSimEngine } from "@/lib/graph/sim-layout";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "@/lib/graph/sim-protocol";

// Header comment delta #41: page-title labels are opt-in (default OFF) via
// the exported setPageTitles(show), and the cluster-name layer paints above
// the page-title layer. Drives the REAL vendor render() in jsdom, same
// strategy as d3-graph-vendor.remount.test.ts (synchronous fake sim worker,
// getScreenCTM stub). jsdom also has no getBBox, and updatePageTitleLabels
// treats an unmeasurable label as hidden, so a fixed-size getBBox is stubbed
// here too -- otherwise "titles appear" could never be observed.
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

const PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "page-1",
      label: "Synthetic Page Title",
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/1"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

function sizeContainer(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON() { return {}; } }) as DOMRect;
}

function zoomInPastTitleThreshold(container: HTMLElement): void {
  const svgEl = container.querySelector("svg")!;
  // Each Ctrl+wheel notch zooms in by at most 2^0.5 (delta #35); 4 notches
  // is ~4x, comfortably past PAGE_TITLE_LOD_K_MIN (1.6x the fit zoom).
  for (let i = 0; i < 4; i++) {
    svgEl.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
  }
}

// The cull that fades titles in is debounced (scheduleLabelCull, 90ms).
const waitForCull = () => new Promise((resolve) => setTimeout(resolve, 150));

function visibleTitles(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("text.page-title-label")).filter(
    (el) => parseFloat((el as SVGElement).style.opacity || "0") > 0,
  );
}

describe("d3-graph-vendor page titles (header comment delta #41)", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", SyncFakeSimWorker);
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    proto.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix;
    proto.getBBox = () => ({ x: 100, y: 100, width: 40, height: 10 });
  });

  afterEach(() => {
    flushSettleChunks();
    document.documentElement.style.removeProperty("--galaxy-0");
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    delete proto.getScreenCTM;
    delete proto.getBBox;
    vi.unstubAllGlobals();
  });

  async function mount(show: boolean | null) {
    const vendor = await import("@/lib/graph/d3-graph-vendor.js");
    const container = document.createElement("div");
    sizeContainer(container, 1100, 850);
    document.body.appendChild(container);
    if (show !== null) vendor.setPageTitles(show);
    vendor.render(container, PAYLOAD, {});
    flushSettleChunks();
    return { vendor, container };
  }

  it("is OFF by default: no page-title element is drawn, even zoomed in", async () => {
    // Module state persists across tests, so pin the default explicitly by
    // re-importing a fresh module instance.
    vi.resetModules();
    const { container } = await mount(null);
    zoomInPastTitleThreshold(container);
    await waitForCull();
    expect(container.querySelectorAll("text.page-title-label").length).toBe(0);
  });

  it("setPageTitles(false) draws nothing at a zoom ratio above 1.6", async () => {
    const { container } = await mount(false);
    zoomInPastTitleThreshold(container);
    await waitForCull();
    expect(container.querySelectorAll("text.page-title-label").length).toBe(0);
    expect(visibleTitles(container)).toHaveLength(0);
  });

  it("setPageTitles(true) shows titles once zoomed past the threshold", async () => {
    const { container } = await mount(true);
    expect(container.querySelectorAll("text.page-title-label").length).toBe(1);
    zoomInPastTitleThreshold(container);
    await waitForCull();
    expect(visibleTitles(container)).toHaveLength(1);
  });

  it("flipping the setting on the live graph adds and removes titles without a new render()", async () => {
    const { vendor, container } = await mount(false);
    zoomInPastTitleThreshold(container);
    await waitForCull();
    expect(container.querySelectorAll("text.page-title-label").length).toBe(0);

    vendor.setPageTitles(true);
    await waitForCull();
    expect(visibleTitles(container)).toHaveLength(1);

    vendor.setPageTitles(false);
    expect(container.querySelectorAll("text.page-title-label").length).toBe(0);
  });

  it("paints the cluster-name layer above the page-title layer in both render branches", async () => {
    const { vendor, container } = await mount(true);
    const order = () =>
      Array.from(container.querySelectorAll(".graph-root > g")).map((g) => g.getAttribute("class"));
    const first = order();
    expect(first.indexOf("hull-labels")).toBeGreaterThan(first.indexOf("singleton-labels"));

    // Same container again takes the re-render branch (layers rebuilt).
    vendor.render(container, PAYLOAD, {});
    flushSettleChunks();
    const second = order();
    expect(second.indexOf("hull-labels")).toBeGreaterThan(second.indexOf("singleton-labels"));
  });
});
