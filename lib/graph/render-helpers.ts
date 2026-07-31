// Batch 03 (graph canvas port) Task S3 -- "A2: React-owned" sandbox spike.
// Pure math/color helpers shared by useForceLayout.ts, Zoom.tsx, and
// GraphA2.tsx, ported from lib/graph/d3-graph-vendor.js (the A1 near-
// verbatim port, itself vendored from explorer's d3_graph.js at HEAD
// 4bb0a648dc961a2961b153699be7ca1827484a1a). Every function here is a
// small, self-contained piece of vendor math -- factored into one module
// instead of duplicated across the three A2 files that each need a subset
// of it. Line refs below point at the ORIGINAL vendor file
// (lib/graph/d3-graph-vendor.js), not the source Dash file.
//
// Values that are GRAPH_DEFAULTS (constants.ts) keys are read from there,
// never hardcoded here. Values that are plain local `var`s in the vendor
// (not tuner-exposed -- e.g. MIN_ZOOM_RATIO, the label-layout geometry
// constants) are hardcoded here too, matching the vendor 1:1, since they
// have no GRAPH_DEFAULTS key to read.

import { GRAPH_DEFAULTS } from "./constants";
import type { GraphCluster, GraphSuperCluster } from "@/lib/types";

// ── Deterministic PRNG (vendor :2091, :2105) ──────────────────────────
// Seeded so layout + hull-label wrapping are reproducible across reloads,
// matching the vendor's own determinism goal (see that file's mulberry32
// doc comment).

/** Hash a cluster/page id string to a numeric seed (vendor :2091-2094). */
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Mulberry32 PRNG (vendor :2105-2112) -- call mulberry32(seed) to get a
 *  0..1 generator with full 32-bit period, passed to d3-force's
 *  `.randomSource(...)` for deterministic tie-breaking jiggle. */
