"use client";

// Batch 03 (graph canvas port) Task S3 -- "A2: React-owned" sandbox spike.
//
// Runs the vendor's two-phase force layout (d3-graph-vendor.js
// `computeLayout`, :3018-3447) against the SANDBOX's live payload, adapted
// to a genuinely LIVE simulation instead of the vendor's "tick 400/150
// times synchronously, .stop(), render once" recipe -- see the header
// comment further down for why, and task-S3-report.md for the fuller
// rationale (this is the central architectural difference the F2 bake-off
// is measuring: A1 pops in fully laid out; A2 visibly settles, and every
// settle tick is a real React commit somewhere downstream).
//
// Exposure shape: a `positionsRef` (mutated in place, every tick) plus a
// tiny external-store pair (`subscribe`/`getVersion`) instead of React
// state. A `useState` counter here would make THIS hook's caller
// (GraphA2) re-render on every tick, and every one of ITS children along
// with it -- exactly the "reconciliation cost per tick" the bake-off
// wants isolated to the one component that actually needs new positions
// each frame. Consumers call `useSyncExternalStore(store.subscribe,
// store.getVersion)` themselves (see components/sandbox/GraphA2.tsx's
// PageDots/HullLabels) so ONLY that leaf re-renders per tick, not the
// whole sandbox (chip, Zoom, svg wrapper) riding along.
//
// The Web Worker mentioned in spec.md's F2 section ("Main thread paints
// positions... ref mutation for the hot path") is explicitly future work
// (task brief: "runs d3.forceSimulation in a useEffect for the SANDBOX --
// the Web Worker comes in a later task") -- this hook runs the sim on the
// main thread, same as A1.

import { useEffect, useMemo, useRef } from "react";
import type { GraphCluster, GraphLink, GraphNode } from "@/lib/types";
import { GRAPH_DEFAULTS } from "./constants";
import d3 from "./d3";
import { mulberry32 } from "./render-helpers";

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface ForceLayoutStore {
  /** React `useSyncExternalStore`-compatible subscribe: register `cb`, get
   *  an unsubscribe function back. Called once per animation frame that
   *  had at least one sim tick since the last call (rAF-batched). */
  subscribe: (cb: () => void) => () => void;
  /** Monotonically increasing counter -- `useSyncExternalStore`'s
   *  getSnapshot. Bumps once per notified frame; never resets while a
   *  layout is running. */
  getVersion: () => number;
  /** Mutable id -> {x,y} map. Always read AFTER a `getVersion()` change
   *  has been observed (the tick handler writes here synchronously before
   *  scheduling the notification that bumps the version), never on its
   *  own -- ref reads don't subscribe to re-renders. */
  positionsRef: React.RefObject<Map<string, LayoutPosition>>;
}

interface CentroidNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  index?: number;
}

interface Phase1Link {
  source: string;
  target: string;
  weight: number;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  index?: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // vendor :3401, ~137.508°
// Seeds shared by both phases -- a single constant (not vendor's per-
// cluster hashId(cid) seed, see the Phase-2 header comment below for why)
// keeps this hook's output reproducible across reloads, matching the
// vendor's own determinism goal (its comment at :2097-2104).
const PHASE1_SEED = 0xc0ffee; // vendor :3064
const PHASE2_SEED = 0xc0ffee;

/** Runs the vendor's Phase-1 cluster-centroid simulation to convergence,
 *  synchronously (vendor :3060-3075: forceLink + forceManyBody +
 *  forceCenter, alphaDecay 0.02, 400 manual ticks, then .stop()). Cluster
 *  centroids don't render directly -- they only seed where Phase 2's page
 *  nodes settle -- so there's no reason for this half to run live. */
function computeClusterCentroids(
  clusters: GraphCluster[],
  links: GraphLink[],
  width: number,
  height: number
): Map<string, LayoutPosition> {
  const clusterNodes: CentroidNode[] = clusters.map((c) => ({ id: c.id }));
  const clusterIdSet = new Set(clusterNodes.map((cn) => cn.id));
  const phase1Links: Phase1Link[] = links
    .filter((l) => clusterIdSet.has(l.source) && clusterIdSet.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, weight: l.weight }));

  const sim1 = d3
    .forceSimulation<CentroidNode, Phase1Link>(clusterNodes)
    .randomSource(mulberry32(PHASE1_SEED))
    .force(
      "link",
      d3
        .forceLink<CentroidNode, Phase1Link>(phase1Links)
        .id((d) => d.id)
        .distance((l) => 30 + 120 * (1 - l.weight))
        .strength((l) => l.weight * l.weight * l.weight)
    )
    .force("charge", d3.forceManyBody().strength(-80).distanceMax(300))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .alphaDecay(0.02)
    .stop();

  for (let t = 0; t < 400; t++) sim1.tick();

  const centroids = new Map<string, LayoutPosition>();
  clusterNodes.forEach((cn) => {
    centroids.set(cn.id, { x: cn.x ?? width / 2, y: cn.y ?? height / 2 });
  });
  return centroids;
}

