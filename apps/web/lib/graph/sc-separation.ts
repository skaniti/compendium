/**
 * SC layout separation geometry (vendor delta #32; spec:
 * the 2026-08-10 sc-layout-separation plan (private), spec.md).
 * Pure functions, no DOM. Screen-px footprints are estimated from the SAME
 * constants drawWatermarks paints with, evaluated at a zoom RATIO
 * (currentZoomK / fitZoom) -- the plate is screen-clamped by clampedScale, so
 * its screen size is a function of the ratio alone. Since vendor delta #36
 * the base sizes in FootprintParams arrive pre-multiplied by the
 * canvas-derived plate-fit scale, so ratio 1.0 is the plate as painted at
 * fit on the CURRENT canvas. The 0.5 floor (MIN_ZOOM_RATIO) is the single
 * binding constraint: screen separation grows proportionally to k while
 * footprints grow at most proportionally, so a layout clear at the floor is
 * clear at every zoom (spec, "monotonicity").
 */

export interface ScaleBand { k_min: number; k_max: number }
export interface FootprintParams {
  baseIconSize: number;
  baseNameFontPx: number;
  labelTopPad: number;
  lineBudget: number;
  charAdvanceEm: number;
  scIcon: ScaleBand;
  scName: ScaleBand;
  pad: number;
}
export interface PlateFootprint { left: number; right: number; top: number; bottom: number }
export interface Rect { minX: number; minY: number; maxX: number; maxY: number }
export interface SeparationPlate { key: string; pages: number; x: number; y: number; fp: PlateFootprint; budget: number }
export interface SeparationResult { shifts: Record<string, { dx: number; dy: number }>; overflow: string[]; passes: number }
export interface RingItem { key: string; angle: number; halfAngle: number }

const NAME_MAX_CHARS = 36;      // drawWatermarks: rawName.slice(0, 36)
const NAME_LINE_HEIGHT_EM = 1.25; // tspan dy is 1.15em but the painted line box measured ~1.24em at the floor (Almagest; Task 6 real-data floor check) -- estimator must not undershoot
const RESOLVE_EPS = 0.5;        // px added to a penetration so the pair ends strictly clear

export function clampRatio(ratio: number, band: ScaleBand): number {
  if (ratio < band.k_min) return band.k_min;
  if (ratio > band.k_max) return band.k_max;
  return ratio;
}

