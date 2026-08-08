// Batch 03 (graph canvas port) Task group B, Part 2 (spec decision C).
//
// Pure TypeScript port of two vendor functions (lib/graph/d3-graph-vendor.js)
// that are otherwise DEAD CODE in this app -- both were written for Dash's
// server-fetched `/_user_state` boot latch (deleted at Task S2, header
// comment delta #2), and are never called with real data on this side of
// the port:
//   - resolveEffectiveSlot (vendor ~:1087-1100): per-machine localStorage
//     override vs. the server's per-user default active slot.
//   - applyTunerSnapshot (vendor ~:997-1068): the TYPO_V/FOG_V version-gated
//     application of a saved profile's keys onto the live render state.
//
// This module re-expresses both as a SINGLE pure function, run BEFORE first
// paint instead of mutating already-rendered module state after the fact --
// decision C's "Next-native, no boot latch, no timeout" boot path. See
// components/GraphCanvas.tsx's wiring comment for how the result reaches the
// vendor's `opts.tunerSnapshot`, and task-B-report.md for the full design
// writeup (gated-key table with vendor line cites, wiring timing).
//
// Version-stamp unification (S-group triage): TUNER_TYPO_VERSION /
// TUNER_FOG_VERSION previously lived as duplicated literals in both
// constants.ts and the vendor file. constants.ts is now the single source
// (imported here AND by the vendor -- see that file's header comment delta
// #16); this module never re-derives them.

import {
  GRAPH_DEFAULTS,
  TUNER_FOG_VERSION,
  TUNER_TYPO_VERSION,
  type GraphDefaults,
  type ScaleThreshold,
} from "./constants";

// Mirrors the vendor's own MACHINE_SLOT_KEY_PREFIX (~:1079) byte-for-byte --
// this is a READ of a key a saved-profile-writing surface (batch 05's tuner
// panel) will also WRITE, so the two must never drift apart.
const MACHINE_SLOT_KEY_PREFIX = "compendium_tuner_slot_";

// Minimal storage shape -- just getItem, so callers can pass
// window.localStorage directly (structurally compatible, no adapter
// needed) or a plain mock in tests without a real localStorage/jsdom
// dependency.
export interface TunerSlotStorage {
  getItem(key: string): string | null;
}

type ScaleThresholdKey = keyof GraphDefaults["SCALE_THRESHOLDS"];

// The six typo-gated SCALE_THRESHOLDS entries (vendor's TYPO_SCALE_KEYS,
// ~:1015) -- `pageDot` is the one entry that stays ungated (applies from
// any profile version, spatial not typographic).
const TYPO_GATED_THRESHOLD_KEYS: ReadonlySet<ScaleThresholdKey> = new Set([
  "clLabel",
  "scLabel",
  "scName",
  "singletonLabel",
  "groupLabel",
  "scIcon",
]);

// Flat (non-SCALE_THRESHOLDS) keys gated on TYPO_V -- dropped unless
// snap.TYPO_V === TUNER_TYPO_VERSION (vendor ~:1025-1033's `if (typoOK) {...}`
// block).
const TYPO_GATED_FLAT_KEYS: ReadonlyArray<keyof GraphDefaults> = [
  "BASE_LABEL_FONT_SIZE",
  "BASE_SC_LABEL_FONT_SIZE",
  "BASE_GROUP_LABEL_FONT_SIZE",
  "BASE_SC_NAME_FONT_SIZE",
  "BASE_SINGLETON_LABEL_FONT_SIZE",
  "SC_NAME_LOD_K_MIN",
  "SC_NAME_LOD_FADE_RANGE",
];

// Keys gated on FOG_V -- dropped unless snap.FOG_V === TUNER_FOG_VERSION
// (vendor ~:1055-1058's `if (fogOK) {...}` block). HULL_PADDING is NOT part
// of this set (see the vendor's own TUNER_FOG_VERSION comment) -- it lives
// in the ungated list below.
const FOG_GATED_KEYS: ReadonlyArray<keyof GraphDefaults> = ["NEBULA_RADIUS_MULT", "NEBULA_MIN_RADIUS"];

