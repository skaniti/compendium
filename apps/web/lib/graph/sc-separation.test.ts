import { describe, it, expect } from "vitest";
import {
  clampRatio, estimateNameLines, plateFootprintAtRatio, plateFootprintPx, plateRect, rectsOverlap,
  solveSeparation, computeExileRatio, spaceOnRing, rayExitFromRect, clipSegmentToRect,
  uncrossSegments, placeExiledPlates, segmentsCross,
  type FootprintParams, type SeparationPlate, type ExileItem, type ExileEnv,
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
    expect(fp.bottom).toBeCloseTo(25 + 10 * 0.5 + 1 * fontPx * 1.25 + 2, 6);
  });
  it("equals plateFootprintPx at the band-clamped sizes", () => {
    expect(plateFootprintAtRatio("entertainment industry", 0.5, P)).toEqual(
      plateFootprintPx("entertainment industry", 100 * 0.5, 22 * 0.75, 10 * 0.5, false, P));
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

describe("plateFootprintPx", () => {
  it("an icon-only plate (name hidden) is the icon box plus the pad", () => {
    expect(plateFootprintPx("zoology", 30, 12, 6, true, P)).toEqual({ left: -17, right: 17, top: -17, bottom: 17 });
  });
  it("a shown name widens and lengthens the plate by the pad and its lines", () => {
    const fp = plateFootprintPx("volcanic phenomena", 30, 12, 6, false, P);
    const nameW = 9 * 12 * (25 / 30);
    expect(fp.right).toBeCloseTo(Math.max(15, nameW / 2) + 2, 6);
    expect(fp.bottom).toBeCloseTo(15 + 6 + 2 * 12 * 1.25 + 2, 6);
  });
});

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

describe("spaceOnRing overfull ring", () => {
  it("scales demand down so order is still preserved when the ring cannot fit everyone", () => {
    const out = spaceOnRing([
      { key: "a", angle: 0.0, halfAngle: 1.0 },
      { key: "b", angle: 0.5, halfAngle: 1.0 },
      { key: "c", angle: 1.0, halfAngle: 1.0 },
      { key: "d", angle: 1.5, halfAngle: 1.0 },
    ]);
    // total demand 8 rad > 2*pi: scaled to fit; order a<b<c<d preserved around the circle
    const seq = ["a", "b", "c", "d"].map((k) => out[k]);
    for (let i = 0; i < 3; i++) {
      let d = seq[i + 1] - seq[i]; while (d <= 0) d += 2 * Math.PI;
      expect(d).toBeGreaterThanOrEqual(2 * Math.PI * 0.98 / 4 - 1e-6); // scaled per-pair need for four equal items
      expect(d).toBeLessThan(Math.PI);
    }
  });
});

describe("uncrossSegments", () => {
  it("swaps the outer endpoints of two crossing leaders", () => {
    // anchors at (-10,0) and (10,0); plates deliberately swapped: left anchor -> right plate
    const out = uncrossSegments([
      { key: "L", ax: -10, ay: 0, px: 100, py: 50 },
      { key: "R", ax: 10, ay: 0, px: -100, py: 50 },
    ]);
    expect(out.L).toEqual({ px: -100, py: 50 });
    expect(out.R).toEqual({ px: 100, py: 50 });
  });
  it("leaves non-crossing leaders alone and is deterministic", () => {
    const items = [
      { key: "a", ax: 0, ay: 0, px: -100, py: -100 },
      { key: "b", ax: 5, ay: 0, px: 100, py: -100 },
      { key: "c", ax: 0, ay: 5, px: 0, py: 120 },
    ];
    const out = uncrossSegments(items);
    expect(out).toEqual({ a: { px: -100, py: -100 }, b: { px: 100, py: -100 }, c: { px: 0, py: 120 } });
    expect(uncrossSegments(items.slice().reverse())).toEqual(out);
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

function worldRect(p: { x: number; y: number }, fp: { left: number; right: number; top: number; bottom: number }, k: number) {
  const hw = (fp.right - fp.left) / 2 / k, hh = (fp.bottom - fp.top) / 2 / k;
  return { minX: p.x - hw, maxX: p.x + hw, minY: p.y - hh, maxY: p.y + hh };
}
function leaderEnd(it: ExileItem, p: { x: number; y: number }, k: number) {
  const r = worldRect(p, it.fp, k);
  if (it.ax >= r.minX && it.ax <= r.maxX && it.ay >= r.minY && it.ay <= r.maxY) return { x: it.ax, y: it.ay };
  return clipSegmentToRect(it.ax, it.ay, p.x, p.y, r);
}
function crossings(items: ExileItem[], out: Record<string, { x: number; y: number }>, k: number): number {
  let n = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const ei = leaderEnd(items[i], out[items[i].key], k), ej = leaderEnd(items[j], out[items[j].key], k);
    if (segmentsCross(items[i].ax, items[i].ay, ei.x, ei.y, items[j].ax, items[j].ay, ej.x, ej.y)) n++;
  }
  return n;
}
function overlaps(items: ExileItem[], out: Record<string, { x: number; y: number }>, k: number): number {
  let n = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (rectsOverlap(worldRect(out[items[i].key], items[i].fp, k), worldRect(out[items[j].key], items[j].fp, k))) n++;
  }
  return n;
}
const FP_WIDE = { left: -90, right: 90, top: -27, bottom: 60 };
const FP_NARROW = { left: -40, right: 40, top: -27, bottom: 45 };

describe("placeExiledPlates", () => {
  const env: ExileEnv = { cx: 0, cy: 0, bbox: { minX: -400, maxX: 400, minY: -250, maxY: 250 }, k: 0.5, marginPx: 16 };
  it("places every plate outside the bbox along its radial, with no overlaps and no leader crossings", () => {
    const items: ExileItem[] = [
      { key: "a", ax: 300, ay: 20, fp: FP_WIDE },
      { key: "b", ax: 150, ay: 40, fp: FP_NARROW },   // nearer the centroid, slightly higher angle
      { key: "c", ax: 250, ay: -30, fp: FP_WIDE },
      { key: "d", ax: -200, ay: 100, fp: FP_NARROW },
    ];
    const out = placeExiledPlates(items, env);
    for (const it of items) {
      const p = out[it.key];
      const r = worldRect(p, it.fp, env.k);
      expect(rectsOverlap(r, env.bbox)).toBe(false);
      expect(Math.abs(Math.atan2(p.y - env.cy, p.x - env.cx) - p.angle)).toBeLessThan(1e-9);
    }
    expect(overlaps(items, out, env.k)).toBe(0);
    expect(crossings(items, out, env.k)).toBe(0);
  });
  it("uncrosses by swapping slots: near-collinear anchors whose initial ring slots would cross end up uncrossed", () => {
    // A bare pair can't exercise this: with only two items, order-preserving radial placement
    // from a common centroid provably never produces a crossing (exhaustively verified while
    // building this fixture -- 500k+ random 2-item configurations, 0 crossings; see
    // task-8-report.md). A third, WIDE "mid" item crowding the same narrow angular band (all
    // three anchors sit within ~2 degrees of each other, at increasing radius) forces it: mid's
    // large half-angle demand pushes "far" and "near" far enough apart that their CLIPPED-EDGE
    // leaders (not their centers, which never cross) cross before the swap corrects it. Traced
    // pre-swap: far/near's leaders cross (far/mid and mid/near do not); the swap trades far's and
    // near's ring slots, which INVERTS their angular order relative to their raw bearings
    // (far 19.44 deg < near 19.98 deg bearing, but final near angle -4.49 deg < far angle 17.65
    // deg) -- exactly the brief's point: uncrossing rendered leaders sometimes requires breaking
    // simple angular order, which this test pins.
    const items: ExileItem[] = [
      { key: "far", ax: 340, ay: 120, fp: FP_NARROW },
      { key: "mid", ax: 270, ay: 105, fp: FP_WIDE },
      { key: "near", ax: 110, ay: 40, fp: FP_NARROW },
    ];
    const out = placeExiledPlates(items, env);
    expect(crossings(items, out, env.k)).toBe(0);
    expect(overlaps(items, out, env.k)).toBe(0);
  });
  it("clamps radially inside the viewport, preserving each plate's angle", () => {
    const vp = { a: 0.5, d: 0.5, e: 300, f: 200, left: 0, top: 0, width: 600, height: 400, marginPx: 28 };
    const items: ExileItem[] = [{ key: "a", ax: 300, ay: 0, fp: FP_WIDE }, { key: "b", ax: 0, ay: 200, fp: FP_NARROW }];
    const out = placeExiledPlates(items, { ...env, viewport: vp });
    for (const it of items) {
      const p = out[it.key];
      const sx = vp.a * p.x + vp.e - vp.left, sy = vp.d * p.y + vp.f - vp.top;
      const hw = (it.fp.right - it.fp.left) / 2, hh = (it.fp.bottom - it.fp.top) / 2;
      expect(sx - hw).toBeGreaterThanOrEqual(vp.marginPx - 1e-6);
      expect(sx + hw).toBeLessThanOrEqual(vp.width - vp.marginPx + 1e-6);
      expect(sy - hh).toBeGreaterThanOrEqual(vp.marginPx - 1e-6);
      expect(sy + hh).toBeLessThanOrEqual(vp.height - vp.marginPx + 1e-6);
      expect(Math.abs(Math.atan2(p.y - env.cy, p.x - env.cx) - Math.atan2(it.ay - env.cy, it.ax - env.cx))).toBeLessThan(0.35); // angle kept within the spacing budget
    }
  });
  it("is deterministic and input-order independent", () => {
    const items: ExileItem[] = [
      { key: "a", ax: 300, ay: 20, fp: FP_WIDE }, { key: "b", ax: 150, ay: 40, fp: FP_NARROW },
      { key: "c", ax: 250, ay: -30, fp: FP_WIDE }, { key: "d", ax: -200, ay: 100, fp: FP_NARROW },
    ];
    expect(placeExiledPlates(items.slice().reverse(), env)).toEqual(placeExiledPlates(items, env));
  });
  it("keeps an overfull ring in angular order with no crossings (overlap allowed)", () => {
    const items: ExileItem[] = [];
    for (let i = 0; i < 10; i++) {
      const th = (i / 10) * 2 * Math.PI;
      items.push({ key: "p" + i, ax: 200 * Math.cos(th), ay: 200 * Math.sin(th), fp: FP_WIDE });
    }
    const small: ExileEnv = { cx: 0, cy: 0, bbox: { minX: -120, maxX: 120, minY: -80, maxY: 80 }, k: 0.25, marginPx: 16 };
    const out = placeExiledPlates(items, small);
    expect(crossings(items, out, small.k)).toBe(0);
  });
});
