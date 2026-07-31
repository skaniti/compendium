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
import { hashId, mulberry32 } from "./render-helpers";

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
  /** Cluster id -> Phase-1/1.5/1.75 centroid (the SC-aware macro layout,
   *  computed once, synchronously, before Phase 2 ever seeds a page node).
   *  Populated at the same instant as the first `positionsRef` commit
   *  (never mutates afterward) -- consumers that want a STABLE, one-shot
   *  cluster position (e.g. GraphA2.tsx's hull-label color map, review
   *  finding 6) should read this instead of re-deriving centroids from the
   *  live, per-tick page-node positions. */
  clusterCentroidsRef: React.RefObject<Map<string, LayoutPosition>>;
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
const PHASE1_SEED = 0xc0ffee; // vendor :3064

// ── Shrinkwrap-estimate geometry for the Phase 1.5/1.5a/1.5b/1.75 SC
// layout passes (vendor :1751-2010) ───────────────────────────────────
// Pure AABB/circle-overlap estimators the vendor's SC ring-placement and
// non-member-ejection passes use to keep clusters clear of super-cluster
// halos, before any page node has a real rendered position. The vendor
// also consults a DOM-measured `labelDimsCache` (populated by
// measureLabelDims, a nebula/watermark-rendering concern this sandbox
// never triggers -- see render-helpers.ts's computeHullLabelLayout
// comment for the same nebula/watermark scope cut) -- since that cache is
// always empty here, these ports go straight to the vendor's own
// char-width-estimate fallback branch (still 1:1 vendor math; it's the
// only branch ever reachable in this sandbox).
const SHRINKWRAP_PAD = 8; // vendor :1751
const LABEL_LINE_HEIGHT_ESTIMATE = 12; // vendor :1752
const LABEL_CHAR_WIDTH_ESTIMATE = 6; // vendor :1753
const LABEL_WRAP_CHARS = 18; // vendor :1754

interface Rect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** vendor :1767-1780. */
function estimateLabelLines(name: string, maxChars: number): string[] {
  const words = (name || "").split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > maxChars && cur.length > 0) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function maxLineLen(lines: string[]): number {
  return lines.reduce((m, l) => Math.max(m, l.length), 0);
}

/** vendor :1815-1836 (char-width-estimate branch only -- see header note
 *  above; `labelDimsCache` is never populated in this sandbox). */
function estimateLabelBBox(name: string, anchorX: number, anchorY: number): Rect & { w: number; h: number } {
  const lines = estimateLabelLines(name, LABEL_WRAP_CHARS);
  const w = maxLineLen(lines) * LABEL_CHAR_WIDTH_ESTIMATE;
  const h = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
  return { minX: anchorX - w / 2, maxX: anchorX + w / 2, minY: anchorY - h / 2, maxY: anchorY + h / 2, w, h };
}

/** vendor :1848-1873 (char-width-estimate branch only). */
function estimateClusterShrinkwrap(cluster: GraphCluster, centroidX: number, centroidY: number): Rect {
  const n = cluster.page_ids.length || 1;
  const nodeSpread = Math.sqrt(n) * 9;
  const lines = estimateLabelLines(cluster.name || "", LABEL_WRAP_CHARS);
  const labelW = maxLineLen(lines) * LABEL_CHAR_WIDTH_ESTIMATE;
  const labelH = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
  const GAP = 8; // vendor :1863
  const halfW = Math.max(nodeSpread, labelW / 2);
  return {
    minX: centroidX - halfW - SHRINKWRAP_PAD,
    maxX: centroidX + halfW + SHRINKWRAP_PAD,
    minY: centroidY - nodeSpread - GAP - labelH - SHRINKWRAP_PAD,
    maxY: centroidY + nodeSpread + SHRINKWRAP_PAD,
  };
}