// Ungated NUMBER keys -- applied from ANY profile version regardless of
// TYPO_V/FOG_V (vendor ~:1034-1065's unconditional assignments, minus the
// two gated groups above and the string/boolean SC_PILL_SHAPE/
// SC_PILL_AUTOFIT keys handled separately below).
const UNGATED_NUMBER_KEYS: ReadonlyArray<keyof GraphDefaults> = [
  "BASE_SC_ICON_SIZE",
  "ICON_LOD_FADE_START",
  "ICON_LOD_FADE_END",
  "GROUP_CAPTION_LOD_K_MIN",
  "GROUP_CAPTION_LOD_FADE",
  "LOD_BASE_THRESHOLD",
  "LOD_POWER",
  "LOD_FADE_RANGE",
  "SINGLETON_LOD_POWER",
  "SINGLETON_LOD_FADE_RANGE",
  "SINGLETON_LABEL_BASE_OPACITY",
  "SC_PILL_CORNER_ROUNDNESS",
  "SC_PILL_RADIUS",
  "SC_PILL_FIXED_WIDTH",
  "SC_PILL_FIXED_HEIGHT",
  "SC_PILL_PADDING",
  "HULL_PADDING",
  "FIT_WORLD_PAD",
  "NEBULA_FIT_CORE",
  "SC_OVERLAY_OPACITY_FACTOR",
  "SC_SATELLITE_COUNT",
  "SC_LABEL_TOP_PAD",
  "NODE_RADIUS",
  "BASE_PAGE_DOT_SIZE",
  "PAGE_SPREAD_MULT",
  "STAR_GLYPH_OPACITY_MULT",
];

// Same "trust but verify the shape" guard lib/preferences.ts's getPreferences
// uses for a JSON body of unknown provenance -- excludes arrays (typeof
// array === "object" too) since none of the objects this module reads
// (prefs, tuner_profiles, a single profile snapshot, a SCALE_THRESHOLDS
// entry) are ever legitimately arrays.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProfilesMap(prefs: Record<string, unknown>): Record<string, unknown> {
  return isPlainRecord(prefs.tuner_profiles) ? prefs.tuner_profiles : {};
}

/** Port of resolveEffectiveSlot (vendor ~:1087-1100): the per-machine
 *  localStorage override wins over the server's per-user default slot;
 *  either resolving to a slot with no matching saved profile, or no
 *  override/default at all, falls through to null ("apply nothing, stay on
 *  code defaults"). The literal string 'none' is the machine override's
 *  explicit-reset marker (distinct from "no override written yet") --
 *  preserved exactly, since a future write path (batch 05) writes this same
 *  sentinel. All storage access is try/catch'd -- private-mode browsers
 *  throw on read. */
function resolveEffectiveSlot(
  prefs: Record<string, unknown>,
  userKey: string | null | undefined,
  storage: TunerSlotStorage | null | undefined
): string | null {
  const profiles = getProfilesMap(prefs);
  if (userKey && storage) {
    let stored: string | null = null;
    try {
      stored = storage.getItem(MACHINE_SLOT_KEY_PREFIX + userKey);
    } catch {
      stored = null; // private mode / storage disabled -- fall through to server default
    }
    if (stored === "none") return null;
    if (stored && Object.prototype.hasOwnProperty.call(profiles, stored)) return stored;
  }
  const serverSlot = prefs.tuner_active_profile;
  if (typeof serverSlot === "string" && Object.prototype.hasOwnProperty.call(profiles, serverSlot)) {
    return serverSlot;
  }
  return null;
}

// Review fix round 1 rider (F3), deliberate deviation from the vendor:
// applyTunerSnapshot applies k_min/k_max INDEPENDENTLY per field (vendor
// `d3-graph-vendor.js:1047-1048` -- `if (typeof ...k_min === 'number')
// ...k_min = ...;` and the k_max line right after it, two separate
// `if`s), so a snapshot with a valid k_min but garbage/missing k_max
// there leaves k_max at whatever the LIVE module var currently holds
// (a previous mount's value, or the
// compile-time default on a first mount) -- a half-applied, mount-history-
// dependent result. This function is atomic per entry instead: BOTH
// k_min and k_max must be valid numbers, or the whole entry is dropped
// (falls back to GRAPH_DEFAULTS for that entry once merged at the call
// site). Chosen deliberately, not an oversight: this module's entire
// design point is handing the vendor a FULLY resolved, mount-history-
// independent snapshot (see this file's and GraphCanvas.tsx's own
// comments on why every real call site merges onto GRAPH_DEFAULTS rather
// than passing a sparse partial) -- a half-valid k_min/k_max pair
// producing a mixed stale-plus-new state would undermine exactly that
// guarantee. Real saved profiles are always written as complete
// {k_min,k_max} pairs by construction (there is no UI path that writes
// just one of the two), so this only changes behavior for a hand-edited
// or corrupted profile -- see task-B-report.md's fix-round-1 section for
// the full writeup.
function parseScaleThreshold(value: unknown): ScaleThreshold | null {
  if (!isPlainRecord(value)) return null;
  const { k_min, k_max } = value;
  if (typeof k_min !== "number" || typeof k_max !== "number") return null;
  return { k_min, k_max };
}