/** Phyllotaxis seed for one node within its cluster (vendor :3400-3413):
 *  spiral outward from the cluster centroid, golden-angle spaced. `i` is
 *  the node's running index within its cluster (assignment order, not
 *  global). */
function phyllotaxisSeed(centroid: LayoutPosition, i: number): LayoutPosition {
  const r = Math.sqrt(i) * (GRAPH_DEFAULTS.NODE_RADIUS * 3 * GRAPH_DEFAULTS.PAGE_SPREAD_MULT);
  const theta = i * GOLDEN_ANGLE;
  return { x: centroid.x + r * Math.cos(theta), y: centroid.y + r * Math.sin(theta) };
}

/**
 * Two-phase force layout for the A2 sandbox.
 *
 * Phase 1 (cluster centroids) runs synchronously to convergence, exactly
 * mirroring the vendor's own math/parameters -- see computeClusterCentroids
 * above.
 *
 * Phase 2 (page nodes) is where A2 diverges from the vendor by design: the
 * vendor runs ONE d3.forceSimulation PER CLUSTER (:3429-3446, each stopped
 * and manually ticked 150 times) specifically so a dense cluster's collide
 * force can't push into a neighboring cluster's nodes. This hook instead
 * runs ONE global, LIVE simulation across every page node -- forceX/forceY
 * pull each node toward its own cluster's Phase-1 centroid (same strength,
 * 0.3), one shared forceCollide enforces the same per-node spacing, same
 * alphaDecay (0.05). Consequences of merging N simulations into one,
 * explicitly accepted for this spike:
 *   - Cluster isolation is no longer guaranteed -- on a dense dataset with
 *     many small, nearby clusters, collide can push a node from one
 *     cluster into a neighboring cluster's territory (the exact failure
 *     mode the vendor's per-cluster split was written to prevent, see its
 *     comment at :3416-3421). Not expected to be visually dramatic given
 *     forceX/forceY's 0.3 strength keeps every node anchored near its own
 *     centroid, but it is a known, undemonstrated gap vs A1.
 *   - It's also the more idiomatic "d3-force in React" shape (one
 *     simulation driving one position store), and the one that lets this
 *     hook expose a SINGLE live sim to subscribe to, which is what the
 *     rAF-batched version counter above is for.
 *
 * Unlike the vendor (and A1), Phase 2 is never `.stop()`'d after seeding --
 * it runs live via d3-force's own internal timer until alpha decays below
 * alphaMin, notifying subscribers at most once per animation frame the
 * whole time. The FIRST commit (right after the phyllotaxis seed, before
 * the first real tick) is what onFirstPaint in GraphA2 fires on -- "first
 * dots" is the seeded scatter, not the settled layout.
 */
export interface UseForceLayoutCallbacks {
  /** Fired synchronously, once, right after the first commit (the
   *  phyllotaxis seed) -- before the sim has ticked at all. GraphA2 wires
   *  this to its onFirstPaint prop directly rather than subscribing to
   *  the store itself, so the top-level sandbox component never re-
   *  renders on tick -- only the leaf components that call
   *  useSyncExternalStore(store.subscribe, ...) do (see PageDots/
   *  HullLabels in components/sandbox/GraphA2.tsx). */
  onFirstPaint?: () => void;
  /** Fired once alpha decays below alphaMin and the sim's internal timer
   *  stops. */
  onSettle?: () => void;
}

