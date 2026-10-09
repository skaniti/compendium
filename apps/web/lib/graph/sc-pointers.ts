/**
 * SC pointer layout (vendor delta #37; spec: the 2026-10-09 sc-pointer-bands
 * plan (private), spec.md). Pure functions, no DOM.
 *
 * Coordinates are SCREEN px relative to the canvas's top-left corner (the
 * search-bar reserve already removed from the height). Footprints are
 * relative to a plate's ICON CENTER, same convention as sc-separation.ts.
 * Sizes are PAINTED px at the current zoom.
 *
 * Three steps, each its own export so the vendor and tests can drive them:
 *  1. selectPointers -- one shared crowd scale `c` for plates in place, then
 *     plates become pointers one at a time (lowest priority first), with
 *     hysteresis on the way back.
 *  2. layoutBands -- pointers go into the free bands between the graph core
 *     and the canvas edge: own side first, one column, then two, then the
 *     next-nearest band.
 *  3. placePointers -- the size schedule around layoutBands: graded shrink
 *     by cluster size, then hide names smallest-first, then shrink icons,
 *     then report a ring fallback.
 */
import { plateRect, rectsOverlap, type PlateFootprint, type Rect } from "./sc-separation";

export interface BaseSizes { iconPx: number; namePx: number; padPx: number }
export interface PlateSizes extends BaseSizes { nameHidden: boolean }
export type FootprintOf = (key: string, sizes: PlateSizes) => PlateFootprint;
/** A painted SC: anchor in screen px. */
export interface ScPlate { key: string; pages: number; x: number; y: number }

/** Sizes at fraction `f` of the full in-place size. Names stop at
 *  `nameFloorPx` (or at their full size, if that is already smaller). */
export function sizesAt(base: BaseSizes, f: number, nameFloorPx: number, nameHidden = false): PlateSizes {
  const floor = Math.min(base.namePx, nameFloorPx);
  return { iconPx: base.iconPx * f, namePx: Math.max(base.namePx * f, floor), padPx: base.padPx * f, nameHidden };
}

/** Scale a footprint about its icon center by (1 + by). */
export function inflate(fp: PlateFootprint, by: number): PlateFootprint {
  const m = 1 + by;
  return { left: fp.left * m, right: fp.right * m, top: fp.top * m, bottom: fp.bottom * m };
}

/** More pages first, then keyword ascending (sc-separation's solveSeparation order). */
export function byPriority(a: ScPlate, b: ScPlate): number {
  if (b.pages !== a.pages) return b.pages - a.pages;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** True when every pair of plates is disjoint at scale `f` (footprints inflated by `inflateBy`). */
export function clearAt(
  plates: ScPlate[], base: BaseSizes, f: number, nameFloorPx: number, footprintOf: FootprintOf, inflateBy = 0,
): boolean {
  const rects = plates.map((p) => plateRect(p.x, p.y, inflate(footprintOf(p.key, sizesAt(base, f, nameFloorPx)), inflateBy)));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i], rects[j])) return false;
  return true;
}

/** Largest scale in [floor, 1] at which `plates` clear (bisection to 0.005). Returns `floor` when even the floor collides. */
export function crowdScale(plates: ScPlate[], base: BaseSizes, nameFloorPx: number, footprintOf: FootprintOf, floor: number): number {
  if (clearAt(plates, base, 1, nameFloorPx, footprintOf)) return 1;
  let lo = floor, hi = 1;
  for (let i = 0; i < 30 && hi - lo > 0.005; i++) {
    const mid = (lo + hi) / 2;
    if (clearAt(plates, base, mid, nameFloorPx, footprintOf)) lo = mid; else hi = mid;
  }
  return lo;
}

export interface SelectInput {
  plates: ScPlate[];
  base: BaseSizes;
  nameFloorPx: number;
  footprintOf: FootprintOf;
  crowdFloor: number;
  hysteresis: number;
  prevPointers: ReadonlySet<string>;
}
export interface SelectResult { c: number; inPlace: string[]; pointers: string[] }

/** Which plates stay in place and at what shared scale. Previous pointers
 *  return (highest priority first) only if the in-place set still clears at
 *  the floor with every footprint inflated by `hysteresis`; then, while the
 *  in-place set collides at the floor, its lowest-priority colliding plate
 *  becomes a pointer. Lists come back in priority order. */
