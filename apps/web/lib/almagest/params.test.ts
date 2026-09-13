import { describe, it, expect } from "vitest";
import { shippedParams, validateParams, paramsEqual, toJSON, fromJSON, diffFromBaseline, PARAM_RANGES, TIER_NAMES } from "./params";
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
  it("clamps Mid.min so Display.min never exceeds its own range max", () => {
    const p = shippedParams();
    const v = validateParams({ ...p, tiers: { ...p.tiers, Mid: { ...p.tiers.Mid, min: 120 } } });
    expect(v.tiers.Mid.min).toBeLessThanOrEqual(PARAM_RANGES.tier.min.max - 1);
    expect(v.tiers.Display.min).toBeLessThanOrEqual(PARAM_RANGES.tier.min.max);
    expect(v.tiers.Display.min).toBeGreaterThan(v.tiers.Mid.min);
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
  it("diffFromBaseline reports nothing changed for an identical draft", () => {
    const p = shippedParams();
    const d = diffFromBaseline(p, shippedParams());
    for (const t of TIER_NAMES) expect(d.tiers[t]).toEqual([]);
    expect(d.frozen).toEqual([]);
    expect(d.total).toBe(0);
  });
  it("diffFromBaseline names a single changed tier param under its tier only", () => {
    const baseline = shippedParams();
    const p = { ...baseline, tiers: { ...baseline.tiers, Mid: { ...baseline.tiers.Mid, stroke: baseline.tiers.Mid.stroke + 1 } } };
    const d = diffFromBaseline(p, baseline);
    expect(d.tiers.Mid).toEqual(["stroke"]);
    expect(d.tiers.Display).toEqual([]);
    expect(d.tiers.Text).toEqual([]);
    expect(d.frozen).toEqual([]);
    expect(d.total).toBe(1);
  });
  it("diffFromBaseline names a single changed frozen param", () => {
    const baseline = shippedParams();
    const p = { ...baseline, frozen: { ...baseline.frozen, rot: baseline.frozen.rot + 1 } };
    const d = diffFromBaseline(p, baseline);
    expect(d.frozen).toEqual(["rot"]);
    for (const t of TIER_NAMES) expect(d.tiers[t]).toEqual([]);
    expect(d.total).toBe(1);
  });
});
