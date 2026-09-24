// Tunable graph-canvas defaults, transcribed from the Dash renderer's
// `getTunerSnapshot()` (explorer `frontend/dash/assets/d3_graph.js:625-668`)
// at explorer HEAD `4bb0a648dc961a2961b153699be7ca1827484a1a` (2026-07-29,
// 5683 lines) -- every key that function returns, at its current
// code-default `var` value. Batch 03 (graph canvas port) Task S1; consumed
// by the S2/S3 sandboxes (code defaults only, no profile application --
// spec's F2 sandbox-bar note) and group B's real boot path, where a saved
// tuner profile applies on top of these via a ported `applyTunerSnapshot`
// (`d3_graph.js:670-741`) instead of Dash's deleted boot-latch fetch.
//
// Line anchors for every transcribed `var` declaration (source order, not
// getTunerSnapshot()'s object-literal order):
//   NODE_RADIUS                    d3_graph.js:11
//   SC_PILL_RADIUS                 d3_graph.js:16   (retired visual -- see note below)
//   HULL_PADDING                   d3_graph.js:17
//   FIT_WORLD_PAD                  d3_graph.js:31   (2026-07-17 laptop-profile re-tune)
//   NEBULA_FIT_CORE                d3_graph.js:43   (2026-07-17 laptop-profile re-tune)
//   NEBULA_RADIUS_MULT             d3_graph.js:53
//   NEBULA_MIN_RADIUS              d3_graph.js:54
//   SC_OVERLAY_OPACITY_FACTOR      d3_graph.js:67
//   SC_SATELLITE_COUNT             d3_graph.js:68
//   SCALE_THRESHOLDS                d3_graph.js:188-208
//   BASE_LABEL_FONT_SIZE           d3_graph.js:209
//   BASE_SC_LABEL_FONT_SIZE        d3_graph.js:210
//   BASE_SC_ICON_SIZE              d3_graph.js:211
//   BASE_SC_NAME_FONT_SIZE         d3_graph.js:212
//   BASE_SINGLETON_LABEL_FONT_SIZE d3_graph.js:213
//   BASE_GROUP_LABEL_FONT_SIZE     d3_graph.js:214
//   BASE_PAGE_DOT_SIZE             d3_graph.js:215  (2026-07-17 laptop-profile re-tune)
//   PAGE_SPREAD_MULT               d3_graph.js:219
//   STAR_GLYPH_OPACITY_MULT        d3_graph.js:226  (2026-07-17 laptop-profile re-tune)
//   SINGLETON_LOD_POWER            d3_graph.js:234
//   SINGLETON_LOD_FADE_RANGE       d3_graph.js:235
//   SINGLETON_LABEL_BASE_OPACITY   d3_graph.js:236
//   SC_PILL_SHAPE                  d3_graph.js:247  (retired visual -- see note below)
//   SC_PILL_AUTOFIT                d3_graph.js:248  (retired visual -- see note below)
//   SC_PILL_CORNER_ROUNDNESS       d3_graph.js:249  (retired visual -- see note below)
//   SC_PILL_FIXED_WIDTH            d3_graph.js:250  (retired visual -- see note below)
//   SC_PILL_FIXED_HEIGHT           d3_graph.js:251  (retired visual -- see note below)
//   SC_PILL_PADDING                d3_graph.js:252  (retired visual -- see note below)
//   SC_NAME_LOD_K_MIN              d3_graph.js:262
//   SC_NAME_LOD_FADE_RANGE         d3_graph.js:263
//   ICON_LOD_FADE_START            d3_graph.js:272
//   ICON_LOD_FADE_END              d3_graph.js:273
//   GROUP_CAPTION_LOD_K_MIN        d3_graph.js:284
//   GROUP_CAPTION_LOD_FADE         d3_graph.js:285
//   TUNER_TYPO_VERSION             d3_graph.js:301
//   TUNER_FOG_VERSION              d3_graph.js:313
//   LOD_BASE_THRESHOLD             d3_graph.js:527
//   LOD_POWER                      d3_graph.js:528
//   LOD_FADE_RANGE                 d3_graph.js:529
//   SC_LABEL_TOP_PAD               d3_graph.js:2080
//
// SC_PILL_* keys (:16, :247-252) are dead visuals per the source's own
// "retired (rethink R5)" comments -- the pill background no longer renders
// (see applySCMarker) -- but getTunerSnapshot() still returns them (old
// saved tuner profiles still reference them, and applyTunerSnapshot still
// restores them unconditionally), so they're transcribed here unchanged
// rather than silently dropped.