/** Port of applyTunerSnapshot's version-gating semantics (vendor
 *  ~:997-1068), re-expressed as a pure builder instead of a live-var
 *  mutator: given a raw saved-profile snapshot, returns only the keys that
 *  should apply from it. */
function gateSnapshot(snap: Record<string, unknown>): Partial<GraphDefaults> {
  const typoOK = snap.TYPO_V === TUNER_TYPO_VERSION;
  const fogOK = snap.FOG_V === TUNER_FOG_VERSION;
  const out: Record<string, unknown> = {};

  // SCALE_THRESHOLDS: when the profile specifies ANY thresholds, always
  // output a COMPLETE 7-key object (GRAPH_DEFAULTS values filled in for
  // every gated-out/missing/invalid entry) -- the call site's shallow
  // `{...GRAPH_DEFAULTS, ...snapshot}` merge REPLACES this whole key
  // wholesale rather than deep-merging, so a partial object here would
  // silently drop the other keys' defaults entirely at the vendor
  // (clampedScale's own `if (!t) return 1.0;` fallback masks this as
  // "no clamping" for the missing keys rather than a crash, but it is
  // still a real behavior bug -- so this function absorbs the merge
  // hazard itself rather than leaning on caller discipline).
  if (isPlainRecord(snap.SCALE_THRESHOLDS)) {
    const thresholds = { ...GRAPH_DEFAULTS.SCALE_THRESHOLDS };
    let anyApplied = false;
    for (const key of Object.keys(snap.SCALE_THRESHOLDS) as ScaleThresholdKey[]) {
      if (!(key in thresholds)) continue; // unknown key on an untrusted object -- ignore
      if (TYPO_GATED_THRESHOLD_KEYS.has(key) && !typoOK) continue;
      const parsed = parseScaleThreshold((snap.SCALE_THRESHOLDS as Record<string, unknown>)[key]);
      if (!parsed) continue;
      thresholds[key] = parsed;
      anyApplied = true;
    }
    if (anyApplied) out.SCALE_THRESHOLDS = thresholds;
  }

  if (typoOK) {
    for (const key of TYPO_GATED_FLAT_KEYS) {
      const value = snap[key];
      if (typeof value === "number") out[key] = value;
    }
  }

  for (const key of UNGATED_NUMBER_KEYS) {
    const value = snap[key];
    if (typeof value === "number") out[key] = value;
  }

  if (typeof snap.SC_PILL_SHAPE === "string") out.SC_PILL_SHAPE = snap.SC_PILL_SHAPE;
  if (typeof snap.SC_PILL_AUTOFIT === "boolean") out.SC_PILL_AUTOFIT = snap.SC_PILL_AUTOFIT;

  if (fogOK) {
    for (const key of FOG_GATED_KEYS) {
      const value = snap[key];
      if (typeof value === "number") out[key] = value;
    }
  }

  return out as Partial<GraphDefaults>;
}

/**
 * Resolve the tuner snapshot that should apply BEFORE first paint (spec
 * decision C) -- pure and synchronous (no fetch; the one localStorage read
 * is the only side effect, and it's try/catch'd). Callers merge the result
 * onto GRAPH_DEFAULTS (`{...GRAPH_DEFAULTS, ...snapshot}`) before handing it
 * to the vendor's `opts.tunerSnapshot` -- see components/GraphCanvas.tsx's
 * wiring comment for why the merge happens at the call site rather than
 * here (every mount must hand the vendor a FULLY populated object, never a
 * sparse one the vendor's own per-key gate could interpret against
 * leftover state from a previous mount).
 *
 * @param prefs   The `preferences` sub-object off GET /api/auth/me (the
 *                same row GET /api/auth/preferences reads) -- reads
 *                `tuner_profiles`/`tuner_active_profile` only; any other
 *                shape (missing, non-object, malformed) resolves to `{}`.
 * @param userKey The `id` field off the SAME /api/auth/me response,
 *                stringified by the caller -- namespaces the machine-
 *                override localStorage slot so admin<->demo view-as
 *                switching on one browser can't cross-apply a profile
 *                saved under a different account.
 * @param storage Typically `window.localStorage`; injectable for tests
 *                (and safely omittable -- a null/undefined storage just
 *                skips the machine-override check and falls through to the
 *                server default).
 */
export function resolveTunerSnapshot(
  prefs: unknown,
  userKey: string | null | undefined,
  storage: TunerSlotStorage | null | undefined
): Partial<GraphDefaults> {
  const prefsObj = isPlainRecord(prefs) ? prefs : {};
  const slot = resolveEffectiveSlot(prefsObj, userKey, storage);
  if (!slot) return {};
  const profiles = getProfilesMap(prefsObj);
  const snap = profiles[slot];
  if (!isPlainRecord(snap)) return {};
  return gateSnapshot(snap);
}