/** vendor :1919-1958. */
function computeWatermarkBBox(scKeyword: string, scCentroid: LayoutPosition): Rect {
  const ICON_SIZE = 160; // vendor :1920
  const SC_NAME_FONT_SIZE = 30; // vendor :1928
  const SC_NAME_LINE_HEIGHT = SC_NAME_FONT_SIZE * 1.15; // vendor :1929
  const SC_NAME_CHAR_WIDTH = 17; // vendor :1932
  const nameText = (scKeyword || "").slice(0, 36);
  const lines = estimateLabelLines(nameText, 14);
  const nameH = lines.length * SC_NAME_LINE_HEIGHT;
  const nameW = maxLineLen(lines) * SC_NAME_CHAR_WIDTH;
  const halfIcon = ICON_SIZE / 2;
  const nameTopY = scCentroid.y + halfIcon + GRAPH_DEFAULTS.SC_LABEL_TOP_PAD;
  const iconMinX = scCentroid.x - halfIcon;
  const iconMaxX = scCentroid.x + halfIcon;
  const nameMinX = scCentroid.x - nameW / 2;
  const nameMaxX = scCentroid.x + nameW / 2;
  return {
    minX: Math.min(iconMinX, nameMinX) - SHRINKWRAP_PAD,
    maxX: Math.max(iconMaxX, nameMaxX) + SHRINKWRAP_PAD,
    minY: scCentroid.y - halfIcon - SHRINKWRAP_PAD,
    maxY: nameTopY + nameH + SHRINKWRAP_PAD,
  };
}

interface CircleOverlap {
  overlap: boolean;
  nx?: number;
  ny?: number;
  penetration?: number;
}

/** vendor :1968-1988. */
function rectCircleOverlap(rect: Rect, cx: number, cy: number, r: number): CircleOverlap {
  const closestX = Math.max(rect.minX, Math.min(cx, rect.maxX));
  const closestY = Math.max(rect.minY, Math.min(cy, rect.maxY));
  const dx = closestX - cx;
  const dy = closestY - cy;
  const distSq = dx * dx + dy * dy;
  if (distSq >= r * r) return { overlap: false };
  const dist = Math.sqrt(distSq);
  const penetration = r - dist;
  if (dist < 1e-6) return { overlap: true, nx: 1, ny: 0, penetration: r };
  return { overlap: true, nx: dx / dist, ny: dy / dist, penetration };
}

interface RectOverlap {
  overlap: boolean;
  overlapX?: number;
  overlapY?: number;
  dx?: number;
  dy?: number;
}

/** vendor :1994-2010. */
function rectRectOverlap(a: Rect, b: Rect, pad = 0): RectOverlap {
  const ax = (a.minX + a.maxX) / 2,
    ay = (a.minY + a.maxY) / 2;
  const bx = (b.minX + b.maxX) / 2,
    by = (b.minY + b.maxY) / 2;
  const halfAw = (a.maxX - a.minX) / 2,
    halfAh = (a.maxY - a.minY) / 2;
  const halfBw = (b.maxX - b.minX) / 2,
    halfBh = (b.maxY - b.minY) / 2;
  const overlapX = halfAw + halfBw + pad - Math.abs(ax - bx);
  const overlapY = halfAh + halfBh + pad - Math.abs(ay - by);
  if (overlapX <= 0 || overlapY <= 0) return { overlap: false };
  return { overlap: true, overlapX, overlapY, dx: ax - bx, dy: ay - by };
}

/** Vendor Phase 1.5b (inter-SC repel) + 1.5a (ring placement) + 1.75
 *  (non-member ejection) -- :3077-3343. Mutates `clusterNodes`' x/y in
 *  place, exactly like the vendor. A no-op when the dataset has no
 *  super-clusters (matches the vendor's own
 *  `if (Object.keys(superClusterGroups).length > 0)` gate, :3088).
 *
 *  "Phase 1.5" itself (the comment header at :3077-3079, "gentle
 *  super-cluster attraction" via a documented but unused `SC_STRENGTH`)
 *  has no corresponding executable force in the vendor -- grep confirms
 *  `SC_STRENGTH` is declared nowhere else in the file. Only the
 *  super-cluster-group INDEXING that comment sits above (building
 *  `superClusterGroups`) is real; that indexing is what 1.5a/1.5b/1.75
 *  consume below, ported as-is.
 *
 *  Phase 1.6 (tier-driven collapse packing, :3345-3390) is NOT ported --
 *  that cut is documented and accepted (task-S3-report.md, unaffected by
 *  this fix round): it's batch-C/C1 group-collapse machinery, out of the
 *  sandbox-bar's scope same as nebula/watermarks/pill collision. */