export function useForceLayout(
  nodes: GraphNode[],
  clusters: GraphCluster[],
  links: GraphLink[],
  width: number,
  height: number,
  callbacks?: UseForceLayoutCallbacks
): ForceLayoutStore {
  const positionsRef = useRef<Map<string, LayoutPosition>>(new Map());
  const versionRef = useRef(0);
  const listenersRef = useRef(new Set<() => void>());
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const store = useMemo<ForceLayoutStore>(
    () => ({
      subscribe: (cb) => {
        listenersRef.current.add(cb);
        return () => listenersRef.current.delete(cb);
      },
      getVersion: () => versionRef.current,
      positionsRef,
    }),
    []
  );

  useEffect(() => {
    if (!nodes.length || width <= 0 || height <= 0) return;

    let cancelled = false;
    let rafHandle: number | null = null;

    function notify() {
      versionRef.current += 1;
      listenersRef.current.forEach((cb) => cb());
    }

    function scheduleNotify() {
      if (rafHandle != null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        if (!cancelled) notify();
      });
    }

    // Fresh map every effect run (StrictMode double-invoke, or a genuine
    // data change) -- no stale ids from a previous mount linger.
    const positions = new Map<string, LayoutPosition>();
    positionsRef.current = positions;

    const centroids = computeClusterCentroids(clusters, links, width, height);

    const clusterCounters = new Map<string, number>();
    const workingNodes: SimNode[] = nodes.map((n) => {
      const cid = n.parent_id;
      // vendor :3406's fallback for an orphaned/unmatched parent_id.
      if (cid == null) return { ...n, x: width / 2, y: height / 2 };
      const centroid = centroids.get(cid);
      if (!centroid) return { ...n, x: width / 2, y: height / 2 };
      const i = clusterCounters.get(cid) ?? 0;
      clusterCounters.set(cid, i + 1);
      const seed = phyllotaxisSeed(centroid, i);
      return { ...n, x: seed.x, y: seed.y };
    });

    function flush() {
      workingNodes.forEach((n) => {
        positions.set(n.id, { x: n.x, y: n.y });
      });
    }

    const collideRadius = (GRAPH_DEFAULTS.NODE_RADIUS + 2) * GRAPH_DEFAULTS.PAGE_SPREAD_MULT;
    const sim = d3
      .forceSimulation<SimNode>(workingNodes)
      .force(
        "x",
        d3.forceX<SimNode>((d) => {
          const cid = d.parent_id;
          const c = cid != null ? centroids.get(cid) : undefined;
          return c ? c.x : width / 2;
        }).strength(0.3)
      )
      .force(
        "y",
        d3.forceY<SimNode>((d) => {
          const cid = d.parent_id;
          const c = cid != null ? centroids.get(cid) : undefined;
          return c ? c.y : height / 2;
        }).strength(0.3)
      )
      .force("collide", d3.forceCollide<SimNode>(collideRadius))
      .alphaDecay(0.05)
      .randomSource(mulberry32(PHASE2_SEED))
      .stop();

    // First commit -- "first dots" -- is the phyllotaxis seed, synchronous
    // with mount, before the sim has ticked at all.
    flush();
    notify();
    callbacksRef.current?.onFirstPaint?.();

    sim.on("tick", () => {
      flush();
      scheduleNotify();
    });
    sim.on("end", () => {
      flush();
      scheduleNotify();
      if (!cancelled) callbacksRef.current?.onSettle?.();
    });
    sim.restart();

    return () => {
      cancelled = true;
      sim.stop();
      sim.on("tick", null);
      sim.on("end", null);
      if (rafHandle != null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nodes`/
    // `clusters`/`links` are the sandbox's one-shot fetched payload
    // (stable identity for the component's lifetime, same as GraphA1's
    // mount-once contract); re-running this effect on every render would
    // restart the simulation.
  }, [nodes, clusters, links, width, height]);

  return store;
}
