import { describe, it, expect } from "vitest";
import {
  sizesAt, inflate, clearAt, crowdScale, selectPointers,
  type BaseSizes, type FootprintOf, type ScPlate,
} from "./sc-pointers";

// Test geometry: a square icon, the name stacked under it (pad + one line).
// Full size: 40 wide, 60 tall, footprint relative to the icon center.
const BASE: BaseSizes = { iconPx: 40, namePx: 20, padPx: 0 };
const FLOOR_PX = 12;
const fpOf: FootprintOf = (_key, s) => ({
  left: -s.iconPx / 2, right: s.iconPx / 2, top: -s.iconPx / 2,
  bottom: s.iconPx / 2 + (s.nameHidden ? 0 : s.padPx + s.namePx),
});
const plate = (key: string, pages: number, x: number, y: number): ScPlate => ({ key, pages, x, y });

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

describe("selectPointers", () => {
  const sel = (plates: ScPlate[], prev: string[] = []) =>
    selectPointers({ plates, base: BASE, nameFloorPx: FLOOR_PX, footprintOf: fpOf, crowdFloor: 0.5, hysteresis: 0.04, prevPointers: new Set(prev) });

  it("shrinks before pointing: clear at the floor means no pointers and c < 1", () => {
    const r = sel([plate("a", 30, 0, 0), plate("b", 20, 30, 0), plate("c", 10, 60, 0)]);
    expect(r.pointers).toEqual([]);
    expect(r.c).toBeLessThanOrEqual(0.75);
    expect(r.c).toBeGreaterThan(0.74);
  });
  it("turns the lowest-priority colliding plate into a pointer, one at a time", () => {
    // At the floor (20 wide): a-b and b-c overlap, a-c clear. c goes first, then b.
    const r = sel([plate("a", 30, 0, 0), plate("b", 20, 15, 0), plate("c", 10, 30, 0)]);
    expect(r.pointers).toEqual(["b", "c"]);
    expect(r.inPlace).toEqual(["a"]);
    expect(r.c).toBe(1);
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
});
