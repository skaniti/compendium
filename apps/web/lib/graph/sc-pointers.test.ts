import { describe, it, expect } from "vitest";
import {
  sizesAt, inflate, clearAt, crowdScale, selectPointers, buildBands, packAlong, layoutBand, layoutBands,
  gradedFloor, placePointers,
  type BaseSizes, type FootprintOf, type ScPlate, type BandParams, type BandItem, type PointerParams,
} from "./sc-pointers";
import { plateRect, rectsOverlap, type PlateFootprint, type Rect } from "./sc-separation";

// Test geometry: a square icon, the name stacked under it (pad + one line).
// Full size: 40 wide, 60 tall, footprint relative to the icon center.
const BASE: BaseSizes = { iconPx: 40, namePx: 20, padPx: 0 };
const FLOOR_PX = 12;
const fpOf: FootprintOf = (_key, s) => ({
  left: -s.iconPx / 2, right: s.iconPx / 2, top: -s.iconPx / 2,
  bottom: s.iconPx / 2 + (s.nameHidden ? 0 : s.padPx + s.namePx),
});
const plate = (key: string, pages: number, x: number, y: number): ScPlate => ({ key, pages, x, y });

const BAND: BandParams = { marginPx: 10, gapPx: 10, layerGapPx: 5, itemGapPx: 5 };
const PTR: PointerParams = { sizeMin: 0.35, sizeMax: 0.75, minIconPx: 8, hysteresis: 0.04, band: BAND };

function noOverlaps(fps: Array<{ x: number; y: number; fp: PlateFootprint }>): boolean {
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
    if (rectsOverlap(plateRect(fps[i].x, fps[i].y, fps[i].fp), plateRect(fps[j].x, fps[j].y, fps[j].fp))) return false;
  }
  return true;
}
function clearOfCore(out: Array<{ x: number; y: number; key: string }>, core: Rect): boolean {
  return out.every((o) => !rectsOverlap(plateRect(o.x, o.y, fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX))), core));
}
function inside(r: Rect, w: number, h: number): boolean {
  return r.minX >= -1e-6 && r.minY >= -1e-6 && r.maxX <= w + 1e-6 && r.maxY <= h + 1e-6;
}

describe("sizesAt / inflate", () => {
  it("scales icon and pad by f and stops the name at the floor", () => {
    expect(sizesAt(BASE, 0.5, FLOOR_PX)).toEqual({ iconPx: 20, namePx: 12, padPx: 0, nameHidden: false });
    expect(sizesAt(BASE, 1, FLOOR_PX).namePx).toBe(20);
  });
  it("never enlarges a name that is already under the floor", () => {
    expect(sizesAt({ iconPx: 40, namePx: 10, padPx: 4 }, 0.5, FLOOR_PX).namePx).toBe(10);
  });
  it("inflates a footprint about the icon center", () => {
    expect(inflate({ left: -10, right: 10, top: -5, bottom: 20 }, 0.1)).toEqual({ left: -11, right: 11, top: -5.5, bottom: 22 });
  });
});

describe("crowdScale", () => {
  it("is 1 when plates clear at full size", () => {
    expect(crowdScale([plate("a", 1, 0, 0), plate("b", 1, 100, 0)], BASE, FLOOR_PX, fpOf, 0.5)).toBe(1);
  });
  it("finds the largest clearing scale to within 0.005", () => {
    // 40f <= 35 -> f <= 0.875
    const c = crowdScale([plate("a", 1, 0, 0), plate("b", 1, 35, 0)], BASE, FLOOR_PX, fpOf, 0.5);
    expect(c).toBeLessThanOrEqual(0.875);
    expect(c).toBeGreaterThan(0.87);
    expect(clearAt([plate("a", 1, 0, 0), plate("b", 1, 35, 0)], BASE, c, FLOOR_PX, fpOf)).toBe(true);
  });
  it("returns the floor when even the floor collides", () => {
    expect(crowdScale([plate("a", 1, 0, 0), plate("b", 1, 10, 0)], BASE, FLOOR_PX, fpOf, 0.5)).toBe(0.5);
  });
});