export function mulberry32(seed: number): () => number {
  let t = seed;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Screen-clamped scale (Pattern-3, vendor :522-538) ─────────────────

/** Multiplier such that world_size * scale paints at a screen size clamped
 *  to [k_min, k_max] * natural-size-at-fit, regardless of zoom.
 *
 *  CRITICAL FIX (review finding 1): the vendor divides the clamped ratio by
 *  the ABSOLUTE zoomK (:537 `return effRatio / zoomK;`), not by `ratio`
 *  itself -- dividing by zoomK is what cancels the SVG zoom transform so
 *  the painted size stays screen-constant; dividing by `ratio` (as this
 *  function used to) leaves a stray `fitZoom` factor baked into every
 *  world-space size, so everything painted ~1/fitZoom times too small
 *  (e.g. ~2.4x smaller at this app's live fit scale of ~0.41). `zoomK` and
 *  `fitZoom` are now both required (not just their quotient) so this can
 *  divide by the right one -- see the two vendor guard clauses at :529
 *  (`fitZoom <= 0 || zoomK <= 0`), preserved here verbatim. */
export function clampedScale(zoomK: number, fitZoom: number, thresholds: { k_min: number; k_max: number }): number {
  if (fitZoom <= 0 || zoomK <= 0) return 1.0;
  const ratio = zoomK / fitZoom;
  const effRatio = ratio < thresholds.k_min ? thresholds.k_min : ratio > thresholds.k_max ? thresholds.k_max : ratio;
  return effRatio / zoomK;
}

// ── Page dots + star glyphs (vendor :1388-1406, :3990-4045) ───────────

/** World-space radius for a page dot's invisible anchor circle, screen-
 *  clamped via SCALE_THRESHOLDS.pageDot (vendor :1388-1391). Pass the
 *  CURRENT absolute zoomK and fitZoom (not just their ratio -- see
 *  clampedScale's fix note above). Before fit has run (fitZoom unknown),
 *  pass `fitZoom=0`: the guard above returns 1.0, i.e. BASE_PAGE_DOT_SIZE
 *  painted as a raw world-space size -- the same transient the vendor's
 *  own clampedScale produces before its first fitToContent call (:529). */
export function pageDotRadius(kind: string, zoomK: number, fitZoom: number): number {
  const s = GRAPH_DEFAULTS.BASE_PAGE_DOT_SIZE * clampedScale(zoomK, fitZoom, GRAPH_DEFAULTS.SCALE_THRESHOLDS.pageDot);
  return kind === "singleton" ? s * 0.85 : s;
}

/** Deterministic star-spike variant per page id, 0-3 (vendor :1396-1398). */
export function starVariant(id: string): number {
  return hashId(id) % 4;
}

/** Muted resting opacity for a page's star glyph, scaled up slightly with
 *  visit_count (vendor :1403-1406). */
export function starGlyphOpacity(visitCount: number | undefined): number {
  const v = visitCount || 1;
  return GRAPH_DEFAULTS.STAR_GLYPH_OPACITY_MULT * Math.min(1, 0.78 + 0.08 * Math.min(3, v - 1));
}

/** The four star-spike path defs (vendor :3808-3813), referenced via
 *  `<use href="#star-v{0..3}">` so N stars cost 4 path defs, not N. */
export const STAR_PATH_DEFS: readonly string[] = [
  "M0,-1.3 L0.5,-0.5 L1.3,0 L0.5,0.5 L0,1.3 L-0.5,0.5 L-1.3,0 L-0.5,-0.5 Z",
  "M0,-2 L0.6,-0.6 L2,0 L0.6,0.6 L0,2 L-0.6,0.6 L-2,0 L-0.6,-0.6 Z",
  "M0,-3 L0.42,-0.42 L3,0 L0.42,0.42 L0,3 L-0.42,0.42 L-3,0 L-0.42,-0.42 Z",
  "M-1.4,-1.4 L0,-0.55 L1.4,-1.4 L0.55,0 L1.4,1.4 L0,0.55 L-1.4,1.4 L-0.55,0 Z",
];

// ── Galaxy-stop color assignment (vendor :560-698) ─────────────────────
// "colors from galaxy stops" per the task brief -- reads the same
// --galaxy-N CSS custom properties batch 01's theme system writes (see
// lib/theme.ts / ThemeProvider.tsx), the same source the vendor reads via
// getComputedStyle(document.documentElement).

/** Read every --galaxy-N custom property off :root, in order, until one is
 *  missing (vendor :582-591). Falls back to a single neutral when none are
 *  set (CSS not yet applied, or a non-browser test environment). */
export function getGalaxyStops(): string[] {
  if (typeof document === "undefined") return [fallbackColor()];
  const style = getComputedStyle(document.documentElement);
  const stops: string[] = [];
  for (let i = 0; ; i++) {
    const val = style.getPropertyValue(`--galaxy-${i}`).trim();
    if (!val) break;
    stops.push(val);
  }
  return stops.length > 0 ? stops : [fallbackColor()];
}

function hexChannel(v: number): string {
  return Math.round(v).toString(16).padStart(2, "0");
}

/** Linear hex-color interpolation (vendor :593-598). */
export function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16),
    ag = parseInt(a.slice(3, 5), 16),
    ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16),
    bg = parseInt(b.slice(3, 5), 16),
    bb = parseInt(b.slice(5, 7), 16);
  return "#" + hexChannel(ar + (br - ar) * t) + hexChannel(ag + (bg - ag) * t) + hexChannel(ab + (bb - ab) * t);
}

/** Forward-backward gradient sample so the palette wraps seamlessly at the
 *  0/1 boundary (vendor :600-608). */
export function sampleMirrored(stops: string[], t: number): string {
  const m = t <= 0.5 ? t * 2 : (1 - t) * 2;
  const pos = m * (stops.length - 1);
  const lo = Math.max(0, Math.floor(pos));
  const hi = Math.min(stops.length - 1, lo + 1);
  return lerpHex(stops[lo], stops[hi], pos - lo);
}

/** Relative luminance of --bg (vendor :560-569); assumes light if the
 *  custom property isn't readable (matches vendor's own fallback). */