export function selectPointers(inp: SelectInput): SelectResult {
  const order = inp.plates.slice().sort(byPriority);
  const isPtr = new Set(order.filter((p) => inp.prevPointers.has(p.key)).map((p) => p.key));
  const inPlace = () => order.filter((p) => !isPtr.has(p.key));
  for (const p of order) {
    if (!isPtr.has(p.key)) continue;
    if (clearAt(inPlace().concat([p]), inp.base, inp.crowdFloor, inp.nameFloorPx, inp.footprintOf, inp.hysteresis)) isPtr.delete(p.key);
  }
  for (;;) {
    const ip = inPlace();
    const rects = ip.map((p) => plateRect(p.x, p.y, inp.footprintOf(p.key, sizesAt(inp.base, inp.crowdFloor, inp.nameFloorPx))));
    let victim: string | null = null;
    for (let i = ip.length - 1; i >= 0 && victim === null; i--) {
      for (let j = 0; j < ip.length; j++) {
        if (j !== i && rectsOverlap(rects[i], rects[j])) { victim = ip[i].key; break; }
      }
    }
    if (victim === null) break;
    isPtr.add(victim);
  }
  const ip = inPlace();
  return {
    c: crowdScale(ip, inp.base, inp.nameFloorPx, inp.footprintOf, inp.crowdFloor),
    inPlace: ip.map((p) => p.key),
    pointers: order.filter((p) => isPtr.has(p.key)).map((p) => p.key),
  };
}

// ---------------------------------------------------------------- bands

export type BandSide = "L" | "R" | "T" | "B";
export interface Band { side: BandSide; axis: "x" | "y"; edge: number; dir: -1 | 1; thick: number; from: number; to: number }
export interface BandParams { marginPx: number; gapPx: number; layerGapPx: number; itemGapPx: number }
export interface BandItem { key: string; ax: number; ay: number; fp: PlateFootprint }
export interface BandPlacement { key: string; x: number; y: number; side: BandSide; column: 0 | 1 }

const SIDES: BandSide[] = ["L", "R", "T", "B"];

/** The four free bands around `core` in a width x height canvas. Left and
 *  right span the full height; top and bottom span only the core's width. */
export function buildBands(core: Rect, width: number, height: number, p: BandParams): Record<BandSide, Band> {
  const m = p.marginPx, g = p.gapPx;
  return {
    L: { side: "L", axis: "y", edge: core.minX - g, dir: -1, thick: core.minX - g - m, from: m, to: height - m },
    R: { side: "R", axis: "y", edge: core.maxX + g, dir: 1, thick: width - m - core.maxX - g, from: m, to: height - m },
    T: { side: "T", axis: "x", edge: core.minY - g, dir: -1, thick: core.minY - g - m, from: Math.max(m, core.minX), to: Math.min(width - m, core.maxX) },
    B: { side: "B", axis: "x", edge: core.maxY + g, dir: 1, thick: height - m - core.maxY - g, from: Math.max(m, core.minX), to: Math.min(width - m, core.maxX) },
  };
}

/** 1D packing: each item as close to its target center as possible, no
 *  overlaps, `gap` apart, inside [from, to]. Returns start positions in the
 *  given order (callers sort by target), or null when they cannot fit. */
export function packAlong(items: Array<{ target: number; len: number }>, from: number, to: number, gap: number): number[] | null {
  let total = 0;
  for (const it of items) total += it.len;
  if (total + gap * Math.max(0, items.length - 1) > to - from + 1e-6) return null;
  const st = items.map((it) => Math.min(Math.max(it.target - it.len / 2, from), to - it.len));
  for (let i = 1; i < st.length; i++) st[i] = Math.max(st[i], st[i - 1] + items[i - 1].len + gap);
  const last = st.length - 1;
  if (last >= 0 && st[last] + items[last].len > to) st[last] = to - items[last].len;
  for (let j = last - 1; j >= 0; j--) st[j] = Math.min(st[j], st[j + 1] - items[j].len - gap);
  return st;
}

function across(b: Band, fp: PlateFootprint): number { return b.axis === "y" ? fp.right - fp.left : fp.bottom - fp.top; }
function along(b: Band, fp: PlateFootprint): number { return b.axis === "y" ? fp.bottom - fp.top : fp.right - fp.left; }

/** Lay out `items` in one band with 1 or 2 columns (rows for top/bottom).
 *  Items are sorted along the band by anchor; with 2 columns, alternate
 *  items go to the inner (0) and outer (1) column. Null when it does not fit. */
