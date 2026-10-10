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
import { byPagesThenKey, plateRect, rectsOverlap, type PlateFootprint, type Rect } from "./sc-separation";

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

/** More pages first, then keyword ascending: the same comparator solveSeparation uses. */
export const byPriority: (a: ScPlate, b: ScPlate) => number = byPagesThenKey;

/** Footprint rects of `plates` at scale `f`, each footprint inflated by `inflateBy`. */
function rectsAt(
  plates: ScPlate[], base: BaseSizes, f: number, nameFloorPx: number, footprintOf: FootprintOf, inflateBy = 0,
): Rect[] {
  return plates.map((p) => plateRect(p.x, p.y, inflate(footprintOf(p.key, sizesAt(base, f, nameFloorPx)), inflateBy)));
}

/** True when every pair of plates is disjoint at scale `f` (footprints inflated by `inflateBy`). */
export function clearAt(
  plates: ScPlate[], base: BaseSizes, f: number, nameFloorPx: number, footprintOf: FootprintOf, inflateBy = 0,
): boolean {
  const rects = rectsAt(plates, base, f, nameFloorPx, footprintOf, inflateBy);
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
  /** The previous draw's shared scale and cap (both default 1 = no memory). */
  prevC?: number;
  prevCap?: number;
}
export interface SelectResult { c: number; cap: number; inPlace: string[]; pointers: string[] }

/** Which plates stay in place and at what shared scale. A fixed point: feeding
 *  the result's pointers back in on unchanged geometry returns the same result.
 *  1. In place = painted plates minus previous pointers.
 *  2. Evict at the floor: while two in-place plates collide, the
 *     lowest-priority colliding one becomes a pointer.
 *  3. Re-admit, highest priority first, previous pointers and this call's
 *     victims, against the growing in-place set. A previous pointer needs
 *     slack (its footprint and each neighbour's inflated by `hysteresis`); a
 *     plate evicted this call returns on plain clearance, so greedy
 *     over-eviction is undone. Lists come back in priority order.
 *  4. The shared scale never grows back when a plate leaves (the 2026-10-09
 *     sc-pointer-bands plan, private): a call that turns a new plate into a
 *     pointer caps c at the previous call's c; a pointer returning, or none
 *     left, lifts the cap. c = min(largest clearing scale, cap). */
