// Batch 03 (graph canvas port) Task group W -- the force-layout pipeline
// carved out of lib/graph/d3-graph-vendor.js's `computeLayout` (that
// file's own header comment documents the vendoring discipline this port
// respects: every phase below is a byte-faithful port of computeLayout's
// math, restructured only so Phase 2 can be ticked INCREMENTALLY instead
// of run to convergence in one blocking loop -- see sim.worker.ts for who
// drives that incremental stepping and why).
//
// Pure and worker-agnostic on purpose: no `self`/`postMessage`/DOM read
// anywhere in this file, so it's directly unit-testable (sim-layout.test.ts)
// without a real Worker, and sim.worker.ts's own job shrinks to "own the
// message protocol, drive this engine's step() loop, post the results."
//
// Phases (task-W-brief.md's locked pipeline order):
//   Phase 1    -- cluster centroids (forceLink + forceManyBody + forceCenter,
//                 400 manual ticks, vendor computeLayout :3217-3267)
//   Phase 1.5b -- repel super-cluster groups from each other (:3281-3354,
//                 nested inside the 1.5b/1.5a/1.75 SC block)
//   Phase 1.5a -- ring-place SC-member clusters around their SC centroid
//   Phase 1.75 -- push non-SC-member clusters out of SC halo regions
//   Phase 1.6  -- tier-driven collapse packing (:3537-3582)
//   Phase 2    -- N per-cluster page-node sims, phyllotaxis-seeded,
//                 collide-isolated, per-cluster hashId seeds (:3590-3638)
//
// Determinism note (task-W-brief.md "Global constraints"): every seeded
// RNG call (`mulberry32(0xC0FFEE)` for Phase 1, `mulberry32(hashId(cid))`
// per Phase-2 cluster) and every fixed tick count (400 / 150) is preserved
// EXACTLY. Phase 2's 150-per-cluster ticks are spread across many
// `step()` calls instead of one blocking `for` loop, but each cluster's
// own simulation is fully independent (its own forceSimulation instance,
// its own seeded random source, no force ever reads another cluster's
// nodes) -- interleaving cluster A's ticks with cluster B's therefore
// produces the IDENTICAL final position for each cluster as ticking A to
// completion before starting B ever would. `alphaMin` (SimParams) is
// applied to every simulation instance for API completeness but is NOT a
// stopping condition -- computeLayout never checked it either (its `for`
// loops just ran a fixed count and stopped), and switching to
// alpha-threshold stopping here would settle in fewer ticks than vendor's
// 150 (alphaDecay 0.05 crosses the default 0.001 alphaMin around tick
// ~135), silently drifting every settled position away from the pre-W2
// baseline. Fixed counts are the parity-preserving choice.

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
} from "d3-force";
import type {
  SimClusterInput,
  SimLinkInput,
  SimNodeInput,
  SimParams,
  SimStartPayload,
} from "./sim-protocol";

// ── Deterministic hash / PRNG (vendor d3-graph-vendor.js :2283-2304,
// byte-identical port) ──────────────────────────────────────────────────

/** Hash a cluster ID string to a numeric seed. */
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Mulberry32 PRNG -- call mulberry32(seed) -> returns a function that
 *  produces 0..1 with full 32-bit period. Used as the random source for
 *  d3.forceSimulation so layouts are deterministic across reloads. */
export function mulberry32(seed: number): () => number {
  let t = seed;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Shrinkwrap-estimate geometry (vendor :1943-2205) ────────────────────
// Pure AABB/circle-overlap estimators Phase 1.5a/1.5b/1.75 use to keep
// clusters clear of super-cluster halos before any page node has a real
// position. `labelDims` is the caller-supplied, DOM-measured cache
// (sim-protocol.ts's SimStartPayload.labelDims field comment) -- these
// helpers consult it first and only fall back to the char-width estimate
// for a name the main thread never measured, identical to the vendor's
// own labelDimsCache-or-fallback branch.

const SHRINKWRAP_PAD = 8;
const LABEL_LINE_HEIGHT_ESTIMATE = 12;
const LABEL_CHAR_WIDTH_ESTIMATE = 6;
const LABEL_WRAP_CHARS = 18;

interface Rect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type LabelDims = Record<string, { w: number; h: number }>;

/** vendor estimateLabelLines, :1959-1972. */
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
  let m = 0;
  for (const l of lines) if (l.length > m) m = l.length;
  return m;
}