export function layoutBand(band: Band, items: BandItem[], columns: 1 | 2, p: BandParams): BandPlacement[] | null {
  const sorted = items.slice().sort((u, v) => {
    const a = band.axis === "y" ? u.ay : u.ax, b = band.axis === "y" ? v.ay : v.ax;
    return a - b || (u.key < v.key ? -1 : 1);
  });
  const cols: BandItem[][] = columns === 1 ? [sorted] : [sorted.filter((_, i) => i % 2 === 0), sorted.filter((_, i) => i % 2 === 1)];
  const thick = cols.map((col) => col.reduce((t, it) => Math.max(t, across(band, it.fp)), 0));
  const need = thick.reduce((s, t) => s + t, 0) + p.layerGapPx * (cols.length - 1);
  if (need > band.thick + 1e-6) return null;
  const out: BandPlacement[] = [];
  let cursor = band.edge;
  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci];
    if (!col.length) continue;
    const mid = cursor + band.dir * thick[ci] / 2;
    cursor += band.dir * (thick[ci] + p.layerGapPx);
    const st = packAlong(col.map((it) => ({ target: band.axis === "y" ? it.ay : it.ax, len: along(band, it.fp) })), band.from, band.to, p.itemGapPx);
    if (!st) return null;
    col.forEach((it, i) => {
      const column = ci as 0 | 1;
      if (band.axis === "y") out.push({ key: it.key, x: mid - (it.fp.left + it.fp.right) / 2, y: st[i] - it.fp.top, side: band.side, column });
      else out.push({ key: it.key, x: st[i] - it.fp.left, y: mid - (it.fp.top + it.fp.bottom) / 2, side: band.side, column });
    });
  }
  return out;
}

/** Place every pointer in a free band, or null when they cannot all fit.
 *  Each pointer ranks bands by how far its anchor sits toward that side of
 *  the core; a band is usable when at least one pointer fits across and
 *  along it. A band that overflows even with two columns gives up the
 *  pointer that loses least by moving to its next-ranked usable band. */
export function layoutBands(items: BandItem[], core: Rect, width: number, height: number, p: BandParams): BandPlacement[] | null {
  if (!items.length) return [];
  const bands = buildBands(core, width, height, p);
  const open = SIDES.filter((s) => items.some((it) => across(bands[s], it.fp) <= bands[s].thick && along(bands[s], it.fp) <= bands[s].to - bands[s].from));
  if (!open.length) return null;
  const ccx = (core.minX + core.maxX) / 2, ccy = (core.minY + core.maxY) / 2;
  const hw = Math.max(1, (core.maxX - core.minX) / 2), hh = Math.max(1, (core.maxY - core.minY) / 2);
  const ranked = items.map((it) => {
    const nx = (it.ax - ccx) / hw, ny = (it.ay - ccy) / hh;
    const score: Record<BandSide, number> = { L: -nx, R: nx, T: -ny, B: ny };
    const rank = open.slice().sort((a, b) => score[b] - score[a] || SIDES.indexOf(a) - SIDES.indexOf(b));
    return { it, score, rank };
  });
  const assign: Record<string, BandSide> = {};
  ranked.forEach((r) => { assign[r.it.key] = r.rank[0]; });
  for (let move = 0; move <= 2 * items.length; move++) {
    const out: BandPlacement[] = [];
    let failSide: BandSide | null = null;
    for (const side of SIDES) {
      const members = ranked.filter((r) => assign[r.it.key] === side).map((r) => r.it);
      if (!members.length) continue;
      const got = layoutBand(bands[side], members, 1, p) || (members.length > 1 ? layoutBand(bands[side], members, 2, p) : null);
      if (!got) { failSide = side; break; }
      out.push(...got);
    }
    if (!failSide) return out;
    const fs: BandSide = failSide;
    const cands = ranked.filter((r) => assign[r.it.key] === fs).map((r) => {
      const next = r.rank.find((s) => s !== fs && r.rank.indexOf(s) > r.rank.indexOf(fs));
      return { r, next, cost: next ? r.score[fs] - r.score[next] : Infinity };
    }).sort((a, b) => a.cost - b.cost || (a.r.it.key < b.r.it.key ? -1 : 1));
    if (!cands.length || !isFinite(cands[0].cost) || !cands[0].next) return null;
    assign[cands[0].r.it.key] = cands[0].next;
  }
  return null;
}