describe("selectPointers crowd-scale cap", () => {
  // Three in a row at spacing s: 40f <= s clears at scale f; floor width is 20.
  const row = (s: number) => [plate("a", 30, 0, 0), plate("b", 20, s, 0), plate("c", 10, 2 * s, 0)];
  type St = { pointers: string[]; c: number; cap: number };
  const step = (s: number, st: St | null) =>
    selectPointers({
      plates: row(s), base: BASE, nameFloorPx: FLOOR_PX, footprintOf: fpOf, crowdFloor: 0.5, hysteresis: 0.04,
      prevPointers: new Set(st ? st.pointers : []), prevC: st?.c, prevCap: st?.cap,
    });

  it("c does not grow back across the call where a plate becomes a pointer", () => {
    let st: St | null = null;
    let last = Infinity;
    for (const s of [40, 36, 30, 26, 22, 19, 18]) {
      const r = step(s, st);
      expect(r.c).toBeLessThanOrEqual(last + 1e-9);
      last = r.c;
      st = { pointers: r.pointers, c: r.c, cap: r.cap };
    }
    expect(st!.pointers.length).toBeGreaterThan(0);
  });
  it("lifts the cap when the pointer returns, and c follows the clearing scale again", () => {
    let st: St | null = null;
    for (const s of [40, 30, 22, 19]) { const r = step(s, st); st = { pointers: r.pointers, c: r.c, cap: r.cap }; }
    expect(st!.pointers).toEqual(["b"]);
    expect(st!.cap).toBeLessThan(1);
    const back = step(24, st);
    expect(back.pointers).toEqual([]);
    expect(back.cap).toBe(1);
    expect(back.c).toBeCloseTo(0.6, 1);
    expect(step(30, { pointers: back.pointers, c: back.c, cap: back.cap }).c).toBeGreaterThan(0.7);
  });
  it("is a fixed point on c, cap and pointers", () => {
    let st: St | null = null;
    for (const s of [40, 30, 22, 19]) { const r = step(s, st); st = { pointers: r.pointers, c: r.c, cap: r.cap }; }
    const again = step(19, st);
    expect(again.c).toBe(st!.c);
    expect(again.cap).toBe(st!.cap);
    expect(again.pointers).toEqual(st!.pointers);
  });
  it("defaults prevC and prevCap to 1: a fresh call keeps today's largest clearing scale", () => {
    const r = step(19, null);
    expect(r.pointers).toEqual(["b"]);
    expect(r.cap).toBe(1);
    expect(r.c).toBeGreaterThan(0.9);
  });
});

