import { describe, it, expect } from "vitest";
import palettes from "./palettes.json";
import goldens from "./theme-goldens.json";
import {
  adaptiveShift,
  clamp,
  deriveBaseTokens,
  deriveGalaxyStops,
  deriveSwatch,
  deriveTokens,
  hexToHls,
  hlsToHex,
  pyMod,
  shortestArc,
} from "./theme-derive";
import { generateCssText } from "./theme";

// theme-goldens.json is the oracle: exported from the Python source of truth
// (explorer scripts/dev/export_theme_goldens.py over
// frontend/dash/utils/theme.py) and verified byte-identical to a fresh export
// on 2026-09-14. The primitive expectations below are literal values printed
// by that same Python (3.12.3) so a divergence points at the exact operation.

type GoldenName = keyof typeof goldens.variants;

const TOKEN_ORDER = [
  "primary", "highlight", "bg", "text", "surface",
  "secondary", "accent", "accent_text", "tag_bg", "tag_text",
  "text_muted", "node_label", "link_muted", "border", "surface_alt",
  "highlight_bg", "container_bg", "panel_bg", "side_panel", "panel_caption",
  "paper", "ink", "on_primary", "chrome_neutral", "chrome_neutral_strong",
  "galaxy_0", "galaxy_1", "galaxy_2",
];

describe("pyMod (Python float % semantics)", () => {
  it("takes the sign of the divisor", () => {
    expect(pyMod(-0.3, 1.0)).toBe(0.7);
    expect(pyMod(1.7, 1.0)).toBe(0.7);
    expect(pyMod(0.25, 1.0)).toBe(0.25);
  });

  it("rounds a tiny negative remainder up to the divisor like Python does", () => {
    expect(pyMod(-1e-17, 1.0)).toBe(1.0);
  });

  it("returns +0 for an exact multiple", () => {
    expect(Object.is(pyMod(2.0, 1.0), 0)).toBe(true);
    expect(Object.is(pyMod(-2.0, 1.0), 0)).toBe(true);
  });
});

describe("clamp", () => {
  it("clamps to [0, 1] by default", () => {
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(1.5)).toBe(1);
    expect(clamp(0.42)).toBe(0.42);
  });
});

describe("shortestArc", () => {
  it("returns the signed shortest hue delta on the unit circle", () => {
    expect(shortestArc(0.9, 0.1)).toBe(0.19999999999999996);
    expect(shortestArc(0.1, 0.9)).toBe(-0.19999999999999996);
    expect(shortestArc(0.2, 0.5)).toBe(0.3);
  });
});

describe("hexToHls (colorsys.rgb_to_hls)", () => {
  it("matches Python for the Brown primary", () => {
    const [h, l, s] = hexToHls("#665541");
    expect(h).toBe(0.09009009009009006);
    expect(l).toBe(0.32745098039215687);
    expect(s).toBe(0.22155688622754496);
  });

  it("matches Python for the Brown highlight (l > 0.5 branch)", () => {
    const [h, l, s] = hexToHls("#BAA675");
    expect(h).toBe(0.11835748792270535);
    expect(l).toBe(0.5941176470588235);
    expect(s).toBe(0.3333333333333333);
  });

  it("returns h = 0 and s = 0 for a neutral grey", () => {
    expect(hexToHls("#808080")).toEqual([0.0, 0.5019607843137255, 0.0]);
  });

  it("matches Python for a near-neutral light text colour", () => {
    const [h, l, s] = hexToHls("#DAD6D7");
    expect(h).toBe(0.9583333333333334);
    expect(l).toBe(0.8470588235294118);
    expect(s).toBe(0.051282051282051114);
  });

  it("accepts lowercase hex and strips every leading #", () => {
    expect(hexToHls("##665541")).toEqual(hexToHls("#665541"));
    expect(hexToHls("665541")).toEqual(hexToHls("#665541"));
    expect(hexToHls("#baa675")).toEqual(hexToHls("#BAA675"));
  });
});

