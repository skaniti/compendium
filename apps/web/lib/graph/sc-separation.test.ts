import { describe, it, expect } from "vitest";
import {
  clampRatio, estimateNameLines, plateFootprintAtRatio, plateRect, rectsOverlap,
  solveSeparation, computeExileRatio, spaceOnRing, rayExitFromRect, clipSegmentToRect,
  type FootprintParams, type SeparationPlate,
} from "./sc-separation";

const P: FootprintParams = {
  baseIconSize: 100, baseNameFontPx: 22, labelTopPad: 10, lineBudget: 12,
  charAdvanceEm: 25 / 30,
  scIcon: { k_min: 0.5, k_max: 1.15 }, scName: { k_min: 0.75, k_max: 2.0 }, pad: 2,
};

describe("clampRatio / estimateNameLines", () => {
  it("clamps into the band", () => {
    expect(clampRatio(0.3, P.scName)).toBe(0.75);
    expect(clampRatio(1.2, P.scName)).toBe(1.2);
    expect(clampRatio(5, P.scName)).toBe(2.0);
  });
  it("wraps greedily like the vendor's estimateLabelLines", () => {
    expect(estimateNameLines("volcanic phenomena", 12)).toEqual(["volcanic", "phenomena"]);
    expect(estimateNameLines("zoology", 12)).toEqual(["zoology"]);
  });
});

describe("plateFootprintAtRatio", () => {
  it("at the 0.5 floor: icon 50px, name at 0.75x, widths from the longest line", () => {
    const fp = plateFootprintAtRatio("zoology", 0.5, P);
    const fontPx = 22 * 0.75;
    const nameW = 7 * fontPx * (25 / 30);
    expect(fp.top).toBeCloseTo(-25 - 2, 6);
    expect(fp.left).toBeCloseTo(-Math.max(25, nameW / 2) - 2, 6);
    expect(fp.right).toBeCloseTo(Math.max(25, nameW / 2) + 2, 6);
    expect(fp.bottom).toBeCloseTo(25 + 10 * 0.5 + 1 * fontPx * 1.15 + 2, 6);
  });
  it("is monotone: footprint at 1.0 is at least as large as at 0.5 on every side", () => {
    const a = plateFootprintAtRatio("entertainment industry", 0.5, P);
    const b = plateFootprintAtRatio("entertainment industry", 1.0, P);
    expect(b.right - b.left).toBeGreaterThanOrEqual(a.right - a.left);
    expect(b.bottom - b.top).toBeGreaterThanOrEqual(a.bottom - a.top);
  });
});

function plate(key: string, pages: number, x: number, y: number, budget: number): SeparationPlate {
  return { key, pages, x, y, fp: { left: -50, right: 50, top: -30, bottom: 30 }, budget };
}

describe("solveSeparation", () => {
  it("separates two overlapping plates along the min-penetration axis, splitting the move", () => {
    const res = solveSeparation([plate("big", 10, 0, 0, 1000), plate("small", 2, 60, 0, 1000)]);
    // x-penetration = 100 - 60 = 40 (+ epsilon); y-penetration = 60 -> x axis wins.
    expect(res.overflow).toEqual([]);
    const a = plateRect(0 + res.shifts.big.dx, 0 + res.shifts.big.dy, { left: -50, right: 50, top: -30, bottom: 30 });
    const b = plateRect(60 + res.shifts.small.dx, 0 + res.shifts.small.dy, { left: -50, right: 50, top: -30, bottom: 30 });
    expect(rectsOverlap(a, b)).toBe(false);
    expect(res.shifts.big.dx).toBeLessThan(0);
    expect(res.shifts.small.dx).toBeGreaterThan(0);
    expect(Math.abs(res.shifts.big.dy)).toBe(0);
  });
  it("respects budgets: a zero-budget plate never moves, the partner absorbs the whole move", () => {
    const res = solveSeparation([plate("big", 10, 0, 0, 0), plate("small", 2, 60, 0, 1000)]);
    expect(res.shifts.big).toEqual({ dx: 0, dy: 0 });
    expect(res.shifts.small.dx).toBeGreaterThanOrEqual(40);
    expect(res.overflow).toEqual([]);
  });
  it("marks the smaller-pages plate as overflow when the pair cannot be resolved within budget", () => {
    const res = solveSeparation([plate("big", 10, 0, 0, 5), plate("small", 2, 60, 0, 5)]);
    expect(res.overflow).toEqual(["small"]);
    expect(res.shifts.big).toEqual({ dx: 0, dy: 0 });
    expect(res.shifts.small).toEqual({ dx: 0, dy: 0 });
  });
  it("is deterministic and order-independent in its input", () => {
    const a = [plate("a", 5, 0, 0, 100), plate("b", 5, 30, 10, 100), plate("c", 1, 70, 5, 100)];
    const r1 = solveSeparation(a);
    const r2 = solveSeparation([a[2], a[0], a[1]]);
    expect(r1).toEqual(r2);
  });
  it("leaves already-disjoint plates untouched", () => {
    const res = solveSeparation([plate("a", 5, 0, 0, 100), plate("b", 5, 500, 500, 100)]);
    expect(res.shifts.a).toEqual({ dx: 0, dy: 0 });
    expect(res.shifts.b).toEqual({ dx: 0, dy: 0 });
    expect(res.passes).toBe(1);
  });
});