describe("selectPointers", () => {
  const sel = (plates: ScPlate[], prev: string[] = []) =>
    selectPointers({ plates, base: BASE, nameFloorPx: FLOOR_PX, footprintOf: fpOf, crowdFloor: 0.5, hysteresis: 0.04, prevPointers: new Set(prev) });

  it("shrinks before pointing: clear at the floor means no pointers and c < 1", () => {
    const r = sel([plate("a", 30, 0, 0), plate("b", 20, 30, 0), plate("c", 10, 60, 0)]);
    expect(r.pointers).toEqual([]);
    expect(r.c).toBeLessThanOrEqual(0.75);
    expect(r.c).toBeGreaterThan(0.74);
  });
  it("evicts lowest priority first, then over-evicted plates come back", () => {
    // At the floor (20 wide): a-b and b-c overlap, a-c clear. c goes first,
    // then b; c is clear of a alone, so it returns.
    const r = sel([plate("a", 30, 0, 0), plate("b", 20, 15, 0), plate("c", 10, 30, 0)]);
    expect(r.pointers).toEqual(["b"]);
    expect(r.inPlace).toEqual(["a", "c"]);
    expect(r.c).toBeLessThanOrEqual(0.75);
    expect(r.c).toBeGreaterThan(0.74);
  });
  it("breaks page ties by keyword: the later keyword gives way", () => {
    const r = sel([plate("m", 5, 0, 0), plate("z", 5, 5, 0)]);
    expect(r.pointers).toEqual(["z"]);
  });
  it("hysteresis: a pointer returns only with slack beyond the floor", () => {
    // Floor widths 20 each. Gap 20.5 clears plain (20) but not inflated (20.8).
    expect(sel([plate("a", 9, 0, 0), plate("b", 1, 20.5, 0)]).pointers).toEqual([]);
    expect(sel([plate("a", 9, 0, 0), plate("b", 1, 20.5, 0)], ["b"]).pointers).toEqual(["b"]);
    expect(sel([plate("a", 9, 0, 0), plate("b", 1, 21, 0)], ["b"]).pointers).toEqual([]);
  });
  it("ignores previous pointers that are no longer painted", () => {
    expect(sel([plate("a", 9, 0, 0), plate("b", 1, 100, 0)], ["gone"]).pointers).toEqual([]);
  });
  it("is a fixed point: feeding the pointers back returns the same result", () => {
    const geoms = [
      [plate("a", 30, 0, 0), plate("b", 20, 15, 0), plate("c", 10, 30, 0)],
      [plate("a", 9, 0, 0), plate("b", 1, 20.5, 0), plate("c", 5, 200, 0)],
      [plate("a", 9, 0, 0), plate("b", 8, 20.5, 0), plate("c", 1, 12, 0)],
    ];
    for (const g of geoms) {
      const r1 = sel(g);
      expect(sel(g, r1.pointers)).toEqual(r1);
    }
  });
  it("a far-away previous pointer returns despite a tight unrelated in-place pair", () => {
    const g = [plate("a", 9, 0, 0), plate("b", 8, 20.5, 0), plate("p", 1, 500, 0)];
    expect(sel(g, ["p"]).pointers).toEqual([]);
  });
  it("does not depend on input order", () => {
    const g = [plate("a", 30, 0, 0), plate("b", 20, 15, 0), plate("c", 10, 30, 0), plate("d", 5, 45, 0)];
    const r = sel(g);
    expect(sel(g.slice().reverse())).toEqual(r);
    expect(sel([g[2], g[0], g[3], g[1]])).toEqual(r);
  });
  it("uses the floored name width when the name is wider than the icon", () => {
    const wide: FootprintOf = (_k, s) => {
      const w = Math.max(s.iconPx, s.namePx * 3);
      return { left: -w / 2, right: w / 2, top: -s.iconPx / 2, bottom: s.iconPx / 2 };
    };
    // Floor width = max(20, 12*3) = 36; gap 30 collides there although icons (20) would clear.
    const r = selectPointers({ plates: [plate("a", 2, 0, 0), plate("b", 1, 30, 0)], base: BASE, nameFloorPx: FLOOR_PX, footprintOf: wide, crowdFloor: 0.5, hysteresis: 0.04, prevPointers: new Set() });
    expect(r.pointers).toEqual(["b"]);
  });
});

describe("buildBands / packAlong", () => {
  it("builds four bands; top and bottom only span the core's width", () => {
    const b = buildBands({ minX: 100, maxX: 300, minY: 50, maxY: 250 }, 400, 300, BAND);
    expect(b.L).toMatchObject({ edge: 90, dir: -1, thick: 80, from: 10, to: 290 });
    expect(b.R).toMatchObject({ edge: 310, dir: 1, thick: 80, from: 10, to: 290 });
    expect(b.T).toMatchObject({ edge: 40, dir: -1, thick: 30, from: 100, to: 300 });
    expect(b.B).toMatchObject({ edge: 260, dir: 1, thick: 30, from: 100, to: 300 });
  });
  it("packs items near their targets without overlap, inside the range", () => {
    expect(packAlong([{ target: 50, len: 20 }, { target: 55, len: 20 }], 0, 100, 5)).toEqual([40, 65]);
    expect(packAlong([{ target: 95, len: 20 }, { target: 98, len: 20 }], 0, 100, 5)).toEqual([55, 80]);
  });
  it("returns null when the items cannot fit", () => {
    expect(packAlong([1, 2, 3, 4, 5].map(() => ({ target: 50, len: 30 })), 0, 100, 5)).toBeNull();
  });
});

