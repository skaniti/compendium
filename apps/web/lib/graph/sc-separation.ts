/**
 * SC layout separation geometry (vendor delta #32; spec
 * docs/project-plans/2026-08-10-162433-sc-layout-separation/spec.md).
 * Pure functions, no DOM. Screen-px footprints are estimated from the SAME
 * constants drawWatermarks paints with, evaluated at a zoom RATIO
 * (currentZoomK / fitZoom) -- the plate is screen-clamped by clampedScale, so
 * its screen size is a function of the ratio alone. The 0.5 floor
 * (MIN_ZOOM_RATIO) is the single binding constraint: screen separation grows
 * proportionally to k while footprints grow at most proportionally, so a
 * layout clear at the floor is clear at every zoom (spec, "monotonicity").
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

export function plateFootprintAtRatio(keyword: string, ratio: number, p: FootprintParams): PlateFootprint {
  const iconRatio = clampRatio(ratio, p.scIcon);
  const nameRatio = clampRatio(ratio, p.scName);
  const iconPx = p.baseIconSize * iconRatio;
  const fontPx = p.baseNameFontPx * nameRatio;
  const lines = estimateNameLines((keyword || "").slice(0, NAME_MAX_CHARS), p.lineBudget);
  let maxLen = 0;
  for (const l of lines) if (l.length > maxLen) maxLen = l.length;
  const nameW = maxLen * fontPx * p.charAdvanceEm;
  const nameH = lines.length * fontPx * NAME_LINE_HEIGHT_EM;
  const halfW = Math.max(iconPx / 2, nameW / 2) + p.pad;
  return {
    left: -halfW,
    right: halfW,
    top: -iconPx / 2 - p.pad,
    bottom: iconPx / 2 + p.labelTopPad * iconRatio + nameH + p.pad,
  };
}

export function plateRect(x: number, y: number, fp: PlateFootprint): Rect {
  return { minX: x + fp.left, maxX: x + fp.right, minY: y + fp.top, maxY: y + fp.bottom };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function byPriority(a: SeparationPlate, b: SeparationPlate): number {
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
  const order = plates.slice().sort(byPriority);
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

/**
 * Smallest zoom ratio r in [rMin, rMax] (step) at which `key`'s plate is
 * clear of every anchored plate, given WORLD anchors and the fit scale
 * (screen position = anchor * kFit * r). Infinity if never clear.
 */
export function computeExileRatio(
  key: string,
  anchors: Record<string, { x: number; y: number }>,
  anchoredKeys: string[],
  p: FootprintParams,
  kFit: number,
  rMin: number,
  rMax: number,
  step = 0.01,
): number {
  const me = anchors[key];
  if (!me) return Infinity;
  const others = anchoredKeys.filter((k) => k !== key && anchors[k]);
  const n = Math.max(0, Math.round((rMax - rMin) / step));
  for (let i = 0; i <= n; i++) {
    const r = rMin + i * step;
    const k = kFit * r;
    const mine = plateRect(me.x * k, me.y * k, plateFootprintAtRatio(key, r, p));
    let clear = true;
    for (const o of others) {
      const a = anchors[o];
      if (rectsOverlap(mine, plateRect(a.x * k, a.y * k, plateFootprintAtRatio(o, r, p)))) { clear = false; break; }
    }
    if (clear) return r;
  }
  return Infinity;
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

function segmentsCross(a1x: number, a1y: number, b1x: number, b1y: number, a2x: number, a2y: number, b2x: number, b2y: number): boolean {
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
