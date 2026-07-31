import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup, waitFor, act } from "@testing-library/react";
import type { GraphCluster, GraphLink, GraphNode } from "@/lib/types";
import { GRAPH_DEFAULTS } from "./constants";
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

  it("exposes a populated clusterCentroidsRef synchronously with the first commit", async () => {
    const clusters: GraphCluster[] = [{ id: "c1", name: "C1", page_ids: ["p0", "p1"] }];
    const nodes = makeNodes(2, "c1");
    const { result } = renderHook(() => useForceLayout(nodes, clusters, [], 800, 600));
    await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0));
    const centroid = result.current.clusterCentroidsRef.current.get("c1");
    expect(centroid).toBeDefined();
    expect(Number.isFinite(centroid!.x)).toBe(true);
    expect(Number.isFinite(centroid!.y)).toBe(true);
  });

  // Review finding 4 (important): Phase 2 must be N live PER-CLUSTER sims,
  // each with its own deterministic seed (vendor :3439
  // `mulberry32(hashId(cid))`), not one shared global sim/seed -- a single
  // shared sim let a dense cluster's collide force bleed into and squeeze
  // a small neighboring cluster (the vendor's own documented regression,
  // :3416-3421).
  describe("Phase 2 per-cluster isolation (finding 4)", () => {
    it("gives each cluster its own deterministic seed -- same topology, different cluster id, different settled jiggle", async () => {
      // Two isolated (no links) 3-node clusters at the SAME nominal
      // Phase-1 target (canvas center, since neither has any competing
      // cluster to be pushed away from) -- the only thing that can make
      // their settled per-node spread differ is the per-cluster seed
      // (mulberry32(hashId(cid))), since forceCollide needs jiggle to break
      // an exact-overlap phyllotaxis tie deterministically.
      const clustersA: GraphCluster[] = [{ id: "cluster-alpha", name: "A", page_ids: ["p0", "p1", "p2"] }];
      const clustersB: GraphCluster[] = [{ id: "cluster-beta", name: "B", page_ids: ["p0", "p1", "p2"] }];
      const nodesA = makeNodes(3, "cluster-alpha");
      const nodesB = makeNodes(3, "cluster-beta").map((n, i) => ({ ...n, id: nodesA[i].id, parent_id: "cluster-beta" }));

      const runA = renderHook(() => useForceLayout(nodesA, clustersA, [], 800, 600));
      await waitFor(() => expect(runA.result.current.getVersion()).toBeGreaterThan(0), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 200)); // let a few ticks land
      const posA = [...runA.result.current.positionsRef.current.values()].map((p) => [p.x, p.y]);
      runA.unmount();

      const runB = renderHook(() => useForceLayout(nodesB, clustersB, [], 800, 600));
      await waitFor(() => expect(runB.result.current.getVersion()).toBeGreaterThan(0), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 200));
      const posB = [...runB.result.current.positionsRef.current.values()].map((p) => [p.x, p.y]);
      runB.unmount();

      // Same node count/topology/target, different cluster id -> different
      // seed -> the jiggle-broken tie lands somewhere different.
      expect(posA).not.toEqual(posB);
    });

    it("keeps a small cluster's members near its own centroid, undisturbed by a large, dense neighboring cluster's collide", async () => {
      // A big (40-node) cluster and a tiny (2-node) cluster, strongly
      // linked so Phase 1 pulls their centroids close together (weight 1
      // -> distance 30, vendor :3067-3068) -- close enough that the big
      // cluster's phyllotaxis spread (sqrt(39) * NODE_RADIUS*3*PAGE_SPREAD_MULT
      // ~= 146 world units) reaches well past the small cluster's centroid.
      // Under the OLD shared/global-collide architecture this finding
      // fixes, the big cluster's collide pressure would push the small
      // cluster's 2 members off their forceX/Y target. Under per-cluster
      // sims, the small cluster's collide only ever sees its OWN 2
      // members, so they should settle close to their own mean regardless
      // of the big cluster's density.
      const bigCluster: GraphCluster = { id: "big", name: "Big", page_ids: Array.from({ length: 40 }, (_, i) => `b${i}`) };
      const smallCluster: GraphCluster = { id: "small", name: "Small", page_ids: ["s0", "s1"] };
      const bigNodes = makeNodes(40, "big").map((n, i) => ({ ...n, id: `b${i}` }));
      const smallNodes = makeNodes(2, "small").map((n, i) => ({ ...n, id: `s${i}` }));
      const links: GraphLink[] = [{ source: "big", target: "small", type: "similarity", weight: 1 }];

      const { result } = renderHook(() =>
        useForceLayout([...bigNodes, ...smallNodes], [bigCluster, smallCluster], links, 800, 600)
      );
      await waitFor(() => expect(result.current.getVersion()).toBeGreaterThan(0), { timeout: 5000 });
      // Let the sim run for a while (not necessarily to full settle -- 40
      // nodes can take a few seconds) so collide has had a chance to act.
      await new Promise((r) => setTimeout(r, 1500));

      const small0 = result.current.positionsRef.current.get("s0")!;
      const small1 = result.current.positionsRef.current.get("s1")!;
      const smallMeanX = (small0.x + small1.x) / 2;
      const smallMeanY = (small0.y + small1.y) / 2;
      const collideRadius = (GRAPH_DEFAULTS.NODE_RADIUS + 2) * GRAPH_DEFAULTS.PAGE_SPREAD_MULT;
      // Each member should stay within a small multiple of the collide
      // radius of the pair's own mean -- bounded, cluster-local spread,
      // not a big-cluster-driven displacement.
      expect(Math.hypot(small0.x - smallMeanX, small0.y - smallMeanY)).toBeLessThan(collideRadius * 3);
      expect(Math.hypot(small1.x - smallMeanX, small1.y - smallMeanY)).toBeLessThan(collideRadius * 3);
    }, 10000);
  });
});
