import { describe, it, expect } from "vitest";
import { shippedParams, validateParams, paramsEqual, toJSON, fromJSON, PARAM_RANGES, TIER_NAMES } from "./params";
import { getGenerator } from "./generator";

describe("almagest params", () => {
  it("shippedParams mirrors the generator's tables exactly", () => {
    const g = getGenerator();
    const p = shippedParams();
    expect(p.frozen).toEqual(g.FROZEN);
    for (const t of TIER_NAMES) expect(p.tiers[t]).toEqual(g.TIERS[t]);
  });
  it("validateParams clamps to ranges and coerces points to an integer", () => {
    const p = shippedParams();
    const v = validateParams({ ...p, frozen: { ...p.frozen, points: 5.7, tracking: 9999 }, tiers: { ...p.tiers, Display: { ...p.tiers.Display, star: -5 } } });
    expect(v.frozen.points).toBe(6);
    expect(v.frozen.tracking).toBe(PARAM_RANGES.frozen.tracking.max);
    expect(v.tiers.Display.star).toBe(0);
  });
  it("validateParams enforces Display.min > Mid.min > Text.min = 0", () => {
    const p = shippedParams();
    const v = validateParams({ ...p, tiers: { ...p.tiers, Mid: { ...p.tiers.Mid, min: 80 }, Text: { ...p.tiers.Text, min: 5 } } });
    expect(v.tiers.Text.min).toBe(0);
    expect(v.tiers.Mid.min).toBeLessThan(v.tiers.Display.min);
  });
  it("validateParams throws on a wrong shape", () => {
    expect(() => validateParams({ frozen: {} })).toThrow();
    expect(() => validateParams(null)).toThrow();
  });
  it("JSON round-trips and paramsEqual is exact", () => {
    const p = shippedParams();
    expect(paramsEqual(fromJSON(toJSON(p)), p)).toBe(true);
    expect(paramsEqual({ ...p, frozen: { ...p.frozen, rot: p.frozen.rot + 1 } }, p)).toBe(false);
  });
});