describe("layoutBand", () => {
  const core: Rect = { minX: 200, maxX: 400, minY: 20, maxY: 180 };
  const item = (key: string, ay: number): BandItem => ({ key, ax: 250, ay, fp: fpOf(key, sizesAt(BASE, 1, FLOOR_PX)) });

  it("one column: footprint centers track their anchors, column against the core", () => {
    const L = buildBands(core, 600, 200, BAND).L;
    const out = layoutBand(L, [item("a", 50), item("b", 150)], 1, BAND)!;
    expect(out.map((o) => o.column)).toEqual([0, 0]);
    expect(out[0].x).toBeCloseTo(L.edge - 20, 6);       // edge 190, half-thickness 20
    const fpc = (k: string) => { const o = out.find((q) => q.key === k)!; const f = fpOf(k, sizesAt(BASE, 1, FLOOR_PX)); return o.y + (f.top + f.bottom) / 2; };
    expect(fpc("a")).toBeCloseTo(50, 6);
    expect(fpc("b")).toBeCloseTo(150, 6);
  });
  it("two columns when one is too short, alternating inner/outer", () => {
    const L = buildBands(core, 600, 200, BAND).L;     // along 10..190 = 180: three 60-tall items + gaps = 190
    expect(layoutBand(L, [item("a", 40), item("b", 100), item("c", 160)], 1, BAND)).toBeNull();
    const out = layoutBand(L, [item("a", 40), item("b", 100), item("c", 160)], 2, BAND)!;
    expect(out.map((o) => [o.key, o.column])).toEqual([["a", 0], ["c", 0], ["b", 1]]);
    const inner = out.find((o) => o.key === "a")!.x, outer = out.find((o) => o.key === "b")!.x;
    expect(outer).toBeLessThan(inner);                 // left band: the outer column is further left
  });
  it("null when two columns do not fit across", () => {
    const L = buildBands({ ...core, minX: 90 }, 600, 200, BAND).L;   // thick 70 < 40 + 5 + 40
    expect(layoutBand(L, [item("a", 40), item("b", 100), item("c", 160)], 2, BAND)).toBeNull();
  });
});

