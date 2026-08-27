import { describe, it, expect, vi, beforeEach } from "vitest";

// Task group C (batch 03): unit tests for the chat<->graph interop helpers
// -- the pure/DOM-measurement logic underlying C1 (cluster-cite framing,
// search_stream.js's highlightClusters/computeVisibleGraphHeight,
// :298-333 at explorer 4bb0a64) and C2 (source-pill locate glyph,
// makeLocatePillGroup/frameSourceNode, :190-232/:347-350). The vendor
// module is mocked per-test via vi.doMock + vi.resetModules so both the
// "module absent" and "module present" paths are exercised without a real
// D3/SVG environment (same convention GraphCanvas.test.tsx uses for the
// same module). hooks/useAgentChat.test.ts and components/SearchBar.test.tsx
// separately cover the WIRING (that a complete event / a rendered source
// pill actually calls into this module) against a mocked chat-interop.

const VENDOR_PATH = "@/lib/graph/d3-graph-vendor.js";

async function freshInterop() {
  vi.resetModules();
  return import("./chat-interop");
}

describe("computeVisibleGraphHeight", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("subtracts the search-bar overlay height from the container height (port of search_stream.js:298-305)", async () => {
    const { computeVisibleGraphHeight } = await freshInterop();
    const container = document.createElement("div");
    container.id = "d3-graph-container";
    Object.defineProperty(container, "offsetHeight", { value: 600, configurable: true });
    const bar = document.createElement("div");
    bar.id = "search-bar";
    Object.defineProperty(bar, "offsetHeight", { value: 120, configurable: true });
    document.body.append(container, bar);

    expect(computeVisibleGraphHeight()).toBe(480);
  });

  it("falls back to 600 for a missing container, and floors the result at 200 when the bar dominates", async () => {
    const { computeVisibleGraphHeight } = await freshInterop();
    const bar = document.createElement("div");
    bar.id = "search-bar";
    Object.defineProperty(bar, "offsetHeight", { value: 550, configurable: true });
    document.body.append(bar);

    // 600 (fallback) - 550 = 50, which is < 100, so the 200 floor applies
    // -- exact port of Dash's `if (visibleH < 100) visibleH = 200;`.
    expect(computeVisibleGraphHeight()).toBe(200);
  });

  it("returns the raw container height when the search bar is absent", async () => {
    const { computeVisibleGraphHeight } = await freshInterop();
    const container = document.createElement("div");
    container.id = "d3-graph-container";
    Object.defineProperty(container, "offsetHeight", { value: 400, configurable: true });
    document.body.append(container);

    expect(computeVisibleGraphHeight()).toBe(400);
  });
});

describe("frameCitedClusters (C1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("unions member node ids across cited clusters and frames them with the measured visible height", async () => {
    const getClusterPages = vi.fn((clusterId: string) =>
      clusterId === "cluster-a" ? ["node-1", "node-2"] : ["node-2", "node-3"]
    );
    const frameNodes = vi.fn();
    vi.doMock(VENDOR_PATH, () => ({ getClusterPages, hasNode: vi.fn(), frameNodes }));
    const { frameCitedClusters } = await freshInterop();

    await frameCitedClusters(["cluster-a", "cluster-b"]);

    expect(getClusterPages).toHaveBeenCalledWith("cluster-a");
    expect(getClusterPages).toHaveBeenCalledWith("cluster-b");
    expect(frameNodes).toHaveBeenCalledTimes(1);
    const [nodeIds, visibleH] = frameNodes.mock.calls[0];
    expect(nodeIds).toEqual(["node-1", "node-2", "node-3"]); // deduped, first-seen order
    expect(visibleH).toBe(600); // no #d3-graph-container/#search-bar in jsdom here -> fallback
  });

  it("no-ops on an empty/undefined cluster_ids list without importing the vendor module", async () => {
    const { frameCitedClusters } = await freshInterop();
    await expect(frameCitedClusters(undefined)).resolves.toBeUndefined();
    await expect(frameCitedClusters([])).resolves.toBeUndefined();
  });

  it("no-ops when every cited cluster resolves to zero pages", async () => {
    const frameNodes = vi.fn();
    vi.doMock(VENDOR_PATH, () => ({
      getClusterPages: vi.fn(() => []),
      hasNode: vi.fn(),
      frameNodes,
    }));
    const { frameCitedClusters } = await freshInterop();

    await frameCitedClusters(["empty-cluster"]);

    expect(frameNodes).not.toHaveBeenCalled();
  });

  it("no-ops gracefully when the graph module has not exported getClusterPages/frameNodes yet (absent/not-yet-loaded)", async () => {
    // Explicit `undefined` (not an omitted key): vitest's mocked module
    // namespace throws "no such export" on an outright-missing key
    // (mirroring real ESM's static export list), so this simulates a
    // stale/partial module build the same way an omitted key would at
    // runtime -- the export exists on the namespace but resolves to
    // undefined.
    vi.doMock(VENDOR_PATH, () => ({ getClusterPages: undefined, hasNode: undefined, frameNodes: undefined }));
    const { frameCitedClusters } = await freshInterop();

    await expect(frameCitedClusters(["cluster-a"])).resolves.toBeUndefined();
  });

  it("no-ops gracefully when the dynamic import itself rejects (module genuinely unavailable)", async () => {
    vi.doMock(VENDOR_PATH, () => {
      throw new Error("chunk load failed");
    });
    const { frameCitedClusters } = await freshInterop();

    await expect(frameCitedClusters(["cluster-a"])).resolves.toBeUndefined();
  });
});

describe("hasGraphNode (C2)", () => {
  it("resolves the vendor's hasNode() result", async () => {
    vi.doMock(VENDOR_PATH, () => ({ hasNode: vi.fn((id: string) => id === "known-node") }));
    const { hasGraphNode } = await freshInterop();

    await expect(hasGraphNode("known-node")).resolves.toBe(true);
    await expect(hasGraphNode("missing-node")).resolves.toBe(false);
  });

  it("resolves false when the graph module is absent/not yet loaded", async () => {
    vi.doMock(VENDOR_PATH, () => ({ hasNode: undefined }));
    const { hasGraphNode } = await freshInterop();

    await expect(hasGraphNode("any-node")).resolves.toBe(false);
  });

  it("resolves false when the dynamic import rejects", async () => {
    vi.doMock(VENDOR_PATH, () => {
      throw new Error("chunk load failed");
    });
    const { hasGraphNode } = await freshInterop();

    await expect(hasGraphNode("any-node")).resolves.toBe(false);
  });
});

describe("frameSourceNode (C2 click handler)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("frames the single node with the measured visible height (port of search_stream.js:347-350)", async () => {
    const frameNodes = vi.fn();
    vi.doMock(VENDOR_PATH, () => ({ frameNodes, hasNode: vi.fn(), getClusterPages: vi.fn() }));
    const { frameSourceNode } = await freshInterop();

    await frameSourceNode("node-7");

    expect(frameNodes).toHaveBeenCalledWith(["node-7"], 600);
  });

  it("no-ops gracefully when the graph module is absent", async () => {
    vi.doMock(VENDOR_PATH, () => ({ frameNodes: undefined }));
    const { frameSourceNode } = await freshInterop();

    await expect(frameSourceNode("node-7")).resolves.toBeUndefined();
  });
});