/** Same greedy word wrap as vendor estimateLabelLines / wrapLabelLines. */
export function estimateNameLines(name: string, maxChars: number): string[] {
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

/**
 * Footprint from painted sizes (screen px), relative to the icon center.
 * `nameHidden` drops the name and the icon->name pad (an icon-only plate).
 * Same estimator plateFootprintAtRatio has always used.
 */
export function plateFootprintPx(
  keyword: string, iconPx: number, namePx: number, padPx: number, nameHidden: boolean, p: FootprintParams,
): PlateFootprint {
  let nameW = 0, nameH = 0;
  if (!nameHidden) {
    const lines = estimateNameLines((keyword || "").slice(0, NAME_MAX_CHARS), p.lineBudget);
    let maxLen = 0;
    for (const l of lines) if (l.length > maxLen) maxLen = l.length;
    nameW = maxLen * namePx * p.charAdvanceEm;
    nameH = lines.length * namePx * NAME_LINE_HEIGHT_EM;
  }
  const halfW = Math.max(iconPx / 2, nameW / 2) + p.pad;
  return {
    left: -halfW,
    right: halfW,
    top: -iconPx / 2 - p.pad,
    bottom: iconPx / 2 + (nameHidden ? 0 : padPx) + nameH + p.pad,
  };
}

export function plateFootprintAtRatio(keyword: string, ratio: number, p: FootprintParams): PlateFootprint {
  const iconRatio = clampRatio(ratio, p.scIcon);
  const nameRatio = clampRatio(ratio, p.scName);
  return plateFootprintPx(keyword, p.baseIconSize * iconRatio, p.baseNameFontPx * nameRatio, p.labelTopPad * iconRatio, false, p);
}

export function plateRect(x: number, y: number, fp: PlateFootprint): Rect {
  return { minX: x + fp.left, maxX: x + fp.right, minY: y + fp.top, maxY: y + fp.bottom };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Shared priority order: more pages first, then keyword ascending. */
export function byPagesThenKey(a: { key: string; pages: number }, b: { key: string; pages: number }): number {
  if (b.pages !== a.pages) return b.pages - a.pages;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Deterministic pairwise separation with per-plate shift budgets. Plates
 * are visited in priority order (pages desc, key asc). For an overlapping
 * pair the move is along the min-penetration axis (same rule as the R6
 * resolver), split half/half, each half capped by that plate's remaining
 * budget; the other plate absorbs what its partner cannot. A pair whose
 * combined remaining budget cannot cover the penetration is NOT forced:
 * the lower-priority plate is marked overflow (it will exile) and excluded
 * from further resolution.
 */
export function solveSeparation(plates: SeparationPlate[], opts?: { maxPasses?: number }): SeparationResult {
  const maxPasses = opts?.maxPasses ?? 64;
  const order = plates.slice().sort(byPagesThenKey);
  const pos: Record<string, { x: number; y: number }> = {};
  const used: Record<string, number> = {};
  const overflow = new Set<string>();
  for (const p of order) { pos[p.key] = { x: p.x, y: p.y }; used[p.key] = 0; }

  let passes = 0;
  for (; passes < maxPasses; ) {
    passes++;
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      const pi = order[i];
      if (overflow.has(pi.key)) continue;
      for (let j = i + 1; j < order.length; j++) {
        const pj = order[j];
        if (overflow.has(pj.key)) continue;
        const ri = plateRect(pos[pi.key].x, pos[pi.key].y, pi.fp);
        const rj = plateRect(pos[pj.key].x, pos[pj.key].y, pj.fp);
        if (!rectsOverlap(ri, rj)) continue;
        // Penetration on each axis and the direction that moves pj away from pi.
        const penRight = ri.maxX - rj.minX; // pj moves +x
        const penLeft = rj.maxX - ri.minX;  // pj moves -x
        const penDown = ri.maxY - rj.minY;  // pj moves +y
        const penUp = rj.maxY - ri.minY;    // pj moves -y
        const penX = Math.min(penRight, penLeft);
        const penY = Math.min(penDown, penUp);
        let ax = 0, ay = 0, need = 0;
        if (penX <= penY) { ax = penRight <= penLeft ? 1 : -1; need = penX; }
        else { ay = penDown <= penUp ? 1 : -1; need = penY; }
        need += RESOLVE_EPS;
        const remI = Math.max(0, pi.budget - used[pi.key]);
        const remJ = Math.max(0, pj.budget - used[pj.key]);
        let shareJ = Math.min(need / 2, remJ);
        let shareI = Math.min(need - shareJ, remI);
        if (shareI + shareJ < need - 1e-9) {
          // Partner has budget left but pj is capped: let pi absorb more.
          shareJ = Math.min(need - shareI, remJ);
        }
        if (shareI + shareJ < need - 1e-9) {
          overflow.add(pj.key);
          continue;
        }
        pos[pj.key].x += ax * shareJ; pos[pj.key].y += ay * shareJ;
        pos[pi.key].x -= ax * shareI; pos[pi.key].y -= ay * shareI;
        used[pj.key] += shareJ; used[pi.key] += shareI;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Safety: anything still overlapping after maxPasses -> lower priority overflows.
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const pi = order[i], pj = order[j];
      if (overflow.has(pi.key) || overflow.has(pj.key)) continue;
      if (rectsOverlap(plateRect(pos[pi.key].x, pos[pi.key].y, pi.fp), plateRect(pos[pj.key].x, pos[pj.key].y, pj.fp))) overflow.add(pj.key);
    }
  }
  const shifts: Record<string, { dx: number; dy: number }> = {};
  for (const p of order) {
    shifts[p.key] = overflow.has(p.key)
      ? { dx: 0, dy: 0 }
      : { dx: pos[p.key].x - p.x, dy: pos[p.key].y - p.y };
  }
  return { shifts, overflow: order.filter((p) => overflow.has(p.key)).map((p) => p.key), passes };
}

function wrapAngle(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/**
 * Order-preserving 1D relaxation on a circle: adjacent items (sorted by
 * angle, wrap-around included) are pushed apart equally until each gap is
 * at least the sum of their half-angles. Deterministic, converges in a few
 * dozen iterations for realistic counts.
 */
export function spaceOnRing(items: RingItem[], iterations = 32): Record<string, number> {
  const sorted = items.slice().sort((a, b) => a.angle - b.angle || (a.key < b.key ? -1 : 1));
  const ang = sorted.map((it) => it.angle);
  const n = sorted.length;
  if (n >= 2) {
    let demand = 0;
    for (const it of sorted) demand += 2 * it.halfAngle;
    const cap = 2 * Math.PI * 0.98;
    const half = sorted.map((it) => (demand > cap ? it.halfAngle * (cap / demand) : it.halfAngle));
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let gap = ang[j] - ang[i];
        if (j === 0) gap += 2 * Math.PI;
        const need = half[i] + half[j];
        if (gap < need - 1e-9) {
          const push = (need - gap) / 2;
          ang[i] -= push; ang[j] += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  const out: Record<string, number> = {};
  sorted.forEach((it, i) => { out[it.key] = wrapAngle(ang[i]); });
  return out;
}

/** Point where the ray from (cx,cy) along unit (dx,dy) leaves rect r. */
export function rayExitFromRect(cx: number, cy: number, dx: number, dy: number, r: Rect): { x: number; y: number } {
  const tx = dx > 0 ? (r.maxX - cx) / dx : dx < 0 ? (r.minX - cx) / dx : Infinity;
  const ty = dy > 0 ? (r.maxY - cy) / dy : dy < 0 ? (r.minY - cy) / dy : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  if (!isFinite(t)) return { x: cx, y: cy };
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Segment from outside point a to inside point b: the boundary crossing on r. */
export function clipSegmentToRect(ax: number, ay: number, bx: number, by: number, r: Rect): { x: number; y: number } {
  const dx = ax - bx, dy = ay - by;
  const len = Math.hypot(dx, dy) || 1;
  return rayExitFromRect(bx, by, dx / len, dy / len, r);
}

export function segmentsCross(a1x: number, a1y: number, b1x: number, b1y: number, a2x: number, a2y: number, b2x: number, b2y: number): boolean {
  const d = (p: number, q: number, r: number, s: number, x: number, y: number) => (r - p) * (y - q) - (s - q) * (x - p);
  const d1 = d(a2x, a2y, b2x, b2y, a1x, a1y), d2 = d(a2x, a2y, b2x, b2y, b1x, b1y);
  const d3 = d(a1x, a1y, b1x, b1y, a2x, a2y), d4 = d(a1x, a1y, b1x, b1y, b2x, b2y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Leader uncrossing: leaders run from an inside anchor (ax,ay) to an outside
 * plate point (px,py). Two crossing leaders are uncrossed by swapping their
 * plate points (a classic 2-opt); repeated until no pair crosses or the
 * iteration cap is hit. Deterministic: items are visited in key order.
 */
export function uncrossSegments(items: Array<{ key: string; ax: number; ay: number; px: number; py: number }>): Record<string, { px: number; py: number }> {
  const sorted = items.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const p = sorted.map((it) => ({ px: it.px, py: it.py }));
  const n = sorted.length;
  for (let iter = 0; iter < n * n; iter++) {
    let swapped = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (segmentsCross(sorted[i].ax, sorted[i].ay, p[i].px, p[i].py, sorted[j].ax, sorted[j].ay, p[j].px, p[j].py)) {
        const t = p[i]; p[i] = p[j]; p[j] = t; swapped = true;
      }
    }
    if (!swapped) break;
  }
  const out: Record<string, { px: number; py: number }> = {};
  sorted.forEach((it, i) => { out[it.key] = p[i]; });
  return out;
}

export interface ExileItem { key: string; ax: number; ay: number; fp: PlateFootprint } // fp in SCREEN px
export interface ExileViewport { a: number; d: number; e: number; f: number; left: number; top: number; width: number; height: number; marginPx: number }
export interface ExileEnv { cx: number; cy: number; bbox: Rect; k: number; marginPx: number; viewport?: ExileViewport }
export interface ExilePlacement { x: number; y: number; angle: number; radius: number }

/** Largest t in [0, tMax] such that a plate of screen half-sizes (hw, hh)
 *  centered on C + u*t stays inside the viewport minus its margin; NaN if
 *  no t in range satisfies both axes. */
function radialFit(env: ExileEnv, ux: number, uy: number, hw: number, hh: number, tMax: number): number {
  const vp = env.viewport!;
  let lo = 0, hi = tMax;
  const axis = (scale: number, offset: number, c: number, u: number, half: number, extent: number) => {
    // screen = scale*(c + u t) + offset; require margin+half <= screen <= extent-margin-half
    const minS = vp.marginPx + half, maxS = extent - vp.marginPx - half;
    const su = scale * u;
    if (Math.abs(su) < 1e-12) {
      const s = scale * c + offset;
      if (s < minS || s > maxS) { lo = 1; hi = 0; }
      return;
    }
    const t1 = (minS - scale * c - offset) / su, t2 = (maxS - scale * c - offset) / su;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
  };
  axis(vp.a, vp.e - vp.left, env.cx, ux, hw, vp.width);
  axis(vp.d, vp.f - vp.top, env.cy, uy, hh, vp.height);
  return lo <= hi ? hi : NaN;
}

/**
 * Peripheral placement for exiled plates. Each plate gets a ring SLOT (an
 * angle around the cloud centroid, initially its anchor's bearing) and a
 * radius = the ray's exit from the cloud bbox + (margin + its own
 * half-diagonal)/k, radially clamped into the viewport (angle preserved).
 * Slots are spaced order-preservingly with each plate's own half-angle at
 * its own radius; leaders (anchor -> clipped plate edge) that still cross
 * swap SLOTS, and the loop re-spaces. Bounded iterations; deterministic.
 */
export function placeExiledPlates(items: ExileItem[], env: ExileEnv, iterations = 3): Record<string, ExilePlacement> {
  const sorted = items.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = sorted.length;
  const k = env.k || 1;
  const hw = sorted.map((it) => (it.fp.right - it.fp.left) / 2);
  const hh = sorted.map((it) => (it.fp.bottom - it.fp.top) / 2);
  const hd = sorted.map((_, i) => Math.hypot(hw[i], hh[i]));
  let angle = sorted.map((it) => Math.atan2(it.ay - env.cy, it.ax - env.cx));
  const out: Record<string, ExilePlacement> = {};
  let pos: Array<{ x: number; y: number; radius: number }> = [];

  const place = () => {
    pos = sorted.map((_, i) => {
      const ux = Math.cos(angle[i]), uy = Math.sin(angle[i]);
      const exit = rayExitFromRect(env.cx, env.cy, ux, uy, env.bbox);
      let R = Math.hypot(exit.x - env.cx, exit.y - env.cy) + (env.marginPx + hd[i]) / k;
      if (env.viewport) {
        const t = radialFit(env, ux, uy, hw[i], hh[i], R);
        if (!isNaN(t)) R = t; // else: cannot fit on this ray at any radius -- keep the perimeter position
      }
      return { x: env.cx + ux * R, y: env.cy + uy * R, radius: R };
    });
  };
  const leaderEnd = (i: number) => {
    const p = pos[i];
    const r = { minX: p.x - hw[i] / k, maxX: p.x + hw[i] / k, minY: p.y - hh[i] / k, maxY: p.y + hh[i] / k };
    const a = sorted[i];
    if (a.ax >= r.minX && a.ax <= r.maxX && a.ay >= r.minY && a.ay <= r.maxY) return { x: a.ax, y: a.ay };
    return clipSegmentToRect(a.ax, a.ay, p.x, p.y, r);
  };

  for (let iter = 0; iter < Math.max(1, iterations); iter++) {
    place();
    // Space slots with each plate's own half-angle at its own (clamped) radius.
    const spaced = spaceOnRing(sorted.map((it, i) => ({ key: it.key, angle: angle[i], halfAngle: Math.atan2(hd[i] / k, Math.max(pos[i].radius, 1e-9)) })));
    angle = sorted.map((it) => spaced[it.key]);
    place();
    // Uncross on the RENDERED leaders (clipped to plate edges) by swapping slots.
    let swapped = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const ei = leaderEnd(i), ej = leaderEnd(j);
      if (segmentsCross(sorted[i].ax, sorted[i].ay, ei.x, ei.y, sorted[j].ax, sorted[j].ay, ej.x, ej.y)) {
        const t = angle[i]; angle[i] = angle[j]; angle[j] = t; swapped = true;
        place();
      }
    }
    if (!swapped) break;
  }
  place();
  sorted.forEach((it, i) => { out[it.key] = { x: pos[i].x, y: pos[i].y, angle: angle[i], radius: pos[i].radius }; });
  return out;
}