/** vendor estimateLabelBBox, :2007-2028. */
function estimateLabelBBox(
  name: string,
  anchorX: number,
  anchorY: number,
  labelDims: LabelDims
): Rect & { w: number; h: number } {
  const measured = labelDims[name];
  let w: number, h: number;
  if (measured) {
    w = measured.w;
    h = measured.h;
  } else {
    const lines = estimateLabelLines(name, LABEL_WRAP_CHARS);
    w = maxLineLen(lines) * LABEL_CHAR_WIDTH_ESTIMATE;
    h = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
  }
  return { minX: anchorX - w / 2, maxX: anchorX + w / 2, minY: anchorY - h / 2, maxY: anchorY + h / 2, w, h };
}

/** vendor estimateClusterShrinkwrap, :2040-2065. */
function estimateClusterShrinkwrap(
  cluster: SimClusterInput,
  centroidX: number,
  centroidY: number,
  labelDims: LabelDims
): Rect {
  const n = cluster.page_ids.length || 1;
  const nodeSpread = Math.sqrt(n) * 9;
  const measured = labelDims[cluster.name || ""];
  let labelW: number, labelH: number;
  if (measured) {
    labelW = measured.w;
    labelH = measured.h;
  } else {
    const lines = estimateLabelLines(cluster.name || "", LABEL_WRAP_CHARS);
    labelW = maxLineLen(lines) * LABEL_CHAR_WIDTH_ESTIMATE;
    labelH = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
  }
  const GAP = 8;
  const halfW = Math.max(nodeSpread, labelW / 2);
  return {
    minX: centroidX - halfW - SHRINKWRAP_PAD,
    maxX: centroidX + halfW + SHRINKWRAP_PAD,
    minY: centroidY - nodeSpread - GAP - labelH - SHRINKWRAP_PAD,
    maxY: centroidY + nodeSpread + SHRINKWRAP_PAD,
  };
}

/** vendor computeWatermarkBBox, :2111-2150. The wrap budget and per-char
 *  width are face-dependent (payload.scNameLineBudget / scNameCharWidth,
 *  from the vendor's SC_NAME_LINE_BUDGET / SC_NAME_CHAR_WIDTH) so this
 *  mirror and the painted labels agree. */