export function bgLuminance(): number {
  if (typeof document === "undefined") return 0.9;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg || bg.charAt(0) !== "#") return 0.9;
  let hex = bg.replace("#", "");
  if (hex.length === 3)
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(hex.substr(i, 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function isDarkBg(): boolean {
  return bgLuminance() < 0.4;
}

/** Fallback neutral when a cluster color is unknown (vendor :578, same
 *  color, but written in 6-digit form -- the vendor's 3-digit shorthand
 *  ("#aaa"/"#888") is only ever used as a plain CSS `fill`/`color` value
 *  there, but this port also feeds it through lerpHex/sampleMirrored
 *  above, which assume 6-digit hex; a 3-digit string silently produces
 *  NaN channels there (verified: `#aaa` -> `#8808NaN`+ style breakage).
 *  Latent in the vendor too (unreachable in practice: --galaxy-N is
 *  always present post-hydration), but this sandbox's fallback path is
 *  reachable earlier (before CSS vars land) and in tests -- fixed here
 *  rather than in lerpHex, since the vendor's own lerpHex is the thing
 *  being ported verbatim. */
export function fallbackColor(): string {
  return isDarkBg() ? "#aaaaaa" : "#888888";
}

/** Normalize a hex color for label readability -- dark in light mode,
 *  light in dark mode (vendor :2056-2082, HSL rotate-and-relight). */
export function labelColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = isDarkBg() ? 0.45 : 0.7;
  const l = isDarkBg() ? 0.8 : 0.25;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r1: number, g1: number, b1: number;
  if (h < 1 / 6) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 2 / 6) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 3 / 6) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 4 / 6) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 5 / 6) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return "#" + hexChannel((r1 + m) * 255) + hexChannel((g1 + m) * 255) + hexChannel((b1 + m) * 255);
}

/** Cluster id -> hex color, mirroring vendor's assignClusterColors
 *  (:645-680) minus the nebula-background re-tint second pass (:682-695,
 *  a nebula-only concern -- out of scope for the sandbox bar). SC members
 *  share their super-cluster's evenly-spaced gradient sample; everyone
 *  else is placed by angle around the graph's centroid. `centroids` maps
 *  cluster id -> its members' average (x, y), same shape
 *  computeClusterPositionCentroids returns below. */
export function buildClusterColorMap(
  clusters: GraphCluster[],
  superClusters: GraphSuperCluster[],
  centroids: Map<string, { x: number; y: number }>
): Map<string, string> {
  const stops = getGalaxyStops();
  const superColorMap = new Map<string, string>();
  if (superClusters.length > 0) {
    superClusters.forEach((sc, i) => {
      const t = superClusters.length > 1 ? i / superClusters.length : 0.5;
      superColorMap.set(sc.keyword, sampleMirrored(stops, t));
    });
  }

  let gcx = 0, gcy = 0, gcc = 0;
  clusters.forEach((c) => {
    const cen = centroids.get(c.id);
    if (cen) { gcx += cen.x; gcy += cen.y; gcc++; }
  });
  if (gcc > 0) { gcx /= gcc; gcy /= gcc; }

  const colorMap = new Map<string, string>();
  clusters.forEach((c) => {
    const scColor = c.super_cluster ? superColorMap.get(c.super_cluster) : undefined;
    if (scColor) {
      colorMap.set(c.id, scColor);
      return;
    }
    const cen = centroids.get(c.id);
    if (cen) {
      const angle = Math.atan2(cen.y - gcy, cen.x - gcx);
      const t = (angle + Math.PI) / (2 * Math.PI);
      colorMap.set(c.id, sampleMirrored(stops, t));
    } else {
      colorMap.set(c.id, sampleMirrored(stops, 0.5));
    }
  });
  return colorMap;
}

export function isSuperClusterLike(cluster: GraphCluster): boolean {
  return !!cluster.super_cluster;
}

// ── Hull-label wrapping + anchor (vendor :4406-4458) ───────────────────
// SC radial-anchor override, watermark no-go ejection, and the pill-vs-
// label AABB collision loop (vendor :4460-4673) are all nebula/watermark/
// SC-pill concerns -- out of scope for the sandbox bar (spec.md's F2
// section: "NOT in the sandbox bar: nebula, watermarks..."). Every label
// here uses the base "pinned to shrinkwrap anchor" position the vendor
// itself falls back to when none of that machinery moves it.

export const HULL_LABEL_WRAP_LIMIT = 18; // vendor :4425
export const HULL_LABEL_LINE_HEIGHT = 12; // vendor :4431 (lineH)
export const HULL_LABEL_TO_CLUSTER_GAP = 16; // vendor :4418 (LABEL_TO_CLUSTER_GAP)