describe("layoutBands", () => {
  const full = (key: string, ax: number, ay: number): BandItem => ({ key, ax, ay, fp: fpOf(key, sizesAt(BASE, 1, FLOOR_PX)) });

  it("wide, short canvas: everything goes left/right, nothing top/bottom", () => {
    const core: Rect = { minX: 300, maxX: 500, minY: 20, maxY: 180 };
    const items = [full("a", 320, 60), full("b", 480, 60), full("top", 400, 25), full("c", 330, 150)];
    const out = layoutBands(items, core, 800, 200, BAND)!;
    expect(out).not.toBeNull();
    expect(new Set(out.map((o) => o.side))).toEqual(new Set(["L", "R"]));
    const byKey = Object.fromEntries(out.map((o) => [o.key, o]));
    // Three pointers share the left band (180 tall): one column cannot hold them, two can.
    expect([byKey.top, byKey.a, byKey.c, byKey.b].map((o) => [o.side, o.column])).toEqual([["L", 0], ["L", 1], ["L", 0], ["R", 0]]);
    expect(clearOfCore(out, core)).toBe(true);
    for (const o of out) expect(inside(plateRect(o.x, o.y, fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX))), 800, 200)).toBe(true);
    expect(noOverlaps(out.map((o) => ({ x: o.x, y: o.y, fp: fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX)) })))).toBe(true);
  });
  it("moves a pointer to its next band when its own band overflows", () => {
    // Left band holds two 60-tall items in one column; four left-side anchors, band too thin for two columns.
    const core: Rect = { minX: 70, maxX: 500, minY: 20, maxY: 180 };
    // Distinct anchor x: the one furthest from the left edge (d) loses least by moving, then c.
    const items = [full("a", 60, 40), full("b", 70, 80), full("c", 80, 120), full("d", 90, 160)];
    const out = layoutBands(items, core, 800, 200, BAND)!;
    expect(out).not.toBeNull();
    const side = Object.fromEntries(out.map((o) => [o.key, o.side]));
    expect(side).toEqual({ a: "L", b: "L", c: "R", d: "R" });
    expect(clearOfCore(out, core)).toBe(true);
    expect(noOverlaps(out.map((o) => ({ x: o.x, y: o.y, fp: fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX)) })))).toBe(true);
  });
  it("a core panned partly off-canvas: nothing is placed outside the canvas", () => {
    const core: Rect = { minX: -100, maxX: 300, minY: 20, maxY: 180 };
    const items = [full("a", -50, 60), full("b", 280, 100)];
    const out = layoutBands(items, core, 800, 200, BAND)!;
    expect(out).not.toBeNull();
    expect(out.every((o) => o.side !== "L")).toBe(true);
    expect(clearOfCore(out, core)).toBe(true);
    for (const o of out) expect(inside(plateRect(o.x, o.y, fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX))), 800, 200)).toBe(true);
  });
  it("a core panned fully off one side: placements stay on the canvas", () => {
    const cores: Rect[] = [
      { minX: -600, maxX: -200, minY: 100, maxY: 300 },
      { minX: 900, maxX: 1300, minY: 100, maxY: 300 },
      { minX: 100, maxX: 700, minY: -600, maxY: -200 },
      { minX: 100, maxX: 700, minY: 600, maxY: 1000 },
    ];
    for (const core of cores) {
      const items = [full("a", (core.minX + core.maxX) / 2, (core.minY + core.maxY) / 2), full("b", 400, 200)];
      const out = layoutBands(items, core, 800, 400, BAND)!;
      expect(out).not.toBeNull();
      expect(out.length).toBe(2);
      for (const o of out) expect(inside(plateRect(o.x, o.y, fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX))), 800, 400)).toBe(true);
    }
  });
  it("tall canvas: pointers go top/bottom, near their anchor x", () => {
    const core: Rect = { minX: 10, maxX: 190, minY: 300, maxY: 500 };
    const out = layoutBands([full("a", 50, 100), full("b", 150, 700)], core, 200, 800, BAND)!;
    expect(out).not.toBeNull();
    const byKey = Object.fromEntries(out.map((o) => [o.key, o]));
    expect(byKey.a.side).toBe("T");
    expect(byKey.b.side).toBe("B");
    expect(byKey.a.x).toBeCloseTo(50, 6);
    expect(byKey.b.x).toBeCloseTo(150, 6);
    expect(clearOfCore(out, core)).toBe(true);
    for (const o of out) expect(inside(plateRect(o.x, o.y, fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX))), 200, 800)).toBe(true);
    expect(noOverlaps(out.map((o) => ({ x: o.x, y: o.y, fp: fpOf(o.key, sizesAt(BASE, 1, FLOOR_PX)) })))).toBe(true);
  });
  it("band usability is per pointer: a wide pointer that fits only R does not push a narrow one out of L", () => {
    const core: Rect = { minX: 100, maxX: 600, minY: 20, maxY: 380 };   // L thick 80, R thick 180, T/B 0
    const small = { key: "small", ax: 200, ay: 200, fp: { left: -15, right: 15, top: -15, bottom: 15 } };
    const big = { key: "big", ax: 110, ay: 200, fp: { left: -45, right: 45, top: -15, bottom: 15 } };
    const out = layoutBands([small, big], core, 800, 400, BAND)!;
    expect(out).not.toBeNull();
    const side = Object.fromEntries(out.map((o) => [o.key, o.side]));
    expect(side).toEqual({ small: "L", big: "R" });
  });
  it("null when some pointer fits no band", () => {
    const core: Rect = { minX: 100, maxX: 600, minY: 20, maxY: 380 };
    const huge = { key: "huge", ax: 300, ay: 200, fp: { left: -100, right: 100, top: -15, bottom: 15 } };
    expect(layoutBands([huge, full("a", 300, 200)], { ...core, maxX: 650 }, 800, 400, BAND)).toBeNull();
  });
  it("null when no band is usable", () => {
    expect(layoutBands([full("a", 50, 50)], { minX: 5, maxX: 795, minY: 5, maxY: 195 }, 800, 200, BAND)).toBeNull();
  });
  it("is deterministic and input-order independent", () => {
    const core: Rect = { minX: 300, maxX: 500, minY: 20, maxY: 180 };
    const items = [full("a", 320, 60), full("b", 480, 60), full("c", 330, 150)];
    const byKey = (out: ReturnType<typeof layoutBands>) => Object.fromEntries(out!.map((o) => [o.key, o]));
    expect(byKey(layoutBands(items, core, 800, 200, BAND))).toEqual(byKey(layoutBands(items.slice().reverse(), core, 800, 200, BAND)));
  });
});