export function selectPointers(inp: SelectInput): SelectResult {
  const order = inp.plates.slice().sort(byPriority);
  const isPtr = new Set(order.filter((p) => inp.prevPointers.has(p.key)).map((p) => p.key));
  const prev = new Set(isPtr);
  const inPlace = () => order.filter((p) => !isPtr.has(p.key));
  for (;;) {
    const ip = inPlace();
    const rects = rectsAt(ip, inp.base, inp.crowdFloor, inp.nameFloorPx, inp.footprintOf);
    let victim: string | null = null;
    for (let i = ip.length - 1; i >= 0 && victim === null; i--) {
      for (let j = 0; j < ip.length; j++) {
        if (j !== i && rectsOverlap(rects[i], rects[j])) { victim = ip[i].key; break; }
      }
    }
    if (victim === null) break;
    isPtr.add(victim);
  }
  for (const p of order) {
    if (!isPtr.has(p.key)) continue;
    const by = prev.has(p.key) ? inp.hysteresis : 0;
    const own = rectsAt([p], inp.base, inp.crowdFloor, inp.nameFloorPx, inp.footprintOf, by)[0];
    const others = rectsAt(inPlace(), inp.base, inp.crowdFloor, inp.nameFloorPx, inp.footprintOf, by);
    if (!others.some((r) => rectsOverlap(own, r))) isPtr.delete(p.key);
  }
  const ip = inPlace();
  const now = order.filter((q) => isPtr.has(q.key)).map((q) => q.key);
  const prevC = inp.prevC ?? 1;
  const prevCap = inp.prevCap ?? 1;
  let cap: number;
  if (now.length === 0) cap = 1;
  else if (now.some((k) => !prev.has(k))) cap = Math.min(prevCap, prevC);
  else if ([...prev].some((k) => !isPtr.has(k))) cap = 1;
  else cap = prevCap;
  return {
    // The floor wins over a held cap, so a floor raised live never leaves c below it.
    c: Math.max(inp.crowdFloor, Math.min(crowdScale(ip, inp.base, inp.nameFloorPx, inp.footprintOf, inp.crowdFloor), cap)),
    cap,
    inPlace: ip.map((q) => q.key),
    pointers: now,
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
  // Each band's inner edge is clamped into the canvas: a core panned fully
  // off one side must not leave a band whose plates are off the canvas too.
  const lEdge = Math.min(core.minX - g, width - m), rEdge = Math.max(core.maxX + g, m);
  const tEdge = Math.min(core.minY - g, height - m), bEdge = Math.max(core.maxY + g, m);
  const xFrom = Math.min(Math.max(m, core.minX), width - m);
  const xTo = Math.max(xFrom, Math.min(width - m, core.maxX));
  return {
    L: { side: "L", axis: "y", edge: lEdge, dir: -1, thick: lEdge - m, from: m, to: height - m },
    R: { side: "R", axis: "y", edge: rEdge, dir: 1, thick: width - m - rEdge, from: m, to: height - m },
    T: { side: "T", axis: "x", edge: tEdge, dir: -1, thick: tEdge - m, from: xFrom, to: xTo },
    B: { side: "B", axis: "x", edge: bEdge, dir: 1, thick: height - m - bEdge, from: xFrom, to: xTo },
  };
}

/** 1D packing, greedy (not globally optimal): items start at their target
 *  center clamped into [from, to], then are pushed apart `gap` apart, forward
 *  then back, so none overlap. Returns start positions in the
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
/** Whether a pointer fits the band at all, across and along. */
function fits(b: Band, fp: PlateFootprint): boolean {
  return across(b, fp) <= b.thick + 1e-6 && along(b, fp) <= b.to - b.from + 1e-6;
}

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
 *  the core, among only the bands that pointer itself fits across and along
 *  (null when some pointer fits none). A band that overflows even with two columns gives up the
 *  pointer that loses least by moving to its next-ranked usable band. */
export function layoutBands(items: BandItem[], core: Rect, width: number, height: number, p: BandParams): BandPlacement[] | null {
  if (!items.length) return [];
  const bands = buildBands(core, width, height, p);
  const ccx = (core.minX + core.maxX) / 2, ccy = (core.minY + core.maxY) / 2;
  const hw = Math.max(1, (core.maxX - core.minX) / 2), hh = Math.max(1, (core.maxY - core.minY) / 2);
  const ranked = items.map((it) => {
    const nx = (it.ax - ccx) / hw, ny = (it.ay - ccy) / hh;
    const score: Record<BandSide, number> = { L: -nx, R: nx, T: -ny, B: ny };
    const rank = SIDES.filter((s) => fits(bands[s], it.fp)).sort((a, b) => score[b] - score[a] || SIDES.indexOf(a) - SIDES.indexOf(b));
    return { it, score, rank };
  });
  if (ranked.some((r) => !r.rank.length)) return null;
  const assign: Record<string, BandSide> = {};
  ranked.forEach((r) => { assign[r.it.key] = r.rank[0]; });
  for (let move = 0; move <= 3 * items.length; move++) {
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

// ------------------------------------------------------- size schedule

export interface PointerParams {
  sizeMin: number;      // SC_POINTER_SIZE_MIN: graded floor for the smallest SC, fraction of c
  sizeMax: number;      // SC_POINTER_SIZE_MAX: graded floor for the largest SC
  minIconPx: number;    // SC_POINTER_MIN_ICON_PX
  hysteresis: number;   // SC_FLIP_HYSTERESIS (hidden names coming back)
  band: BandParams;
}
export interface PlacePointersInput {
  pointers: ScPlate[];
  c: number;
  base: BaseSizes;
  nameFloorPx: number;
  footprintOf: FootprintOf;
  core: Rect;
  width: number;
  height: number;
  maxPages: number;
  params: PointerParams;
  prevNameHidden: ReadonlySet<string>;
}
export type PointerPhase = "none" | "graded" | "names" | "icons" | "ring";
export interface PlacePointersResult {
  phase: PointerPhase;
  /** Graded crowding level reached (0..1); 1 in the later phases. */
  t: number;
  /** True when no band layout fits: the caller places pointers on the ring. */
  fallback: boolean;
  sizes: Record<string, PlateSizes>;
  placements: Record<string, BandPlacement>;
}

export function gradedFloor(pages: number, maxPages: number, p: PointerParams): number {
  const r = maxPages > 0 ? Math.max(0, Math.min(1, pages / maxPages)) : 1;
  return p.sizeMin + (p.sizeMax - p.sizeMin) * Math.sqrt(r);
}

/** Sizes and band placements for the pointers. Order of escalation:
 *  graded shrink (t = 0..1 in 0.05 steps; small SCs shrink most; names stop
 *  at the floor) -> hide names one at a time, smallest SC first -> shrink
 *  icons together toward minIconPx (10 steps) -> ring fallback. A name
 *  hidden last time comes back only if the layout still fits at the graded
 *  floor with that name's own footprint inflated by `hysteresis`. */
export function placePointers(inp: PlacePointersInput): PlacePointersResult {
  const { pointers, params } = inp;
  if (!pointers.length) return { phase: "none", t: 0, fallback: false, sizes: {}, placements: {} };
  const attempt = (sizes: Record<string, PlateSizes>, inflateKeys?: ReadonlySet<string>): BandPlacement[] | null =>
    layoutBands(
      pointers.map((pt) => ({ key: pt.key, ax: pt.x, ay: pt.y, fp: inflate(inp.footprintOf(pt.key, sizes[pt.key]), inflateKeys && inflateKeys.has(pt.key) ? params.hysteresis : 0) })),
      inp.core, inp.width, inp.height, params.band,
    );
  const toMap = (pl: BandPlacement[]): Record<string, BandPlacement> => {
    const m: Record<string, BandPlacement> = {};
    pl.forEach((b) => { m[b.key] = b; });
    return m;
  };
  const hide = (s: Record<string, PlateSizes>, keys: ReadonlySet<string>): Record<string, PlateSizes> => {
    const o: Record<string, PlateSizes> = {};
    pointers.forEach((pt) => { o[pt.key] = keys.has(pt.key) ? { ...s[pt.key], nameHidden: true } : s[pt.key]; });
    return o;
  };
  const graded = (t: number, noName: ReadonlySet<string> = new Set()): Record<string, PlateSizes> => {
    const s: Record<string, PlateSizes> = {};
    pointers.forEach((pt) => {
      const f = inp.c * (1 - t * (1 - gradedFloor(pt.pages, inp.maxPages, params)));
      s[pt.key] = sizesAt(inp.base, f, inp.nameFloorPx);
    });
    return hide(s, noName);
  };
  // Names hide in this order: fewest pages first, then keyword descending.
  const smallestFirst = pointers.slice().sort((a, b) => byPriority(b, a));

  // Mirrors selectPointers: a name hidden last time returns one at a time,
  // highest priority first, only if the layout still fits at the graded floor
  // (t = 1) with that name's own footprint inflated by `hysteresis`.
  const hidden = new Set(pointers.filter((pt) => inp.prevNameHidden.has(pt.key)).map((pt) => pt.key));
  // The hidden set stays a smallest-first suffix: the pass stops at the first
  // name that cannot return, so a lower-priority name never shows while a
  // higher-priority one is hidden.
  const byPrio = pointers.slice().sort(byPriority);
  const firstHidden = byPrio.findIndex((pt) => hidden.has(pt.key));
  if (firstHidden >= 0) byPrio.slice(firstHidden).forEach((pt) => hidden.add(pt.key));
  for (const pt of byPrio) {
    if (!hidden.has(pt.key)) continue;
    const rest = new Set(hidden);
    rest.delete(pt.key);
    if (!attempt(graded(1, rest), new Set([pt.key]))) break;
    hidden.delete(pt.key);
  }

  // Names are only ever hidden past t = 1, so while any name is still hidden
  // the graded loop is skipped: re-running with the previous result's hidden
  // names must land on the same sizes, not bump the plates back up.
  if (!hidden.size) {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, sizes = graded(t), pl = attempt(sizes);
      if (pl) return { phase: "graded", t, fallback: false, sizes, placements: toMap(pl) };
    }
  }
  let sizes = graded(1, hidden);
  const cumulative = new Set(hidden);
  // Try the still-hidden set as it is first, then hide more smallest-first.
  if (cumulative.size) {
    const pl = attempt(sizes);
    if (pl) return { phase: "names", t: 1, fallback: false, sizes, placements: toMap(pl) };
  }
  for (let j = 0; j < smallestFirst.length; j++) {
    if (cumulative.has(smallestFirst[j].key)) continue;
    cumulative.add(smallestFirst[j].key);
    sizes = graded(1, cumulative);
    const pl = attempt(sizes);
    if (pl) return { phase: "names", t: 1, fallback: false, sizes, placements: toMap(pl) };
  }
  const iconsAtT1 = sizes;
  for (let u = 1; u <= 10; u++) {
    const s: Record<string, PlateSizes> = {};
    pointers.forEach((pt) => {
      const a = iconsAtT1[pt.key];
      const icon = a.iconPx <= params.minIconPx ? a.iconPx : a.iconPx - (u / 10) * (a.iconPx - params.minIconPx);
      s[pt.key] = { ...a, iconPx: icon };
    });
    sizes = s;
    const pl = attempt(sizes);
    if (pl) return { phase: "icons", t: 1, fallback: false, sizes, placements: toMap(pl) };
  }
  return { phase: "ring", t: 1, fallback: true, sizes, placements: {} };
}