export interface HullLabelLayout {
  clusterId: string;
  x: number;
  y: number;
  lines: string[];
  lineH: number;
  pageCount: number;
  isSuperClusterLike: boolean;
  // Raw 10th-percentile cluster top, BEFORE the gap/line-count adjustment
  // baked into `y` -- vendor :4456 `clusterTopY: effectiveTop`, stashed on
  // the DOM node (`data-cluster-top-y`) so Zoom.tsx's screen-clamped
  // font-scale pass (vendor's updateLabelScale, :1319-1357) can recompute
  // the anchor at the CURRENT (zoom-scaled) lineH/gap instead of the fixed
  // ones baked in below.
  clusterTopY: number;
}

/** Word-wrap a cluster name at HULL_LABEL_WRAP_LIMIT chars/line (vendor
 *  :4419-4430, flat limit -- the SC-pill-specific fixed-width wrap was
 *  retired alongside the pill background, see vendor's own "Rethink R5"
 *  comment there). */
export function wrapClusterLabel(name: string): string[] {
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > HULL_LABEL_WRAP_LIMIT && cur.length > 0) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Anchor position for one cluster's hull-label group, given its member
 *  page positions (vendor :4406-4458's base/no-SC-override/no-collision-
 *  loop path: centroid-x, 10th-percentile-top-y minus the cluster gap). */
export function computeHullLabelLayout(cluster: GraphCluster, memberPoints: Array<[number, number]>): HullLabelLayout | null {
  if (memberPoints.length < 2) return null; // vendor :4374's >= 2 points gate
  let lx = 0;
  memberPoints.forEach((p) => { lx += p[0]; });
  lx /= memberPoints.length;
  const ys = memberPoints.map((p) => p[1]).sort((a, b) => a - b);
  const effectiveTop = ys[Math.floor(ys.length * 0.1)];
  const name = cluster.name || cluster.id || "";
  const lines = wrapClusterLabel(name);
  const anchorY = effectiveTop - HULL_LABEL_TO_CLUSTER_GAP - 2 - (lines.length - 1) * (HULL_LABEL_LINE_HEIGHT / 2);
  return {
    clusterId: cluster.id,
    x: lx,
    y: anchorY,
    lines,
    lineH: HULL_LABEL_LINE_HEIGHT,
    pageCount: cluster.page_ids.length,
    isSuperClusterLike: isSuperClusterLike(cluster),
    clusterTopY: effectiveTop,
  };
}

// ── Cluster centroid from ACTUAL node positions (vendor :1725-1737) ────
// Distinct from useForceLayout's Phase-1 centroids (which seed Phase 2
// before the sim relaxes anything): this reads settled/current positions,
// same as the vendor's own computeClusterCentroids call inside drawHulls/
// assignClusterColors (both run post-layout).

export function computeClusterPositionCentroids(
  clusters: GraphCluster[],
  positions: Map<string, { x: number; y: number }>
): Map<string, { x: number; y: number }> {
  const centroids = new Map<string, { x: number; y: number }>();
  clusters.forEach((c) => {
    let cx = 0, cy = 0, cnt = 0;
    c.page_ids.forEach((pid) => {
      const pos = positions.get(pid);
      if (pos) { cx += pos.x; cy += pos.y; cnt++; }
    });
    if (cnt > 0) centroids.set(c.id, { x: cx / cnt, y: cy / cnt });
  });
  return centroids;
}

// ── Page-count LOD fade (vendor :1479-1499) ─────────────────────────────

/** Opacity multiplier for a cluster's hull-label given the current zoom
 *  ratio -- smaller clusters fade out first as the user zooms out. */
export function hullLabelLodOpacity(pageCount: number, ratio: number): number {
  const threshold = Math.max(0, GRAPH_DEFAULTS.LOD_BASE_THRESHOLD / Math.pow(ratio, GRAPH_DEFAULTS.LOD_POWER));
  if (pageCount >= threshold) return 1;
  const below = threshold - pageCount;
  return below >= GRAPH_DEFAULTS.LOD_FADE_RANGE ? 0 : 1 - below / GRAPH_DEFAULTS.LOD_FADE_RANGE;
}

// ── Zoom-out floor + fit-to-content padding (vendor :216-233, plain
//    module `var`s -- not GRAPH_DEFAULTS keys, so hardcoded here too) ───

export const MIN_ZOOM_RATIO = 0.5; // vendor :233