function applySuperClusterLayoutPasses(clusterNodes: CentroidNode[], clusters: GraphCluster[]): void {
  const superClusterGroups = new Map<string, string[]>();
  clusters.forEach((c) => {
    if (c.super_cluster) {
      const arr = superClusterGroups.get(c.super_cluster) ?? [];
      arr.push(c.id);
      superClusterGroups.set(c.super_cluster, arr);
    }
  });
  if (superClusterGroups.size === 0) return;

  const byId = new Map(clusterNodes.map((cn) => [cn.id, cn]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const pageCount = new Map(clusters.map((c) => [c.id, c.page_ids.length || 1]));

  function estimateNebulaRadius(clusterId: string): number {
    const n = pageCount.get(clusterId) ?? 1;
    // vendor :3105-3108 / :3240-3246 (two near-identical helpers, same
    // formula) -- approximates § 10's rendered nebula radius from the
    // phyllotaxis spread estimate, since real Phase-2 spread isn't known
    // yet at this point in the pipeline.
    return Math.max(Math.sqrt(n) * 9 * GRAPH_DEFAULTS.NEBULA_RADIUS_MULT, GRAPH_DEFAULTS.NEBULA_MIN_RADIUS);
  }

  // ── 1.5b: repel super-cluster groups from each other (vendor :3089-3162) ──
  const scKeys = [...superClusterGroups.keys()];
  if (scKeys.length > 1) {
    const SC_INTER_REPEL_ITERS = 60; // vendor :3097
    const INTER_SC_GAP = 60; // vendor :3098 -- px buffer between halo edges
    for (let iter = 0; iter < SC_INTER_REPEL_ITERS; iter++) {
      const scCens = new Map<string, LayoutPosition>();
      const scHaloR = new Map<string, number>();
      scKeys.forEach((sk) => {
        const members = superClusterGroups.get(sk)!;
        let cx = 0,
          cy = 0,
          cn2 = 0;
        members.forEach((mid) => {
          const cn = byId.get(mid);
          if (cn && cn.x != null && cn.y != null) {
            cx += cn.x;
            cy += cn.y;
            cn2++;
          }
        });
        if (cn2 === 0) return;
        const cen = { x: cx / cn2, y: cy / cn2 };
        scCens.set(sk, cen);
        let maxExtent = 0;
        members.forEach((mid) => {
          const cn = byId.get(mid);
          if (!cn || cn.x == null || cn.y == null) return;
          const dd = Math.hypot(cn.x - cen.x, cn.y - cen.y);
          const e = dd + estimateNebulaRadius(mid);
          if (e > maxExtent) maxExtent = e;
        });
        scHaloR.set(sk, maxExtent);
      });

      for (let si = 0; si < scKeys.length; si++) {
        for (let sj = si + 1; sj < scKeys.length; sj++) {
          const ca = scCens.get(scKeys[si]);
          const cb = scCens.get(scKeys[sj]);
          if (!ca || !cb) continue;
          const sdx = ca.x - cb.x,
            sdy = ca.y - cb.y;
          const sdist = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
          const minDist = (scHaloR.get(scKeys[si]) ?? 0) + (scHaloR.get(scKeys[sj]) ?? 0) + INTER_SC_GAP;
          if (sdist < minDist) {
            const push = (minDist - sdist) * 0.02;
            const snx = sdx / sdist,
              sny = sdy / sdist;
            superClusterGroups.get(scKeys[si])!.forEach((mid) => {
              const cn = byId.get(mid);
              if (cn && cn.x != null && cn.y != null) {
                cn.x += snx * push;
                cn.y += sny * push;
              }
            });
            superClusterGroups.get(scKeys[sj])!.forEach((mid) => {
              const cn = byId.get(mid);
              if (cn && cn.x != null && cn.y != null) {
                cn.x -= snx * push;
                cn.y -= sny * push;
              }
            });
          }
        }
      }
    }
  }

  // ── 1.5a: ring placement around SC centroid (vendor :3164-3213) ────
  const CLUSTER_RING_PAD = 40; // vendor :3169
  const PILL_CLUSTER_GAP = 16; // vendor :3170 -- matches LABEL_TO_CLUSTER_GAP
  superClusterGroups.forEach((memberIds, scKey) => {
    if (memberIds.length === 0) return;
    let rscx = 0,
      rscy = 0,
      rscn = 0;
    memberIds.forEach((mid) => {
      const cn = byId.get(mid);
      if (cn && cn.x != null && cn.y != null) {
        rscx += cn.x;
        rscy += cn.y;
        rscn++;
      }
    });
    if (rscn === 0) return;
    rscx /= rscn;
    rscy /= rscn;

    const wmBox = computeWatermarkBBox(scKey, { x: rscx, y: rscy });
    const wmHalfW = (wmBox.maxX - wmBox.minX) / 2;
    const wmHalfH = (wmBox.maxY - wmBox.minY) / 2;
    const wmHalfDiag = Math.hypot(wmHalfW, wmHalfH);

    let maxPillH = 0;
    memberIds.forEach((mid) => {
      const c = clusterById.get(mid);
      if (!c) return;
      const bb = estimateLabelBBox(c.name || c.id || "", 0, 0);
      if (bb.h > maxPillH) maxPillH = bb.h;
    });
    const clusterRadius = wmHalfDiag + maxPillH + PILL_CLUSTER_GAP + CLUSTER_RING_PAD;

    const ranked = memberIds
      .map((mid) => {
        const cn = byId.get(mid);
        const angle = cn && cn.x != null && cn.y != null ? Math.atan2(cn.y - rscy, cn.x - rscx) : 0;
        return { mid, angle };
      })
      .sort((a, b) => a.angle - b.angle);

    ranked.forEach((item, idx) => {
      const ringAngle = (idx / ranked.length) * 2 * Math.PI;
      const cn = byId.get(item.mid);
      if (cn) {
        cn.x = rscx + Math.cos(ringAngle) * clusterRadius;
        cn.y = rscy + Math.sin(ringAngle) * clusterRadius;
      }
    });
  });

  // ── 1.75: push non-members out of super-cluster regions (vendor :3215-3342) ──
  const scMemberSet = new Set<string>();
  superClusterGroups.forEach((members) => members.forEach((mid) => scMemberSet.add(mid)));

  const SC_REPEL_ITERS = 120; // vendor :3227
  const SC_REPEL_STRENGTH = 0.25; // vendor :3228
  const HALO_VISIBLE_FRACTION = 0.6; // vendor :3234
  const NON_SC_CLEARANCE = 40; // vendor :3281
  const PAIR_TOLERANCE = 40; // vendor :3304
  const PAIR_PUSH_STR = 0.6; // vendor :3305

  for (let ri = 0; ri < SC_REPEL_ITERS; ri++) {
    const scRegions = new Map<string, { cx: number; cy: number; radius: number }>();
    superClusterGroups.forEach((members, sk) => {
      let rcx = 0,
        rcy = 0,
        rcn = 0;
      members.forEach((mid) => {
        const cn = byId.get(mid);
        if (cn && cn.x != null && cn.y != null) {
          rcx += cn.x;
          rcy += cn.y;
          rcn++;
        }
      });
      if (rcn === 0) return;
      rcx /= rcn;
      rcy /= rcn;
      let maxVisible = 0;
      members.forEach((mid) => {
        const cn = byId.get(mid);
        if (cn && cn.x != null && cn.y != null) {
          const dd = Math.hypot(cn.x - rcx, cn.y - rcy);
          const extent = dd + estimateNebulaRadius(mid) * HALO_VISIBLE_FRACTION;
          if (extent > maxVisible) maxVisible = extent;
        }
      });
      scRegions.set(sk, { cx: rcx, cy: rcy, radius: maxVisible });
    });

    // Halo repel: push each non-SC cluster's shrinkwrap out of any SC halo
    // it pokes into.
    clusterNodes.forEach((cn) => {
      if (scMemberSet.has(cn.id) || cn.x == null || cn.y == null) return;
      const cluster = clusterById.get(cn.id);
      if (!cluster) return;
      let bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y);
      scRegions.forEach((reg) => {
        const hit = rectCircleOverlap(bbox, reg.cx, reg.cy, reg.radius + NON_SC_CLEARANCE);
        if (hit.overlap && hit.nx != null && hit.ny != null && hit.penetration != null) {
          cn.x = (cn.x ?? 0) + hit.nx * hit.penetration * SC_REPEL_STRENGTH;
          cn.y = (cn.y ?? 0) + hit.ny * hit.penetration * SC_REPEL_STRENGTH;
          bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y);
        }
      });
    });

    // Pairwise non-SC shrinkwrap repel -- the "raisins on expanding bread" pass.
    const nonSCList: Array<{ cn: CentroidNode; bbox: Rect; cluster: GraphCluster }> = [];
    clusterNodes.forEach((cn) => {
      if (scMemberSet.has(cn.id) || cn.x == null || cn.y == null) return;
      const c = clusterById.get(cn.id);
      if (!c) return;
      nonSCList.push({ cn, bbox: estimateClusterShrinkwrap(c, cn.x, cn.y), cluster: c });
    });
    for (let ai = 0; ai < nonSCList.length; ai++) {
      const A = nonSCList[ai];
      for (let aj = ai + 1; aj < nonSCList.length; aj++) {
        const B = nonSCList[aj];
        const pairHit = rectRectOverlap(A.bbox, B.bbox, PAIR_TOLERANCE);
        if (!pairHit.overlap || pairHit.overlapX == null || pairHit.overlapY == null || pairHit.dx == null || pairHit.dy == null)
          continue;
        const lenP = Math.hypot(pairHit.dx, pairHit.dy) || 1;
        let px: number, py: number;
        if (pairHit.overlapX < pairHit.overlapY) {
          px = (pairHit.overlapX / 2 + 1) * (pairHit.dx / lenP);
          py = 0;
        } else {
          px = 0;
          py = (pairHit.overlapY / 2 + 1) * (pairHit.dy / lenP);
        }
        A.cn.x = (A.cn.x ?? 0) + px * PAIR_PUSH_STR;
        A.cn.y = (A.cn.y ?? 0) + py * PAIR_PUSH_STR;
        B.cn.x = (B.cn.x ?? 0) - px * PAIR_PUSH_STR;
        B.cn.y = (B.cn.y ?? 0) - py * PAIR_PUSH_STR;
        A.bbox = estimateClusterShrinkwrap(A.cluster, A.cn.x, A.cn.y);
        B.bbox = estimateClusterShrinkwrap(B.cluster, B.cn.x, B.cn.y);
      }
    }
  }
}