function computeWatermarkBBox(
  scKeyword: string,
  scCentroid: { x: number; y: number },
  scLabelTopPad: number,
  scNameLineBudget: number,
  scNameCharWidth: number
): Rect {
  const ICON_SIZE = 160;
  const SC_NAME_FONT_SIZE = 30;
  const SC_NAME_LINE_HEIGHT = SC_NAME_FONT_SIZE * 1.15;

  const nameText = (scKeyword || "").slice(0, 36);
  const lines = estimateLabelLines(nameText, scNameLineBudget);
  const nameH = lines.length * SC_NAME_LINE_HEIGHT;
  const nameW = maxLineLen(lines) * scNameCharWidth;

  const halfIcon = ICON_SIZE / 2;
  const nameTopY = scCentroid.y + halfIcon + scLabelTopPad;
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

/** vendor rectCircleOverlap, :2160-2180. */
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

/** vendor rectRectOverlap, :2186-2205. */
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

/** vendor isCollapsedCluster, :482-486. */
function isCollapsedCluster(c: SimClusterInput | undefined, expandedGroups: Record<string, boolean>): boolean {
  return !!c && c.group_id != null && (c.group_tier === "casual" || c.group_tier === "binge") && !expandedGroups[String(c.group_id)];
}

// ── Phase 1 node/link shapes ─────────────────────────────────────────────

interface Phase1Node {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  index?: number;
}

interface Phase1Link {
  source: string | Phase1Node;
  target: string | Phase1Node;
  weight: number;
}

const PHASE1_CHARGE_DISTANCE_MAX = 300;
const PHASE1_LINK_DISTANCE_RANGE = 120;
const PHASE1_ALPHA_DECAY = 0.02;
const PHASE1_TICKS = 400;

const PHASE1_SEED = 0xc0ffee;

/** Phase 1 + the SC-aware macro-layout passes (1.5b/1.5a/1.75) + Phase
 *  1.6's collapse packing -- everything in vendor computeLayout BEFORE
 *  Phase 2's phyllotaxis seed. Runs fully synchronously (matches vendor:
 *  none of this streams to main, so there's no reason to spread it across
 *  frames the way Phase 2 is). Returns the final cluster centroid map,
 *  keyed by cluster id. */
function runClusterCentroidPhases(
  clusters: SimClusterInput[],
  links: SimLinkInput[],
  params: SimParams,
  width: number,
  height: number,
  nebulaRadiusMult: number,
  nebulaMinRadius: number,
  scLabelTopPad: number,
  scNameLineBudget: number,
  scNameCharWidth: number,
  labelDims: LabelDims,
  expandedGroups: Record<string, boolean>
): Map<string, { x: number; y: number }> {
  // ── Phase 1: Position cluster centroids by similarity (vendor :3234-3267) ──
  const clusterNodes: Phase1Node[] = clusters.map((c) => ({ id: c.id }));
  const clusterIdIndex = new Map<string, number>();
  clusterNodes.forEach((cn, i) => clusterIdIndex.set(cn.id, i));

  const phase1Links: Phase1Link[] = links
    .filter((l) => clusterIdIndex.has(l.source) && clusterIdIndex.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, weight: l.weight }));

  const sim1: Simulation<Phase1Node, Phase1Link> = forceSimulation(clusterNodes)
    .randomSource(mulberry32(PHASE1_SEED))
    .force(
      "link",
      forceLink<Phase1Node, Phase1Link>(phase1Links)
        .id((d) => d.id)
        .distance((l) => params.linkDistance + PHASE1_LINK_DISTANCE_RANGE * (1 - l.weight))
        .strength((l) => l.weight * l.weight * l.weight)
    )
    .force("charge", forceManyBody().strength(params.charge).distanceMax(PHASE1_CHARGE_DISTANCE_MAX))
    .force("center", forceCenter(width / 2, height / 2))
    .alphaDecay(PHASE1_ALPHA_DECAY)
    .alphaMin(params.alphaMin)
    .stop();

  for (let t = 0; t < PHASE1_TICKS; t++) sim1.tick();

  const byId = new Map(clusterNodes.map((cn) => [cn.id, cn]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));

  // ── Phase 1.5: super-cluster grouping index (vendor :3272-3278) ──────
  const superClusterGroups = new Map<string, string[]>();
  clusters.forEach((c) => {
    if (c.super_cluster) {
      const arr = superClusterGroups.get(c.super_cluster) ?? [];
      arr.push(c.id);
      superClusterGroups.set(c.super_cluster, arr);
    }
  });

  function estimateNebulaRadius(clusterId: string): number {
    const cluster = clusterById.get(clusterId);
    const n = cluster ? cluster.page_ids.length || 1 : 1;
    return Math.max(Math.sqrt(n) * 9 * nebulaRadiusMult, nebulaMinRadius);
  }

  if (superClusterGroups.size > 0) {
    // ── Phase 1.5b: repel super-cluster groups from each other (:3281-3354) ──
    const scKeys = [...superClusterGroups.keys()];
    if (scKeys.length > 1) {
      const SC_INTER_REPEL_ITERS = 60;
      const INTER_SC_GAP = 60;
      for (let iter = 0; iter < SC_INTER_REPEL_ITERS; iter++) {
        const scCens = new Map<string, { x: number; y: number }>();
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

    // ── Phase 1.5a: ring placement around SC centroid (:3356-3405) ────
    const CLUSTER_RING_PAD = 40;
    const PILL_CLUSTER_GAP = 16;
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

      const wmBox = computeWatermarkBBox(
        scKey,
        { x: rscx, y: rscy },
        scLabelTopPad,
        scNameLineBudget,
        scNameCharWidth
      );
      const wmHalfW = (wmBox.maxX - wmBox.minX) / 2;
      const wmHalfH = (wmBox.maxY - wmBox.minY) / 2;
      const wmHalfDiag = Math.hypot(wmHalfW, wmHalfH);

      let maxPillH = 0;
      memberIds.forEach((mid) => {
        const c = clusterById.get(mid);
        if (!c) return;
        const bb = estimateLabelBBox(c.name || c.id || "", 0, 0, labelDims);
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

    // ── Phase 1.75: push non-members out of super-cluster regions (:3407-3535) ──
    const scMemberSet = new Set<string>();
    superClusterGroups.forEach((members) => members.forEach((mid) => scMemberSet.add(mid)));

    const SC_REPEL_ITERS = 120;
    const SC_REPEL_STRENGTH = 0.25;
    const HALO_VISIBLE_FRACTION = 0.6;
    const NON_SC_CLEARANCE = 40;
    const PAIR_TOLERANCE = 40;
    const PAIR_PUSH_STR = 0.6;

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

      byId.forEach((cn) => {
        if (scMemberSet.has(cn.id) || cn.x == null || cn.y == null) return;
        const cluster = clusterById.get(cn.id);
        if (!cluster) return;
        let bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y, labelDims);
        scRegions.forEach((reg) => {
          const hit = rectCircleOverlap(bbox, reg.cx, reg.cy, reg.radius + NON_SC_CLEARANCE);
          if (hit.overlap && hit.nx != null && hit.ny != null && hit.penetration != null) {
            cn.x = (cn.x ?? 0) + hit.nx * hit.penetration * SC_REPEL_STRENGTH;
            cn.y = (cn.y ?? 0) + hit.ny * hit.penetration * SC_REPEL_STRENGTH;
            bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y, labelDims);
          }
        });
      });

      const nonSCList: Array<{ cn: Phase1Node; bbox: Rect; cluster: SimClusterInput }> = [];
      byId.forEach((cn) => {
        if (scMemberSet.has(cn.id) || cn.x == null || cn.y == null) return;
        const c = clusterById.get(cn.id);
        if (!c) return;
        nonSCList.push({ cn, bbox: estimateClusterShrinkwrap(c, cn.x, cn.y, labelDims), cluster: c });
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
          A.bbox = estimateClusterShrinkwrap(A.cluster, A.cn.x, A.cn.y, labelDims);
          B.bbox = estimateClusterShrinkwrap(B.cluster, B.cn.x, B.cn.y, labelDims);
        }
      }
    }
  }

  // ── Phase 1.6: tier-driven collapse packing (vendor :3537-3582) ──────
  const collapsePack = new Map<number, string[]>();
  clusters.forEach((c) => {
    if (!isCollapsedCluster(c, expandedGroups)) return;
    const gid = c.group_id as number;
    const arr = collapsePack.get(gid) ?? [];
    arr.push(c.id);
    collapsePack.set(gid, arr);
  });
  // vendor's `Object.keys(collapsePack).forEach(...)` iterates a plain
  // object keyed by NUMERIC group_id -- per the spec, integer-index-like
  // keys enumerate in ASCENDING NUMERIC order, not insertion order (unlike
  // every other keyed-by-string structure ported above, which vendor
  // iterates via `for...in`/`Object.keys` on non-integer keys and so
  // already matches this Map's insertion order). Each group's own
  // repositioning only reads/writes ITS OWN members (disjoint from every
  // other group), so processing order can't change any group's final
  // result -- sorted here anyway so this loop's iteration order is
  // byte-identical to vendor's, not merely "provably order-independent."
  Array.from(collapsePack.keys())
    .sort((a, b) => a - b)
    .forEach((gid) => {
      const mids = collapsePack.get(gid)!;
      if (mids.length < 2) return; // a lone cluster is already a blob
      let gx = 0,
        gy = 0,
        gcnt = 0;
      mids.forEach((mid) => {
        const cn = byId.get(mid);
        if (cn && cn.x != null && cn.y != null) {
          gx += cn.x;
          gy += cn.y;
          gcnt++;
        }
      });
      if (!gcnt) return;
      gx /= gcnt;
      gy /= gcnt;
      let meanNebR = 0;
      mids.forEach((mid) => {
        meanNebR += estimateNebulaRadius(mid);
      });
      meanNebR /= mids.length;
      const packR = meanNebR * 0.35;
      mids
        .map((mid) => {
          const cn = byId.get(mid);
          const angle = cn && cn.x != null && cn.y != null ? Math.atan2(cn.y - gy, cn.x - gx) : 0;
          return { cn, angle };
        })
        .sort((a, b) => a.angle - b.angle)
        .forEach((item, idx, arr) => {
          if (!item.cn) return;
          const th = (idx / arr.length) * 2 * Math.PI;
          item.cn.x = gx + Math.cos(th) * packR;
          item.cn.y = gy + Math.sin(th) * packR;
        });
    });

  // Record fixed centroid positions (vendor :3584-3588).
  const centroidPos = new Map<string, { x: number; y: number }>();
  byId.forEach((cn) => {
    centroidPos.set(cn.id, { x: cn.x ?? width / 2, y: cn.y ?? height / 2 });
  });
  return centroidPos;
}