describe("computeExileRatio", () => {
  const anchors = { keep: { x: 0, y: 0 }, exile: { x: 100, y: 0 } };
  it("returns the smallest ratio at which the plate clears every anchored plate", () => {
    // kFit 1: at ratio r the screen gap is 100 r. For these short words
    // ("keep" 4 chars, "exile" 5 chars) the ICON term dominates, not the
    // name term: iconPx/2 = 50 r grows faster than either name's half-width
    // (name half-width stays below 50 r for every r up to where the icon
    // band caps at k_max=1.15, where iconPx/2 freezes at 100/2*1.15=57.5).
    // So for r <= 1.15 each half-width is 50 r + 2, giving a combined
    // half-width of 100 r + 4 -- always 4px MORE than the 100 r gap, so the
    // pair never clears in that range. Once the icon term caps, the
    // combined half-width freezes at 2*(57.5+2)=119 while the gap keeps
    // growing at 100 r, so the pair clears once 100 r > 119, i.e. r > 1.19:
    // strictly inside (1.0, 1.5), not (0.5, 1.0) -- name-clamping isn't
    // what governs this pair, icon-capping is.
    const r = computeExileRatio("exile", anchors, ["keep"], P, 1, 0.5, 4, 0.01);
    expect(r).toBeGreaterThan(1.0);
    expect(r).toBeLessThan(1.5);
    // one step below r, the plates still overlap
    const below = r - 0.01;
    const a = plateRect(0, 0, plateFootprintAtRatio("keep", below, P));
    const b = plateRect(100 * below, 0, plateFootprintAtRatio("exile", below, P));
    expect(rectsOverlap(a, b)).toBe(true);
  });
  it("returns rMin when already clear at the floor", () => {
    expect(computeExileRatio("exile", { keep: { x: 0, y: 0 }, exile: { x: 5000, y: 0 } }, ["keep"], P, 1, 0.5, 4)).toBe(0.5);
  });
  it("returns Infinity when never clear inside [rMin, rMax]", () => {
    expect(computeExileRatio("exile", { keep: { x: 0, y: 0 }, exile: { x: 1, y: 0 } }, ["keep"], P, 1, 0.5, 4)).toBe(Infinity);
  });
});

describe("spaceOnRing", () => {
  it("preserves order and removes angular overlap", () => {
    const out = spaceOnRing([
      { key: "a", angle: 0.00, halfAngle: 0.2 },
      { key: "b", angle: 0.05, halfAngle: 0.2 },
      { key: "c", angle: 2.00, halfAngle: 0.2 },
    ]);
    expect(out.a).toBeLessThan(out.b);
    expect(out.b - out.a).toBeGreaterThanOrEqual(0.4 - 1e-6);
    expect(out.c).toBeCloseTo(2.0, 6);
  });
  it("handles the wrap-around neighbor", () => {
    const out = spaceOnRing([
      { key: "a", angle: -Math.PI + 0.05, halfAngle: 0.2 },
      { key: "b", angle: Math.PI - 0.05, halfAngle: 0.2 },
    ]);
    let d = out.a - out.b; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
    expect(Math.abs(d)).toBeGreaterThanOrEqual(0.4 - 1e-6);
  });
});

describe("rayExitFromRect / clipSegmentToRect", () => {
  const r = { minX: -100, minY: -50, maxX: 100, maxY: 50 };
  it("exits through the side the ray points at", () => {
    expect(rayExitFromRect(0, 0, 1, 0, r)).toEqual({ x: 100, y: 0 });
    expect(rayExitFromRect(0, 0, 0, -1, r)).toEqual({ x: 0, y: -50 });
    const e = rayExitFromRect(0, 0, Math.SQRT1_2, Math.SQRT1_2, r);
    expect(e.y).toBeCloseTo(50, 6); expect(e.x).toBeCloseTo(50, 6);
  });
  it("clips the segment at the rect boundary nearest the outside point", () => {
    const p = clipSegmentToRect(-300, 0, 0, 0, r);
    expect(p).toEqual({ x: -100, y: 0 });
  });
});