/** Runs the vendor's Phase-1 cluster-centroid simulation to convergence,
 *  synchronously (vendor :3060-3075: forceLink + forceManyBody +
 *  forceCenter, alphaDecay 0.02, 400 manual ticks, then .stop()), then the
 *  SC-aware macro-layout passes (1.5b/1.5a/1.75, see
 *  applySuperClusterLayoutPasses above). Cluster centroids don't render
 *  directly -- they only seed where Phase 2's page nodes settle -- so
 *  there's no reason for any of this to run live. */
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

  applySuperClusterLayoutPasses(clusterNodes, clusters);

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
 * mirroring the vendor's own math/parameters, INCLUDING the SC-aware
 * ring-placement + halo-ejection passes (1.5b/1.5a/1.75) -- see
 * computeClusterCentroids/applySuperClusterLayoutPasses above.
 *
 * Phase 2 (page nodes) runs LIVE (review finding 4's fix): ONE
 * `d3.forceSimulation` PER CLUSTER, matching the vendor's own
 * cluster-isolation design (:3429-3446) -- each cluster's forceCollide
 * only ever sees that cluster's own members, so a dense cluster can't
 * squeeze a small neighbor into a linear column (the vendor's own
 * documented regression at :3416-3421, which a single shared/global sim
 * -- this hook's PRIOR design -- reintroduced). Each per-cluster sim also
 * gets its OWN deterministic seed (`mulberry32(hashId(cid))`, vendor
 * :3439) instead of one shared seed, so cross-cluster jiggle patterns
 * don't correlate.
 *
 * Unlike the vendor (which ticks each per-cluster sim 150 times
 * synchronously then discards it), every per-cluster sim here runs LIVE via
 * d3-force's own internal timer, all writing into the SAME shared
 * `positions` map and notifying through the SAME rAF-batched version
 * counter -- "N live sims, one store" is what review finding 4 asks for
 * ("N live per-cluster sims sharing one positions store/notify (preferred
 * -- matches vendor exactly, incl. per-cluster seeds)"). The FIRST commit
 * (right after the phyllotaxis seed, before any sim has ticked) is what
 * onFirstPaint in GraphA2 fires on; onSettle fires once every per-cluster
 * sim has ended.
 *
 * One deliberate, documented deviation from strict vendor parity: nodes
 * whose `parent_id` doesn't resolve to any Phase-1 centroid (either
 * literally `null`, or a stale/unmatched id) are grouped into one shared
 * "no cluster" bucket (keyed by a sentinel, targeting the canvas center)
 * instead of the vendor's `if (!pos) return;` skip (:3432), which leaves
 * such nodes permanently frozen at their seed position with no sim at
 * all. Real payloads route every page through a real cluster (including
 * the synthetic `_unclustered` bucket, which DOES have a Phase-1
 * centroid and so gets its own normal per-cluster sim here, same as the
 * vendor) -- this fallback bucket only matters for malformed/edge-case
 * data, where "still alive and collide-aware" is a better sandbox
 * behavior than "frozen forever," without weakening cluster-local
 * isolation for any real cluster (the fallback bucket is itself just one
 * more isolated group, not a shared global pool).
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
  /** Fired once every per-cluster sim's alpha has decayed below alphaMin
   *  and its internal timer has stopped. */
  onSettle?: () => void;
}