describe("hlsToHex (colorsys.hls_to_rgb + int() truncation + %02X)", () => {
  it("truncates rather than rounds", () => {
    expect(hlsToHex(0.0, 0.5, 0.0)).toBe("#7F7F7F");
  });

  it("matches Python for an in-range hue", () => {
    expect(hlsToHex(0.1, 0.1, 0.3)).toBe("#211B11");
  });

  it("wraps hues outside [0, 1) like Python's % 1.0", () => {
    expect(hlsToHex(-0.05, 0.5, 0.5)).toBe("#BF3F65");
    expect(hlsToHex(1.2, 0.5, 0.5)).toBe("#A5BF3F");
  });

  it("reproduces Python's truncating hex -> HLS -> hex for every palette anchor", () => {
    // int(x * 255) truncates, so the round trip is LOSSY for most anchors
    // (6 of 8 palettes drift by one step in one channel). These are the
    // outputs CPython 3.12.3 produces for palettes.json's anchors -- the
    // port must reproduce the drift, not "fix" it.
    const expected: Array<[input: string, output: string]> = [
      ["#734B54", "#734B54"], // Pink primary
      ["#EA8E7F", "#E98E7F"], // Pink highlight
      ["#734E39", "#734E39"], // Orange primary
      ["#DCA657", "#DCA657"], // Orange highlight
      ["#665541", "#665541"], // Brown primary
      ["#BAA675", "#BAA674"], // Brown highlight
      ["#415D47", "#415D47"], // Green primary
      ["#67C7A4", "#67C6A4"], // Green highlight
      ["#315E60", "#305D60"], // Teal primary
      ["#55C7BA", "#55C6B9"], // Teal highlight
      ["#385971", "#385871"], // Blue primary
      ["#58BED5", "#57BDD5"], // Blue highlight
      ["#5D4A66", "#5C4966"], // Purple primary
      ["#D68CBD", "#D68BBD"], // Purple highlight
      ["#434C5A", "#434C5A"], // Grey primary
      ["#A8A1DE", "#A8A1DE"], // Grey highlight
    ];
    for (const [input, output] of expected) {
      expect(hlsToHex(...hexToHls(input)), input).toBe(output);
    }
  });
});

describe("adaptiveShift", () => {
  it("lightens with saturation-adaptive coupling", () => {
    expect(adaptiveShift("#665541", 0.17, 1.0)).toBe("#A48159");
  });

  it("darkens when asked", () => {
    expect(adaptiveShift("#665541", 0.12, 1.0, true)).toBe("#3D352B");
  });

  it("reproduces the border derivation from the text token", () => {
    expect(adaptiveShift("#DAD6D7", 0.6, 1.0, true)).toBe("#3F3F3F");
  });
});

describe("deriveBaseTokens", () => {
  it("expands primary + highlight into the five base tokens in order", () => {
    const base = deriveBaseTokens("#665541", "#BAA675");
    expect(base).toEqual({
      primary: "#665541",
      highlight: "#BAA675",
      bg: "#1B1917",
      text: "#DAD8D6",
      surface: "#2A2827",
    });
    expect(Object.keys(base)).toEqual(["primary", "highlight", "bg", "text", "surface"]);
  });
});

describe("deriveGalaxyStops", () => {
  it("matches Python for the default n = 3, step = 0.15", () => {
    expect(deriveGalaxyStops("#665541", "#BAA675")).toEqual(["#9B6372", "#A38861", "#7DAA55"]);
  });

  it("handles n = 1 without dividing by zero", () => {
    expect(deriveGalaxyStops("#665541", "#BAA675", 1)).toEqual(["#8A7555"]);
  });

  it("matches Python for n = 5, step = 0.1", () => {
    expect(deriveGalaxyStops("#665541", "#BAA675", 5, 0.1)).toEqual([
      "#9B6383", "#B38281", "#A38861", "#ABB97B", "#63AA55",
    ]);
  });
});

describe("palettes.json is the source the goldens were exported from", () => {
  it("lists the same 8 names in the same order, and the same active palette", () => {
    expect(palettes.palettes.map((p) => p.name)).toEqual(Object.keys(goldens.variants));
    expect(palettes.active).toBe(goldens.active);
  });

  it("carries the same primary/highlight anchors as the goldens' swatches", () => {
    for (const p of palettes.palettes) {
      const swatch = goldens.swatches.find((s) => s.name === p.name);
      expect(swatch, p.name).toBeDefined();
      expect(swatch!.primary).toBe(p.primary);
      expect(swatch!.highlight).toBe(p.highlight);
    }
  });
});

describe("full derivation is byte-identical to the Python goldens", () => {
  for (const p of palettes.palettes) {
    const golden = goldens.variants[p.name as GoldenName];

    it(`${p.name}: 28 tokens, same keys in the same order, same values`, () => {
      const tokens = deriveTokens(p.primary, p.highlight);
      expect(Object.keys(tokens)).toEqual(TOKEN_ORDER);
      expect(Object.keys(tokens)).toEqual(Object.keys(golden.tokens));
      expect(tokens).toEqual(golden.tokens);
    });

    it(`${p.name}: galaxy stops`, () => {
      expect(deriveGalaxyStops(p.primary, p.highlight)).toEqual(golden.galaxy_stops);
    });

    it(`${p.name}: css text`, () => {
      expect(generateCssText(deriveTokens(p.primary, p.highlight))).toBe(golden.css_text);
    });

    it(`${p.name}: swatch`, () => {
      const swatch = goldens.swatches.find((s) => s.name === p.name);
      expect(deriveSwatch(p.name, p.primary, p.highlight)).toEqual(swatch);
    });
  }
});