describe("placePointers", () => {
  const run = (pointers: ScPlate[], core: Rect, w: number, h: number, prevHidden: string[] = []) =>
    placePointers({
      pointers, c: 1, base: BASE, nameFloorPx: FLOOR_PX, footprintOf: fpOf, core, width: w, height: h,
      maxPages: Math.max(...pointers.map((p) => p.pages), 1), params: PTR, prevNameHidden: new Set(prevHidden),
    });

  it("no pointers: phase none", () => {
    expect(run([], { minX: 0, maxX: 10, minY: 0, maxY: 10 }, 100, 100)).toMatchObject({ phase: "none", fallback: false });
  });
  it("roomy bands: full size, t = 0", () => {
    const r = run([plate("a", 10, 320, 60), plate("b", 5, 480, 60)], { minX: 300, maxX: 500, minY: 20, maxY: 180 }, 800, 200);
    expect(r).toMatchObject({ phase: "graded", t: 0, fallback: false });
    expect(r.sizes.a.iconPx).toBe(40);
  });
  it("two columns come before any shrinking", () => {
    // Left band: 180 along, 3 items of 60 + gaps do not fit in one column; 95 across fits two.
    const r = run([plate("a", 10, 210, 40), plate("b", 9, 210, 100), plate("c", 8, 210, 160)], { minX: 200, maxX: 790, minY: 20, maxY: 180 }, 800, 200);
    expect(r.t).toBe(0);
    expect(Object.values(r.placements).some((p) => p.column === 1)).toBe(true);
  });
  it("graded shrink: small clusters end up smaller than big ones", () => {
    // Left band only 50 across: one column; four items must shrink to fit 180 along.
    const r = run([plate("big", 40, 70, 30), plate("mid", 20, 70, 80), plate("small", 5, 70, 130), plate("tiny", 1, 70, 170)], { minX: 70, maxX: 795, minY: 5, maxY: 195 }, 800, 200);
    expect(r.fallback).toBe(false);
    expect(r.phase).toBe("graded");
    expect(r.t).toBeGreaterThan(0);
    expect(r.sizes.tiny.iconPx).toBeLessThan(r.sizes.big.iconPx);
    expect(gradedFloor(1, 40, PTR)).toBeLessThan(gradedFloor(40, 40, PTR));
  });
  it("hides names smallest-first once graded shrink is not enough", () => {
    // Left band 80 across, 70 along (h = 90): three graded-floor plates with names do not fit; hiding tiny's does.
    const r = run([plate("big", 40, 100, 20), plate("mid", 20, 100, 50), plate("tiny", 1, 100, 80)], { minX: 100, maxX: 795, minY: 2, maxY: 88 }, 800, 90);
    expect(r).toMatchObject({ phase: "names", t: 1, fallback: false });
    expect(r.sizes.tiny.nameHidden).toBe(true);
    expect(r.sizes.mid.nameHidden).toBe(false);
    expect(r.sizes.big.nameHidden).toBe(false);
  });
  it("reports a ring fallback when nothing fits at the smallest size", () => {
    const r = run([plate("a", 10, 50, 50)], { minX: 5, maxX: 795, minY: 5, maxY: 195 }, 800, 200);
    expect(r).toMatchObject({ phase: "ring", fallback: true });
    expect(r.sizes.a.nameHidden).toBe(true);
    expect(r.sizes.a.iconPx).toBe(8);
  });
  it("name hysteresis: a hidden name stays hidden when showing it would leave no slack", () => {
    // One pointer, left band exactly tall enough for its full plate (60) but not 4% more.
    const core: Rect = { minX: 70, maxX: 795, minY: 5, maxY: 195 };
    // Floor plate is 45 tall (30 icon + 15 name): fits 46 along, not 46 * 1.04.
    const fresh = run([plate("a", 10, 60, 40)], core, 800, 66);
    const hidden = run([plate("a", 10, 60, 40)], core, 800, 66, ["a"]);
    expect(fresh.sizes.a.nameHidden).toBe(false);
    expect(hidden.sizes.a.nameHidden).toBe(true);
  });
  it("a hidden name returns when the floor layout has at least 4% slack", () => {
    const core: Rect = { minX: 70, maxX: 795, minY: 5, maxY: 195 };
    const r = run([plate("a", 10, 60, 40)], core, 800, 200, ["a"]);
    expect(r.sizes.a.nameHidden).toBe(false);
  });
  it("a hidden name returns during the graded phase when t = 1 has slack (not only at t = 0)", () => {
    const core: Rect = { minX: 100, maxX: 795, minY: 2, maxY: 158 };
    const ptrs = [plate("big", 40, 100, 20), plate("mid", 20, 100, 70), plate("tiny", 1, 100, 120)];
    const r = run(ptrs, core, 800, 160, ["tiny"]);
    expect(r.phase).toBe("graded");
    expect(r.t).toBeGreaterThan(0);
    expect(r.sizes.tiny.nameHidden).toBe(false);
  });
  it("icons phase: every name hidden, icons shrunk to the band thickness", () => {
    const r = run([plate("big", 40, 40, 30), plate("mid", 20, 40, 80), plate("small", 5, 40, 120), plate("tiny", 1, 40, 170)], { minX: 40, maxX: 795, minY: 5, maxY: 195 }, 800, 200);
    expect(r.phase).toBe("icons");
    Object.values(r.sizes).forEach((s) => { expect(s.nameHidden).toBe(true); expect(s.iconPx).toBeLessThanOrEqual(20); });
  });
  it("name-drop tie-break: equal pages, the later keyword loses its name first", () => {
    const r = run([plate("aa", 5, 50, 20), plate("zz", 5, 50, 70)], { minX: 50, maxX: 795, minY: 2, maxY: 100 }, 800, 105);
    expect(r.phase).toBe("names");
    expect(r.sizes.zz.nameHidden).toBe(true);
    expect(r.sizes.aa.nameHidden).toBe(false);
  });

  describe("stability across redraws", () => {
    // "small" carries a long name (wide footprint); "tiny" a short one.
    const wideFp: FootprintOf = (key, s) => {
      const nameW = key === "small" ? s.namePx * 6 : s.iconPx;
      const half = Math.max(s.iconPx / 2, s.nameHidden ? 0 : nameW / 2);
      return { left: -half, right: half, top: -s.iconPx / 2, bottom: s.iconPx / 2 + (s.nameHidden ? 0 : s.padPx + s.namePx) };
    };
    const go = (pointers: ScPlate[], core: Rect, w: number, h: number, prev: string[], fp: FootprintOf = fpOf) =>
      placePointers({
        pointers, c: 1, base: BASE, nameFloorPx: FLOOR_PX, footprintOf: fp, core, width: w, height: h,
        maxPages: Math.max(...pointers.map((p) => p.pages), 1), params: PTR, prevNameHidden: new Set(prev),
      });
    const hiddenOf = (r: ReturnType<typeof placePointers>) => Object.keys(r.sizes).filter((k) => r.sizes[k].nameHidden);
    const cases: Array<[string, ScPlate[], Rect, number, number, FootprintOf]> = [
      ["hides names smallest-first", [plate("big", 40, 100, 20), plate("mid", 20, 100, 50), plate("tiny", 1, 100, 80)], { minX: 100, maxX: 795, minY: 2, maxY: 88 }, 800, 90, fpOf],
      ["name-drop tie-break", [plate("aa", 5, 50, 20), plate("zz", 5, 50, 70)], { minX: 50, maxX: 795, minY: 2, maxY: 100 }, 800, 105, fpOf],
      ["wide names", [plate("big", 40, 60, 60), plate("small", 10, 60, 180), plate("tiny", 1, 60, 300)], { minX: 70, maxX: 795, minY: 5, maxY: 395 }, 800, 400, wideFp],
    ];
    cases.forEach(([name, ptrs, core, w, h, fp]) => {
      it("re-running with its own hidden names is a fixed point: " + name, () => {
        const r1 = go(ptrs, core, w, h, [], fp);
        const r2 = go(ptrs, core, w, h, hiddenOf(r1), fp);
        expect(r2.phase).toBe(r1.phase);
        expect(r2.t).toBe(r1.t);
        expect(r2.sizes).toEqual(r1.sizes);
      });
    });
    it("a previously hidden big name pulls every lower-priority name into the hidden set", () => {
      // Height 84: with only big hidden, mid and tiny still fit with names
      // shown, but big cannot return -- the old pass left that split in place.
      const [, ptrs, , w, , fp] = cases[0];
      const core: Rect = { minX: 100, maxX: 795, minY: 2, maxY: 82 };
      const r = go(ptrs, core, w, 84, ["big"], fp);
      expect(r.sizes.big.nameHidden).toBe(true);
      expect(r.sizes.mid.nameHidden).toBe(true);
      expect(r.sizes.tiny.nameHidden).toBe(true);
      const again = go(ptrs, core, w, 84, hiddenOf(r), fp);
      expect(again.sizes).toEqual(r.sizes);
    });
    it("a lower-priority name never shows while a higher-priority name is hidden", () => {
      const [, ptrs, core, w, h, fp] = cases[2];
      const r1 = go(ptrs, core, w, h, [], fp);
      expect(hiddenOf(r1).length).toBeGreaterThan(0);
      const r2 = go(ptrs, core, w, h, hiddenOf(r1), fp);
      const order = ptrs.slice().sort((a, b) => b.pages - a.pages).map((p) => p.key);
      const shown = order.map((k) => !r2.sizes[k].nameHidden);
      // hidden names form a suffix of the priority order
      expect(shown.join()).toBe(shown.slice().sort((a, b) => Number(b) - Number(a)).join());
    });
    it("candidate-only inflation: a tight neighbour does not block a name with slack", () => {
      // Left band holds "a" (45 tall at the floor, 60 along: slack). Right band holds "b",
      // whose footprint is exactly 60 tall at the floor: no 4% slack, but it fits plainly.
      const tallB: FootprintOf = (key, s) => ({
        left: -s.iconPx / 2, right: s.iconPx / 2, top: -s.iconPx / 2,
        bottom: s.iconPx / 2 + (key === "b" ? s.iconPx : s.nameHidden ? 0 : s.padPx + s.namePx),
      });
      const ptrs = [plate("a", 10, 60, 40), plate("b", 10, 740, 40)];
      const r = go(ptrs, { minX: 70, maxX: 730, minY: 5, maxY: 75 }, 800, 80, ["a"], tallB);
      expect(r.fallback).toBe(false);
      expect(r.sizes.a.nameHidden).toBe(false);
    });
  });
});