// ── Phase 2: per-cluster page-node sims ──────────────────────────────────

interface Phase2Node {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  index?: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // vendor :3593, ~137.508°
const PHASE2_ALPHA_DECAY = 0.05;
export const PHASE2_TICKS = 150;

interface ClusterRun {
  sim: Simulation<Phase2Node, SimulationLinkDatum<Phase2Node>>;
  members: Phase2Node[];
}

/** Incrementally-steppable engine wrapping the whole vendor `computeLayout`
 *  pipeline. Construction runs Phase 1 + the SC/collapse passes + Phase
 *  2's phyllotaxis seed synchronously (none of that streams to main);
 *  `step()` then advances Phase 2's N per-cluster sims by one tick each,
 *  vendor-parity fixed count (150/cluster). */
export class SimEngine {
  private readonly nodeIndexById = new Map<string, number>();
  private readonly positions: Float64Array;
  private readonly clusterRuns: ClusterRun[] = [];
  private remainingTicks = PHASE2_TICKS;

  constructor(private readonly payload: SimStartPayload) {
    const { nodes, clusters, links, params, width, height, nodeRadius, pageSpreadMult, expandedGroups } = payload;

    nodes.forEach((n, i) => this.nodeIndexById.set(n.id, i));
    this.positions = new Float64Array(nodes.length * 2);

    const centroidPos = runClusterCentroidPhases(
      clusters,
      links,
      params,
      width,
      height,
      payload.nebulaRadiusMult,
      payload.nebulaMinRadius,
      payload.scLabelTopPad,
      payload.scNameLineBudget,
      payload.scNameCharWidth,
      payload.labelDims,
      expandedGroups
    );

    // ── Phase 2 seed: phyllotaxis spiral from each node's cluster centroid
    // (vendor :3592-3605), width/2,height/2 fallback for an unmatched
    // parent_id (vendor's own `if (!pos) { ...; return; }` branch --
    // deliberately NOT the A2 spike's more lenient shared-bucket
    // deviation; this is the promotion, strict vendor parity applies). ──
    const clusterCounters = new Map<string, number>();
    const clusterMembers = new Map<string, Phase2Node[]>();
    nodes.forEach((n: SimNodeInput, i) => {
      const cid = n.parent_id;
      const pos = cid != null ? centroidPos.get(cid) : undefined;
      if (!pos) {
        this.positions[i * 2] = width / 2;
        this.positions[i * 2 + 1] = height / 2;
        return;
      }
      const seedIndex = clusterCounters.get(cid!) ?? 0;
      clusterCounters.set(cid!, seedIndex + 1);
      const r = Math.sqrt(seedIndex) * (nodeRadius * 3 * pageSpreadMult);
      const theta = seedIndex * GOLDEN_ANGLE;
      const x = pos.x + r * Math.cos(theta);
      const y = pos.y + r * Math.sin(theta);
      this.positions[i * 2] = x;
      this.positions[i * 2 + 1] = y;

      const members = clusterMembers.get(cid!) ?? [];
      members.push({ id: n.id, x, y });
      clusterMembers.set(cid!, members);
    });

    // One forceSimulation PER CLUSTER (vendor :3607-3638) -- collision
    // stays cluster-local, per-cluster seeded RNG.
    const collideRadius = params.collideRadius;
    clusterMembers.forEach((members, cid) => {
      const sim = forceSimulation<Phase2Node>(members)
        .randomSource(mulberry32(hashId(cid)))
        .force("x", forceX<Phase2Node>(centroidPos.get(cid)!.x).strength(0.3))
        .force("y", forceY<Phase2Node>(centroidPos.get(cid)!.y).strength(0.3))
        .force("collide", forceCollide<Phase2Node>(collideRadius))
        .alphaDecay(PHASE2_ALPHA_DECAY)
        .alphaMin(params.alphaMin)
        .stop();
      this.clusterRuns.push({ sim, members });
    });

    if (this.clusterRuns.length === 0) this.remainingTicks = 0;
  }

