import { describe, it, expect } from "vitest";
import goldens from "./theme-goldens.json";
import {
  DEFAULT_VARIANT,
  generateCssText,
  getGalaxyStops,
  getPaletteNames,
  getSwatches,
  getTokens,
  normalizeVariant,
} from "./theme";

const VARIANT_NAMES = Object.keys(goldens.variants);

describe("getPaletteNames", () => {
  it("returns the 8 bare palette names in goldens order", () => {
    expect(getPaletteNames()).toEqual(VARIANT_NAMES);
    expect(getPaletteNames()).toHaveLength(8);
  });

  it("does not expose any legacy ' Dark' suffixed names", () => {
    expect(getPaletteNames().some((name) => name.endsWith(" Dark"))).toBe(false);
  });
});

describe("getTokens", () => {
  it("returns the golden token map for Brown byte-for-byte", () => {
    expect(getTokens("Brown")).toEqual(goldens.variants.Brown.tokens);
  });

  it("returns 28 token keys with a couple of known literal values", () => {
    const tokens = getTokens("Brown");
    expect(Object.keys(tokens)).toHaveLength(28);
    expect(tokens.primary).toBe("#665541");
    expect(tokens.chrome_neutral).toBe("rgba(255, 255, 255, 0.32)");
    expect(tokens.chrome_neutral_strong).toBe("rgba(255, 255, 255, 0.8)");
  });

  it("matches the golden entry for every variant", () => {
    for (const name of VARIANT_NAMES) {
      expect(getTokens(name)).toEqual(
        goldens.variants[name as keyof typeof goldens.variants].tokens
      );
    }
  });

  it("throws on an unknown variant", () => {
    expect(() => getTokens("Yellow")).toThrow();
  });

  it("does not leak mutations back into subsequent lookups", () => {
    const tokens = getTokens("Brown");
    tokens.primary = "#000000";
    expect(getTokens("Brown").primary).toBe("#665541");
  });
});

describe("getGalaxyStops", () => {
  it("returns the golden galaxy_stops array for Brown", () => {
    expect(getGalaxyStops("Brown")).toEqual(goldens.variants.Brown.galaxy_stops);
  });

  it("throws on an unknown variant", () => {
    expect(() => getGalaxyStops("Yellow")).toThrow();
  });
});

describe("generateCssText", () => {
  it("reproduces the golden css_text byte-for-byte for every variant", () => {
    for (const name of VARIANT_NAMES) {
      const entry = goldens.variants[name as keyof typeof goldens.variants];
      expect(generateCssText(entry.tokens)).toBe(entry.css_text);
    }
  });

  it("wraps lines in a :root block with hyphenated keys", () => {
    const css = generateCssText({ chrome_neutral: "rgba(0, 0, 0, 1)" });
    expect(css).toBe(":root {\n    --chrome-neutral: rgba(0, 0, 0, 1);\n}");
  });
});

describe("getSwatches", () => {
  it("returns the golden swatches array", () => {
    expect(getSwatches()).toEqual(goldens.swatches);
  });
});

describe("DEFAULT_VARIANT", () => {
  it("matches the goldens' active variant", () => {
    expect(DEFAULT_VARIANT).toBe(goldens.active);
    expect(DEFAULT_VARIANT).toBe("Brown");
  });
});

describe("normalizeVariant", () => {
  it("passes through a known bare name unchanged", () => {
    expect(normalizeVariant("Pink")).toBe("Pink");
  });

  it("strips a legacy ' Dark' suffix for a known palette", () => {
    expect(normalizeVariant("Pink Dark")).toBe("Pink");
  });

  it("falls back to DEFAULT_VARIANT for a retired name", () => {
    expect(normalizeVariant("Yellow")).toBe(DEFAULT_VARIANT);
  });

  it("falls back to DEFAULT_VARIANT for a retired name with a legacy suffix", () => {
    expect(normalizeVariant("Yellow Dark")).toBe(DEFAULT_VARIANT);
  });

  it("never throws on garbage input", () => {
    expect(() => normalizeVariant("")).not.toThrow();
    expect(normalizeVariant("")).toBe(DEFAULT_VARIANT);
  });
});
