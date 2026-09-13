import { describe, it, expect } from "vitest";
import { faceForPx, tierParamsFor, layoutLine, averageAdvanceEm, clearGlyphCache } from "./runtime";
import { shippedParams } from "./params";
import { getGenerator } from "./generator";

describe("almagest runtime", () => {
  it("faceForPx uses the tier breakpoints from the params", () => {
    expect(faceForPx(60)).toBe("Display");
    expect(faceForPx(52)).toBe("Display");
    expect(faceForPx(51.99)).toBe("Mid");
    expect(faceForPx(22)).toBe("Mid");
    expect(faceForPx(21)).toBe("Text");
    const p = shippedParams();
    p.tiers.Display.min = 90;
    expect(faceForPx(60, p)).toBe("Mid");
  });
  it("tierParamsFor equals the generator's own tier() merge for shipped params", () => {
    const g = getGenerator();
    expect(tierParamsFor("Mid")).toEqual(g.tier("Mid"));
  });
  it("layoutLine advances match outline().advance plus kerning, with kerning applied between A and V", () => {
    const g = getGenerator();
    const t = g.tier("Display");
    const a = g.outline("A", t).advance, v = g.outline("V", t).advance;
    const kern = g.kernPairs(t).find((k) => k[0] === "A" && k[1] === "V");
    const out = layoutLine("AV", "Display");
    expect(out.glyphs.map((x) => x.ch)).toEqual(["A", "V"]);
    expect(out.glyphs[0].x).toBe(0);
    expect(out.glyphs[1].x).toBe(a + (kern ? kern[2] : 0));
    expect(out.advance).toBe(a + (kern ? kern[2] : 0) + v);
    expect(out.glyphs[0].d.startsWith("M")).toBe(true);
  });
  it("space uses spaceAdvance and unmapped characters fall back to .notdef", () => {
    const g = getGenerator();
    const t = g.tier("Text");
    const out = layoutLine("A B", "Text");
    expect(out.glyphs.length).toBe(2);
    expect(out.glyphs[1].x).toBe(g.outline("A", t).advance + g.spaceAdvance(t));
    const nd = layoutLine("☃", "Text"); // snowman: not in the character set
    expect(nd.glyphs[0].ch).toBe(".notdef");
  });
  it("lowercase input maps to the same caps glyphs", () => {
    expect(layoutLine("abc", "Mid").advance).toBe(layoutLine("ABC", "Mid").advance);
  });
  it("averageAdvanceEm for shipped params is in the 0.80..0.86 band the footprint estimator assumes", () => {
    const em = averageAdvanceEm();
    expect(em).toBeGreaterThan(0.8);
    expect(em).toBeLessThan(0.86);
  });
  it("cache is keyed on params: changing stroke changes path data", () => {
    clearGlyphCache();
    const p = shippedParams();
    const d1 = layoutLine("A", "Display", p).glyphs[0].d;
    p.tiers.Display.stroke = p.tiers.Display.stroke + 10;
    const d2 = layoutLine("A", "Display", p).glyphs[0].d;
    expect(d2).not.toBe(d1);
  });
});
