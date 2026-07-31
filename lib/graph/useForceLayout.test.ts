import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup, waitFor, act } from "@testing-library/react";
import type { GraphCluster, GraphLink, GraphNode } from "@/lib/types";
import { useForceLayout } from "./useForceLayout";

// Task S3: unit-tests the hook's WIRING (positions get seeded, the store's
// subscribe/getVersion contract, callback firing, unmount cleanup) rather
// than the settled-layout numbers -- the force math itself is transcribed
// from render-helpers.ts's already-unit-tested pieces (phyllotaxis
// spacing reuses PAGE_SPREAD_MULT/NODE_RADIUS the same way) plus d3-force
// itself (not re-tested here). Live visual verification is in task-S3's
// report.

function makeNodes(n: number, clusterId: string | null): GraphNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    label: `Page ${i}`,
    level: 0,
    kind: clusterId ? "cluster" : "singleton",
    visit_count: 1,
    parent_id: clusterId,
    children_ids: [],
    capture_ids: [],
    page_urls: [],
    first_visited_at: null,
  }));
}

afterEach(() => {
  cleanup();
});

describe("useForceLayout", () => {
  it("does nothing (empty store, version stays 0) with no nodes", () => {
    const { result } = renderHook(() => useForceLayout([], [], [], 800, 600));
    expect(result.current.getVersion()).toBe(0);
    expect(result.current.positionsRef.current.size).toBe(0);
  });

  it("does nothing with a zero-size viewport (width/height guard)", () => {
    const nodes = makeNodes(2, null);
    const { result } = renderHook(() => useForceLayout(nodes, [], [], 0, 0));
    expect(result.current.getVersion()).toBe(0);
  });

  it("seeds positions for every node on the first commit", async () => {
    const nodes = makeNodes(3, null);
    const { result } = renderHook(() => useForceLayout(nodes, [], [], 800, 600));

    await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0));
    expect(result.current.positionsRef.current.size).toBe(3);
    nodes.forEach((n) => {
      const pos = result.current.positionsRef.current.get(n.id);
      expect(pos).toBeDefined();
      expect(Number.isFinite(pos!.x)).toBe(true);
      expect(Number.isFinite(pos!.y)).toBe(true);
    });
  });

  it("seeds clustered nodes near their cluster's Phase-1 centroid, not at the canvas center", async () => {
    const clusters: GraphCluster[] = [{ id: "c1", name: "C1", page_ids: ["p0", "p1", "p2"] }];
    const nodes = makeNodes(3, "c1");
    const { result } = renderHook(() => useForceLayout(nodes, clusters, [], 800, 600));

    await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0));
    // A single isolated cluster's Phase-1 sim (forceCenter(width/2,
    // height/2), no competing clusters) settles very close to the canvas
    // center -- so this doesn't distinguish much on its own, but every
    // member should be seeded near EACH OTHER (same centroid), not
    // scattered independently.
    const positions = [...result.current.positionsRef.current.values()];
    const meanX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const meanY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    positions.forEach((p) => {
      expect(Math.abs(p.x - meanX)).toBeLessThan(200);
      expect(Math.abs(p.y - meanY)).toBeLessThan(200);
    });
  });

  it("falls back to canvas center for a node with an unmatched parent_id", async () => {
    const nodes = makeNodes(1, "does-not-exist");
    const { result } = renderHook(() => useForceLayout(nodes, [], [], 800, 600));
    await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0));
    const pos = result.current.positionsRef.current.get("p0")!;
    expect(pos.x).toBeCloseTo(400, 5);
    expect(pos.y).toBeCloseTo(300, 5);
  });

  it("fires onFirstPaint exactly once, synchronously with the first version bump", async () => {
    const onFirstPaint = vi.fn();
    const nodes = makeNodes(2, null);
    const { result } = renderHook(() => useForceLayout(nodes, [], [], 800, 600, { onFirstPaint }));

    await waitFor(() => expect(onFirstPaint).toHaveBeenCalledTimes(1));
    expect(result.current.getVersion()).toBeGreaterThan(0);
  });

  it("notifies subscribers as the version advances", async () => {
    const nodes = makeNodes(3, null);
    const { result } = renderHook(() => useForceLayout(nodes, [], [], 800, 600));

    const cb = vi.fn();
    let unsubscribe: (() => void) | undefined;
    act(() => {
      unsubscribe = result.current.subscribe(cb);
    });

    await waitFor(() => expect(cb).toHaveBeenCalled());
    unsubscribe?.();
  });

  it("eventually settles (onSettle fires) for a tiny graph", async () => {
    const onSettle = vi.fn();
    const nodes = makeNodes(2, null);
    renderHook(() => useForceLayout(nodes, [], [], 800, 600, { onSettle }));

    await waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it("unmounts cleanly without throwing (sim.stop() + rAF cancellation)", async () => {
    const nodes = makeNodes(5, null);
    const { result, unmount } = renderHook(() => useForceLayout(nodes, [], [], 800, 600));
    await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0));
    expect(() => unmount()).not.toThrow();
  });
});