export interface ScaleThreshold {
  k_min: number;
  k_max: number;
}

export interface GraphDefaults {
  // Tuner-profile schema version stamps -- see TUNER_TYPO_VERSION /
  // TUNER_FOG_VERSION below for what gates on them.
  TYPO_V: number;
  FOG_V: number;
  // Pattern-3 clamped-scale thresholds (d3_graph.js's `clampedScale`) --
  // one {k_min,k_max} pair per label/glyph class.
  SCALE_THRESHOLDS: {
    clLabel: ScaleThreshold;
    scLabel: ScaleThreshold;
    scIcon: ScaleThreshold;
    scName: ScaleThreshold;
    singletonLabel: ScaleThreshold;
    groupLabel: ScaleThreshold;
    pageDot: ScaleThreshold;
  };
  BASE_LABEL_FONT_SIZE: number;
  BASE_SC_LABEL_FONT_SIZE: number;
  BASE_GROUP_LABEL_FONT_SIZE: number;
  BASE_SC_ICON_SIZE: number;
  BASE_SC_NAME_FONT_SIZE: number;
  // Nameplate LOD fit scale (the 2026-09-23 nameplate LOD fit-scale plan,
  // private): the vendor computes
  //   sFit = clamp(min(canvasW, canvasH_eff) / SC_PLATE_FIT_REF_PX,
  //                SC_NAME_FIT_FLOOR_PX / BASE_SC_NAME_FONT_SIZE, 1)
  // and multiplies BASE_SC_ICON_SIZE / BASE_SC_NAME_FONT_SIZE / the icon->
  // name pad by it, so those bases are the FULL-SIZE ceiling. Typo-gated.
  SC_PLATE_FIT_REF_PX: number;
  SC_NAME_FIT_FLOOR_PX: number;
  BASE_SINGLETON_LABEL_FONT_SIZE: number;
  LOD_BASE_THRESHOLD: number;
  LOD_POWER: number;
  LOD_FADE_RANGE: number;
  SINGLETON_LOD_POWER: number;
  SINGLETON_LOD_FADE_RANGE: number;
  SINGLETON_LABEL_BASE_OPACITY: number;
  SC_NAME_LOD_K_MIN: number;
  SC_NAME_LOD_FADE_RANGE: number;
  ICON_LOD_FADE_START: number;
  ICON_LOD_FADE_END: number;
  GROUP_CAPTION_LOD_K_MIN: number;
  GROUP_CAPTION_LOD_FADE: number;
  // Retired visuals (see the note above) -- still tuner-exposed.
  SC_PILL_SHAPE: string;
  SC_PILL_AUTOFIT: boolean;
  SC_PILL_CORNER_ROUNDNESS: number;
  SC_PILL_RADIUS: number;
  SC_PILL_FIXED_WIDTH: number;
  SC_PILL_FIXED_HEIGHT: number;
  SC_PILL_PADDING: number;
  HULL_PADDING: number;
  FIT_WORLD_PAD: number;
  NEBULA_FIT_CORE: number;
  NEBULA_RADIUS_MULT: number;
  NEBULA_MIN_RADIUS: number;
  SC_OVERLAY_OPACITY_FACTOR: number;
  SC_SATELLITE_COUNT: number;
  SC_LABEL_TOP_PAD: number;
  NODE_RADIUS: number;
  BASE_PAGE_DOT_SIZE: number;
  PAGE_SPREAD_MULT: number;
  STAR_GLYPH_OPACITY_MULT: number;
}