  /** Fresh copy of the current positions (never the engine's own live
   *  backing array) -- safe for the caller to transfer without aliasing
   *  this engine's internal state. `[x0,y0,x1,y1,...]` in the `start`
   *  message's `nodes` order. */
  snapshot(): Float64Array {
    return this.positions.slice();
  }

  /** Advance one frame: ticks every still-active cluster sim once and
   *  writes its members' new positions back into the shared array.
   *  Returns true once every cluster has exhausted its fixed tick budget
   *  (the run is fully settled). */
  step(): boolean {
    if (this.remainingTicks <= 0) return true;
    for (const run of this.clusterRuns) {
      run.sim.tick();
      for (const n of run.members) {
        const idx = this.nodeIndexById.get(n.id);
        if (idx == null) continue;
        this.positions[idx * 2] = n.x;
        this.positions[idx * 2 + 1] = n.y;
      }
    }
    this.remainingTicks -= 1;
    return this.remainingTicks <= 0;
  }

  /** True once step() has reported settled (or there was nothing to
   *  tick in the first place). */
  get done(): boolean {
    return this.remainingTicks <= 0;
  }

  /** Restarts ticking for the CURRENT run (task-W-brief.md's locked
   *  `reheat` message) -- a "nudge" from the CURRENT positions, not a
   *  restart from the original phyllotaxis seed: every still-tracked
   *  cluster's alpha resets to 1 and its tick budget resets to the full
   *  vendor-parity count, so its own 150-tick settle runs again.
   *  Unexercised by the real W2 render() integration (re-layout triggers
   *  use stop-then-start), implemented for locked-protocol completeness. */
  reheat(params?: Partial<SimParams>): void {
    if (params?.alphaMin != null) {
      for (const run of this.clusterRuns) run.sim.alphaMin(params.alphaMin);
    }
    for (const run of this.clusterRuns) run.sim.alpha(1);
    this.remainingTicks = this.clusterRuns.length > 0 ? PHASE2_TICKS : 0;
  }
}

export function createSimEngine(payload: SimStartPayload): SimEngine {
  return new SimEngine(payload);
}
