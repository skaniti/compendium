import { describe, expect, it } from "vitest";
import { GRAPH_DEFAULTS, TUNER_FOG_VERSION, TUNER_TYPO_VERSION } from "./constants";

// Batch 03 (graph canvas port) Task S1. Values checked here are the ones
// named as verbatim checks in the task brief -- they pin the transcription
// against the explorer source (constants.ts's header cites the exact SHA +
// line anchors for every key, not just these four).

describe("GRAPH_DEFAULTS", () => {
  it("carries the four laptop-profile re-tune values verbatim", () => {
    expect(GRAPH_DEFAULTS.FIT_WORLD_PAD).toBe(155);
    expect(GRAPH_DEFAULTS.NEBULA_FIT_CORE).toBe(0.8);
    expect(GRAPH_DEFAULTS.BASE_PAGE_DOT_SIZE).toBe(1.5);
    expect(GRAPH_DEFAULTS.STAR_GLYPH_OPACITY_MULT).toBe(0.35);
  });

  it("has a non-empty key set", () => {
    expect(Object.keys(GRAPH_DEFAULTS).length).toBeGreaterThan(0);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(GRAPH_DEFAULTS)).toBe(true);
  });

  // Spot-check one key from each getTunerSnapshot() region (typography,
  // LOD falloff, SC pill, nebula, page dots) instead of re-enumerating all
  // 40 -- constants.ts's header comment is the full transcription record.
  it("carries a representative key from each tuner region", () => {
    expect(GRAPH_DEFAULTS.SCALE_THRESHOLDS.pageDot).toEqual({ k_min: 0.9, k_max: 2.1 });
    expect(GRAPH_DEFAULTS.NODE_RADIUS).toBe(3);
    expect(GRAPH_DEFAULTS.SC_PILL_SHAPE).toBe("circle");
    expect(GRAPH_DEFAULTS.NEBULA_RADIUS_MULT).toBe(9.0);
    expect(GRAPH_DEFAULTS.LOD_BASE_THRESHOLD).toBe(2.5);
    // P3 (sc-layout-separation spec, decision #1): names shrink with the
    // world below fit down to 0.75x instead of staying screen-constant.
    expect(GRAPH_DEFAULTS.SCALE_THRESHOLDS.scName).toEqual({ k_min: 0.75, k_max: 2.0 });
  });
});

describe("tuner version stamps", () => {
  it("TUNER_TYPO_VERSION is 4 (P3 scName k_min re-baseline, sc-layout-separation)", () => {
    expect(TUNER_TYPO_VERSION).toBe(4);
  });

  it("TUNER_FOG_VERSION is 2", () => {
    expect(TUNER_FOG_VERSION).toBe(2);
  });
});
