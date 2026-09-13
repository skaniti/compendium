import { describe, it, expect } from "vitest";
import { faceForPx, tierParamsFor, layoutLine, averageAdvanceEm, clearGlyphCache } from "./runtime";
import { shippedParams } from "./params";
import { getGenerator } from "./generator";

describe("almagest runtime", () => {
  it("faceForPx uses the tier breakpoints from the params", () => {
    // Derived from shippedParams() rather than hardcoded literals -- the
    // breakpoints move with every bake (2026-09-13: Display.min 52,
    // Mid.min 10), so this stays meaningful for any valid tier tables.
    const p = shippedParams();
    const d = p.tiers.Display.min, m = p.tiers.Mid.min;
    expect(faceForPx(d)).toBe("Display");
    if (d - 0.5 >= m) expect(faceForPx(d - 0.5)).toBe("Mid");
    expect(faceForPx(m)).toBe("Mid");
    if (m >= 1) expect(faceForPx(m - 0.5)).toBe("Text");
    // Explicit-params override: a Display breakpoint raised above the
    // tested pixel size routes to Mid instead of the shipped params' answer.
    const override = shippedParams();
    override.tiers.Display.min = 90;
    expect(faceForPx(60, override)).toBe("Mid");
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
  it("averageAdvanceEm is finite, in a sane range, and matches an independent recomputation of its own definition", () => {
    // The old 0.80..0.86 band pinned the hand-typed estimator assumption
    // that shipped BEFORE the vendor derived SC_NAME_CHAR_WIDTH from this
    // function -- there is no longer a fixed target band to pin (2026-09-13
    // bake: 0.6129em). Replaced with (a) a broad sanity range and (b) parity
    // against the same computation performed inline against the generator,
    // so a regression in the definition itself would still be caught.
    const em = averageAdvanceEm();
    expect(Number.isFinite(em)).toBe(true);
    expect(em).toBeGreaterThan(0.3);
    expect(em).toBeLessThan(1.5);
    const g = getGenerator();
    const t = g.tier("Mid");
    let sum = 0;
    for (let c = 65; c <= 90; c++) sum += g.outline(String.fromCharCode(c), t).advance;
    expect(em).toBe(sum / 26 / g.UPEM);
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