const NO_CLUSTER_KEY = "__no_cluster__";

export function useForceLayout(
  nodes: GraphNode[],
  clusters: GraphCluster[],
  links: GraphLink[],
  width: number,
  height: number,
  callbacks?: UseForceLayoutCallbacks
): ForceLayoutStore {
  const positionsRef = useRef<Map<string, LayoutPosition>>(new Map());
  const clusterCentroidsRef = useRef<Map<string, LayoutPosition>>(new Map());
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
      clusterCentroidsRef,
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
    clusterCentroidsRef.current = centroids;

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

    // First commit -- "first dots" -- is the phyllotaxis seed, synchronous
    // with mount, before any sim has ticked at all.
    flush();
    notify();
    callbacksRef.current?.onFirstPaint?.();

    // ── Phase 2: N live per-cluster simulations, one shared store ──────
    // Group by parent_id (review finding 4) -- see the NO_CLUSTER_KEY note
    // in this function's header comment for the one documented deviation
    // from strict "skip if unmatched" vendor parity.
    const groups = new Map<string, SimNode[]>();
    workingNodes.forEach((n) => {
      const key = n.parent_id ?? NO_CLUSTER_KEY;
      const arr = groups.get(key) ?? [];
      arr.push(n);
      groups.set(key, arr);
    });

    const collideRadius = (GRAPH_DEFAULTS.NODE_RADIUS + 2) * GRAPH_DEFAULTS.PAGE_SPREAD_MULT; // vendor :3442
    const sims: Array<ReturnType<typeof d3.forceSimulation<SimNode>>> = [];
    const totalSims = groups.size;
    let endedCount = 0;

    groups.forEach((groupNodes, cid) => {
      const centroid = centroids.get(cid);
      const targetX = centroid ? centroid.x : width / 2;
      const targetY = centroid ? centroid.y : height / 2;
      const sim = d3
        .forceSimulation<SimNode>(groupNodes)
        // Per-cluster seed (vendor :3439) -- deterministic page-node
        // packing within each cluster/bucket, independent of every other
        // cluster's jiggle.
        .randomSource(mulberry32(hashId(cid)))
        .force("x", d3.forceX<SimNode>(targetX).strength(0.3))
        .force("y", d3.forceY<SimNode>(targetY).strength(0.3))
        .force("collide", d3.forceCollide<SimNode>(collideRadius))
        .alphaDecay(0.05)
        .stop();
      sims.push(sim);
      sim.on("tick", () => {
        flush();
        scheduleNotify();
      });
      sim.on("end", () => {
        flush();
        scheduleNotify();
        endedCount++;
        if (!cancelled && endedCount === totalSims) callbacksRef.current?.onSettle?.();
      });
      sim.restart();
    });

    // No cluster had any live-simmable members (e.g. every node orphaned)
    // -- nothing will ever tick, so fire onSettle immediately rather than
    // leaving callers waiting forever for a sim that doesn't exist.
    if (totalSims === 0 && !cancelled) callbacksRef.current?.onSettle?.();

    return () => {
      cancelled = true;
      sims.forEach((sim) => {
        sim.stop();
        sim.on("tick", null);
        sim.on("end", null);
      });
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