// Version stamps gate profile application in the ported
// `applyTunerSnapshot` (d3_graph.js:670-741, a later group-B task):
// typography keys apply only from snapshots stamped TYPO_V ===
// TUNER_TYPO_VERSION; NEBULA_RADIUS_MULT/NEBULA_MIN_RADIUS only from FOG_V
// === TUNER_FOG_VERSION. Exported standalone (not read only via
// GRAPH_DEFAULTS.TYPO_V/.FOG_V) because that gating logic compares a
// saved snapshot against the CURRENT bare constant, not against this
// module's own defaults object.
// v4 (2026-09-11): scName k_min 1.00 -> 0.75 (P3, sc-layout-separation); v3-stamped profiles pinning 1.00 would silently undo it.
// v5 (2026-09-23): plate-fit scale keys SC_PLATE_FIT_REF_PX / SC_NAME_FIT_FLOOR_PX added; BASE_SC_NAME_FONT_SIZE and scName now describe the full-size ceiling that sFit scales down, which v4 profiles tuned for screen-constant plates. BASE_SC_ICON_SIZE and the icon->name pad are ceilings too but stay ungated: a v4 profile's icon size still means "full-size icon", which is the intended reading.
export const TUNER_TYPO_VERSION = 5;
export const TUNER_FOG_VERSION = 2;

export const GRAPH_DEFAULTS: Readonly<GraphDefaults> = Object.freeze({
  TYPO_V: TUNER_TYPO_VERSION,
  FOG_V: TUNER_FOG_VERSION,
  SCALE_THRESHOLDS: {
    clLabel: { k_min: 1.25, k_max: 2.0 },
    scLabel: { k_min: 1.0, k_max: 2.0 },
    scIcon: { k_min: 0.5, k_max: 1.15 },
    scName: { k_min: 0.75, k_max: 2.0 },
    singletonLabel: { k_min: 1.0, k_max: 2.5 },
    groupLabel: { k_min: 1.0, k_max: 1.6 },
    pageDot: { k_min: 0.9, k_max: 2.1 },
  },
  BASE_LABEL_FONT_SIZE: 9,
  BASE_SC_LABEL_FONT_SIZE: 9,
  BASE_GROUP_LABEL_FONT_SIZE: 12,
  BASE_SC_ICON_SIZE: 100,
  BASE_SC_NAME_FONT_SIZE: 22,
  SC_PLATE_FIT_REF_PX: 640,
  SC_NAME_FIT_FLOOR_PX: 12,
  BASE_SINGLETON_LABEL_FONT_SIZE: 8,
  LOD_BASE_THRESHOLD: 2.5,
  LOD_POWER: 2.0,
  LOD_FADE_RANGE: 1.3,
  SINGLETON_LOD_POWER: 2.0,
  SINGLETON_LOD_FADE_RANGE: 0.1,
  SINGLETON_LABEL_BASE_OPACITY: 0.75,
  SC_NAME_LOD_K_MIN: 0.15,
  SC_NAME_LOD_FADE_RANGE: 0.1,
  ICON_LOD_FADE_START: 1.3,
  ICON_LOD_FADE_END: 1.8,
  GROUP_CAPTION_LOD_K_MIN: 0.8,
  GROUP_CAPTION_LOD_FADE: 0.15,
  SC_PILL_SHAPE: "circle",
  SC_PILL_AUTOFIT: true,
  SC_PILL_CORNER_ROUNDNESS: 0.26,
  SC_PILL_RADIUS: 64,
  SC_PILL_FIXED_WIDTH: 93,
  SC_PILL_FIXED_HEIGHT: 50,
  SC_PILL_PADDING: 19,
  HULL_PADDING: 20,
  FIT_WORLD_PAD: 155,
  NEBULA_FIT_CORE: 0.8,
  NEBULA_RADIUS_MULT: 9.0,
  NEBULA_MIN_RADIUS: 200,
  SC_OVERLAY_OPACITY_FACTOR: 0.18,
  SC_SATELLITE_COUNT: 3,
  SC_LABEL_TOP_PAD: 10,
  NODE_RADIUS: 3,
  BASE_PAGE_DOT_SIZE: 1.5,
  PAGE_SPREAD_MULT: 2.6,
  STAR_GLYPH_OPACITY_MULT: 0.35,
});
