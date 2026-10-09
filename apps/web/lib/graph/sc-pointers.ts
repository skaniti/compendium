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
