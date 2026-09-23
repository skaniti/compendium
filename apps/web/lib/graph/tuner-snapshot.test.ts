import { describe, expect, it } from "vitest";
import { GRAPH_DEFAULTS, TUNER_FOG_VERSION, TUNER_TYPO_VERSION } from "./constants";
import { resolveTunerSnapshot, type TunerSlotStorage } from "./tuner-snapshot";

// Batch 03 (graph canvas port) Task group B, Part 2 (spec decision C).
// Table-driven port tests for resolveTunerSnapshot -- written FIRST per the
// brief, against the vendor's own applyTunerSnapshot (d3-graph-vendor.js
// ~:997-1068) / resolveEffectiveSlot (~:1087-1100) semantics. See
// task-B-report.md for the full gated-key table with vendor line cites.

// Minimal in-memory TunerSlotStorage -- avoids a real jsdom localStorage
// dependency (this module's own contract only needs getItem) and lets a
// test assert "throws" behavior directly.
function makeStorage(entries: Record<string, string> = {}): TunerSlotStorage {
  return {
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
  };
}

const THROWING_STORAGE: TunerSlotStorage = {
  getItem(): string | null {
    throw new Error("private mode: storage disabled");
  },
};

// A minimal, fully-gate-passing profile snapshot -- current TYPO_V/FOG_V
// stamps, one representative key from every gated/ungated group, plus a
// non-default pageDot threshold (the one ungated SCALE_THRESHOLDS entry).
function fullSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TYPO_V: TUNER_TYPO_VERSION,
    FOG_V: TUNER_FOG_VERSION,
    SCALE_THRESHOLDS: {
      clLabel: { k_min: 1.1, k_max: 2.2 },
      pageDot: { k_min: 0.5, k_max: 3.0 },
    },
    BASE_LABEL_FONT_SIZE: 42,
    BASE_SC_ICON_SIZE: 77,
    NEBULA_RADIUS_MULT: 12,
    NEBULA_MIN_RADIUS: 300,
    HULL_PADDING: 99,
    SC_PILL_SHAPE: "rectangle",
    SC_PILL_AUTOFIT: false,
    ...overrides,
  };
}

describe("resolveTunerSnapshot: slot resolution (port of resolveEffectiveSlot)", () => {
  it("returns {} when there is no active slot at all (no override, no server default)", () => {
    const prefs = { tuner_profiles: {}, tuner_active_profile: null };
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toEqual({});
  });

  it("applies the server default slot when no machine override is stored", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 9 }) },
      tuner_active_profile: "1",
    };
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toMatchObject({ BASE_PAGE_DOT_SIZE: 9 });
  });

  it("a per-machine localStorage override WINS over the server default slot", () => {
    const prefs = {
      tuner_profiles: {
        "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 1 }),
        "2": fullSnapshot({ BASE_PAGE_DOT_SIZE: 2 }),
      },
      tuner_active_profile: "1",
    };
    const storage = makeStorage({ compendium_tuner_slot_42: "2" });
    expect(resolveTunerSnapshot(prefs, "42", storage)).toMatchObject({ BASE_PAGE_DOT_SIZE: 2 });
  });

  it("machine override 'none' is an explicit reset -- resolves to {} even with a valid server default", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot() },
      tuner_active_profile: "1",
    };
    const storage = makeStorage({ compendium_tuner_slot_42: "none" });
    expect(resolveTunerSnapshot(prefs, "42", storage)).toEqual({});
  });

  it("a machine override pointing at a slot with no matching saved profile falls through to the server default", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 1 }) },
      tuner_active_profile: "1",
    };
    const storage = makeStorage({ compendium_tuner_slot_42: "3" }); // "3" was never saved
    expect(resolveTunerSnapshot(prefs, "42", storage)).toMatchObject({ BASE_PAGE_DOT_SIZE: 1 });
  });

  it("a server default slot with no matching saved profile resolves to {}", () => {
    const prefs = { tuner_profiles: {}, tuner_active_profile: "1" }; // "1" not in tuner_profiles
    expect(resolveTunerSnapshot(prefs, "42", makeStorage())).toEqual({});
  });

  it("namespaces the machine-override key per userKey -- a DIFFERENT user's override never cross-applies", () => {
    const prefs = {
      tuner_profiles: { "2": fullSnapshot({ BASE_PAGE_DOT_SIZE: 2 }) },
      tuner_active_profile: null,
    };
    // Override is stored under user 99, not the userKey this call passes (42).
    const storage = makeStorage({ compendium_tuner_slot_99: "2" });
    expect(resolveTunerSnapshot(prefs, "42", storage)).toEqual({});
  });

  it("no userKey -- skips the machine-override check entirely, uses the server default", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 1 }) },
      tuner_active_profile: "1",
    };
    const storage = makeStorage({ compendium_tuner_slot_null: "1" }); // would never be looked up
    expect(resolveTunerSnapshot(prefs, null, storage)).toMatchObject({ BASE_PAGE_DOT_SIZE: 1 });
  });

  it("no storage (e.g. SSR/non-browser caller) -- falls through to the server default safely", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 1 }) },
      tuner_active_profile: "1",
    };
    expect(resolveTunerSnapshot(prefs, "42", null)).toMatchObject({ BASE_PAGE_DOT_SIZE: 1 });
  });

  it("a throwing storage.getItem (private-mode browsers) is swallowed, falling through to the server default", () => {
    const prefs = {
      tuner_profiles: { "1": fullSnapshot({ BASE_PAGE_DOT_SIZE: 1 }) },
      tuner_active_profile: "1",
    };
    expect(() => resolveTunerSnapshot(prefs, "42", THROWING_STORAGE)).not.toThrow();
    expect(resolveTunerSnapshot(prefs, "42", THROWING_STORAGE)).toMatchObject({ BASE_PAGE_DOT_SIZE: 1 });
  });

  it.each([
    ["null prefs", null],
    ["undefined prefs", undefined],
    ["a scalar", "not-an-object"],
    ["an array", []],
  ])("malformed prefs (%s) resolves to {} rather than throwing", (_label, prefs) => {
    expect(() => resolveTunerSnapshot(prefs, "1", makeStorage())).not.toThrow();
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toEqual({});
  });

  it("a non-object tuner_profiles value is treated as {} -- no matching slot", () => {
    const prefs = { tuner_profiles: "corrupt", tuner_active_profile: "1" };
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toEqual({});
  });
});

describe("resolveTunerSnapshot: version gating (port of applyTunerSnapshot)", () => {
  function withSlot1(snapshot: Record<string, unknown>): Record<string, unknown> {
    return { tuner_profiles: { "1": snapshot }, tuner_active_profile: "1" };
  }

  it("an unknown/missing slot (no profile saved under the resolved slot) resolves to {}", () => {
    const prefs = { tuner_profiles: {}, tuner_active_profile: "1" };
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toEqual({});
  });

  it("a profile value that isn't an object resolves to {}", () => {
    const prefs = { tuner_profiles: { "1": "corrupt" }, tuner_active_profile: "1" };
    expect(resolveTunerSnapshot(prefs, "1", makeStorage())).toEqual({});
  });

  // TABLE: [description, TYPO_V, expectTypoApplied]
  it.each([
    ["current TYPO_V -- typography keys APPLY", TUNER_TYPO_VERSION, true],
    ["stale TYPO_V (one version behind) -- typography keys DROPPED", TUNER_TYPO_VERSION - 1, false],
    ["missing TYPO_V -- typography keys DROPPED", undefined, false],
  ])("%s", (_label, typoV, expectTypoApplied) => {
    const snap = fullSnapshot({ TYPO_V: typoV });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());

    if (expectTypoApplied) {
      expect(result.BASE_LABEL_FONT_SIZE).toBe(42);
      expect(result.SCALE_THRESHOLDS?.clLabel).toEqual({ k_min: 1.1, k_max: 2.2 });
    } else {
      expect(result.BASE_LABEL_FONT_SIZE).toBeUndefined();
      // Dropped typo-gated entry falls back to the code default, not the
      // stale profile's value nor an absent key (merge-safety contract).
      expect(result.SCALE_THRESHOLDS?.clLabel).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS.clLabel);
    }
    // pageDot is the one ungated SCALE_THRESHOLDS entry -- applies
    // regardless of TYPO_V.
    expect(result.SCALE_THRESHOLDS?.pageDot).toEqual({ k_min: 0.5, k_max: 3.0 });
    // Ungated spatial keys are unaffected by TYPO_V either way.
    expect(result.BASE_SC_ICON_SIZE).toBe(77);
  });

  it("SC_PLATE_FIT_REF_PX / SC_NAME_FIT_FLOOR_PX are typo-gated: apply from a current profile, dropped from a stale one", () => {
    const current = resolveTunerSnapshot(
      withSlot1(fullSnapshot({ SC_PLATE_FIT_REF_PX: 800, SC_NAME_FIT_FLOOR_PX: 14 })), "1", makeStorage());
    expect(current.SC_PLATE_FIT_REF_PX).toBe(800);
    expect(current.SC_NAME_FIT_FLOOR_PX).toBe(14);
    const stale = resolveTunerSnapshot(
      withSlot1(fullSnapshot({ TYPO_V: TUNER_TYPO_VERSION - 1, SC_PLATE_FIT_REF_PX: 800, SC_NAME_FIT_FLOOR_PX: 14 })), "1", makeStorage());
    expect(stale.SC_PLATE_FIT_REF_PX).toBeUndefined();
    expect(stale.SC_NAME_FIT_FLOOR_PX).toBeUndefined();
  });

  // Review fix round 1, finding F2: the table above only ever exercises
  // clLabel (typo-gated) and pageDot (ungated) of the 7 SCALE_THRESHOLDS
  // entries -- scIcon/scName/singletonLabel/groupLabel/scLabel never
  // appeared, so a source-level regression dropping any ONE of those five
  // keys from TYPO_GATED_THRESHOLD_KEYS (tuner-snapshot.ts) would have
  // gone undetected. This table exercises ALL SIX typo-gated entries
  // individually: each must apply its own divergent value when TYPO_V is
  // current, and drop to the code default (not the stale profile's value)
  // when TYPO_V is stale. Removing any key from TYPO_GATED_THRESHOLD_KEYS
  // makes that key's "drops when stale" assertion fail (the divergent
  // value would incorrectly survive the stale stamp).
  const ALL_TYPO_GATED_THRESHOLD_KEYS = [
    "clLabel",
    "scLabel",
    "scName",
    "singletonLabel",
    "groupLabel",
    "scIcon",
  ] as const;

  it.each(ALL_TYPO_GATED_THRESHOLD_KEYS)(
    "SCALE_THRESHOLDS.%s: applies a divergent value when TYPO_V is current, drops to the code default when TYPO_V is stale",
    (key) => {
      const divergent = { k_min: 1.11, k_max: 2.22 };

      const snapCurrent = fullSnapshot({ SCALE_THRESHOLDS: { [key]: divergent } });
      const resultCurrent = resolveTunerSnapshot(withSlot1(snapCurrent), "1", makeStorage());
      expect(resultCurrent.SCALE_THRESHOLDS?.[key]).toEqual(divergent);

      const snapStale = fullSnapshot({
        TYPO_V: TUNER_TYPO_VERSION - 1,
        SCALE_THRESHOLDS: { [key]: divergent },
      });
      const resultStale = resolveTunerSnapshot(withSlot1(snapStale), "1", makeStorage());
      // When the ONLY entry in the profile's SCALE_THRESHOLDS is this one
      // (typo-gated) key, and it's dropped, NOTHING validated -- the whole
      // SCALE_THRESHOLDS field is omitted from the partial (same
      // merge-equivalent omission the "ignores a SCALE_THRESHOLDS entry
      // with a non-numeric k_min/k_max" test above documents), not an
      // object with this key defaulted and the rest absent. Assert via the
      // same merge the real call site performs, so this checks the ACTUAL
      // end state ("did the divergent value survive the stale stamp"),
      // not the intermediate partial's exact shape.
      const merged = { ...GRAPH_DEFAULTS.SCALE_THRESHOLDS, ...resultStale.SCALE_THRESHOLDS };
      expect(merged[key]).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS[key]);
    }
  );

  // TABLE: [description, FOG_V, expectFogApplied]
  it.each([
    ["current FOG_V -- fog keys APPLY", TUNER_FOG_VERSION, true],
    ["stale FOG_V (one version behind) -- fog keys DROPPED", TUNER_FOG_VERSION - 1, false],
    ["missing FOG_V -- fog keys DROPPED", undefined, false],
  ])("%s", (_label, fogV, expectFogApplied) => {
    const snap = fullSnapshot({ FOG_V: fogV });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());

    if (expectFogApplied) {
      expect(result.NEBULA_RADIUS_MULT).toBe(12);
      expect(result.NEBULA_MIN_RADIUS).toBe(300);
    } else {
      expect(result.NEBULA_RADIUS_MULT).toBeUndefined();
      expect(result.NEBULA_MIN_RADIUS).toBeUndefined();
    }
    // HULL_PADDING is explicitly NOT part of the T3 fog re-baseline gate --
    // always applies regardless of FOG_V (vendor's own TUNER_FOG_VERSION
    // comment).
    expect(result.HULL_PADDING).toBe(99);
  });

  it("every ungated flat key applies from ANY profile version (both stamps stale)", () => {
    const snap = fullSnapshot({ TYPO_V: 0, FOG_V: 0 });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.BASE_SC_ICON_SIZE).toBe(77);
    expect(result.HULL_PADDING).toBe(99);
    expect(result.SC_PILL_SHAPE).toBe("rectangle");
    expect(result.SC_PILL_AUTOFIT).toBe(false);
    // Both gated groups dropped.
    expect(result.BASE_LABEL_FONT_SIZE).toBeUndefined();
    expect(result.NEBULA_RADIUS_MULT).toBeUndefined();
  });

  it("SCALE_THRESHOLDS is always a COMPLETE 7-key object when returned, even if the profile only specifies one entry (merge-safety)", () => {
    const snap = fullSnapshot({
      SCALE_THRESHOLDS: { pageDot: { k_min: 0.5, k_max: 3.0 } }, // only one of 7 keys
    });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(Object.keys(result.SCALE_THRESHOLDS ?? {}).sort()).toEqual(
      Object.keys(GRAPH_DEFAULTS.SCALE_THRESHOLDS).sort()
    );
    expect(result.SCALE_THRESHOLDS?.pageDot).toEqual({ k_min: 0.5, k_max: 3.0 });
    // The six other entries fall back to code defaults, not an absent key.
    expect(result.SCALE_THRESHOLDS?.clLabel).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS.clLabel);
    expect(result.SCALE_THRESHOLDS?.groupLabel).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS.groupLabel);
  });

  it("SCALE_THRESHOLDS is omitted entirely from the result when the profile specifies none", () => {
    const snap = fullSnapshot();
    delete snap.SCALE_THRESHOLDS;
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.SCALE_THRESHOLDS).toBeUndefined();
  });

  it("ignores a SCALE_THRESHOLDS entry with a non-numeric k_min/k_max instead of applying garbage", () => {
    const snap = fullSnapshot({
      SCALE_THRESHOLDS: { pageDot: { k_min: "oops", k_max: 3.0 } },
    });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    // No SCALE_THRESHOLDS entry validated at all -- the key is omitted
    // entirely rather than an empty/garbage object (equivalent end state
    // either way once merged onto GRAPH_DEFAULTS at the call site, but the
    // omission is the more honest partial).
    const merged = { ...GRAPH_DEFAULTS.SCALE_THRESHOLDS, ...result.SCALE_THRESHOLDS };
    expect(merged.pageDot).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS.pageDot);
  });

  it("still outputs the other valid entries when one SCALE_THRESHOLDS entry in the same profile is garbage", () => {
    const snap = fullSnapshot({
      SCALE_THRESHOLDS: {
        clLabel: { k_min: 1.1, k_max: 2.2 }, // valid, typo-gated
        pageDot: { k_min: "oops", k_max: 3.0 }, // invalid, ungated
      },
    });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.SCALE_THRESHOLDS?.clLabel).toEqual({ k_min: 1.1, k_max: 2.2 });
    expect(result.SCALE_THRESHOLDS?.pageDot).toEqual(GRAPH_DEFAULTS.SCALE_THRESHOLDS.pageDot);
  });

  it("ignores an unknown SCALE_THRESHOLDS key on an untrusted profile object", () => {
    const snap = fullSnapshot({
      SCALE_THRESHOLDS: { notAKey: { k_min: 1, k_max: 2 }, pageDot: { k_min: 0.5, k_max: 3.0 } },
    });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.SCALE_THRESHOLDS).not.toHaveProperty("notAKey");
    expect(result.SCALE_THRESHOLDS?.pageDot).toEqual({ k_min: 0.5, k_max: 3.0 });
  });

  it("ignores a non-numeric value for a number-typed key instead of applying garbage", () => {
    const snap = fullSnapshot({ BASE_SC_ICON_SIZE: "big" });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.BASE_SC_ICON_SIZE).toBeUndefined();
  });

  it("ignores a wrong-typed SC_PILL_SHAPE/SC_PILL_AUTOFIT instead of applying garbage", () => {
    const snap = fullSnapshot({ SC_PILL_SHAPE: 5, SC_PILL_AUTOFIT: "yes" });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result.SC_PILL_SHAPE).toBeUndefined();
    expect(result.SC_PILL_AUTOFIT).toBeUndefined();
  });

  it("a full current-version profile round-trips every declared key group (integration check across the whole gate table)", () => {
    const snap = fullSnapshot({ SC_PLATE_FIT_REF_PX: 700, SC_NAME_FIT_FLOOR_PX: 13 });
    const result = resolveTunerSnapshot(withSlot1(snap), "1", makeStorage());
    expect(result).toMatchObject({
      BASE_LABEL_FONT_SIZE: 42,
      BASE_SC_ICON_SIZE: 77,
      NEBULA_RADIUS_MULT: 12,
      NEBULA_MIN_RADIUS: 300,
      HULL_PADDING: 99,
      SC_PILL_SHAPE: "rectangle",
      SC_PILL_AUTOFIT: false,
      SC_PLATE_FIT_REF_PX: 700,
      SC_NAME_FIT_FLOOR_PX: 13,
    });
    // TYPO_V/FOG_V themselves are gate discriminators, not vendor render
    // state -- never forwarded into the output (the call-site merge lets
    // GRAPH_DEFAULTS' own current-version stamps win instead, see
    // GraphCanvas.tsx's wiring comment for why this matters on a remount).
    expect(result).not.toHaveProperty("TYPO_V");
    expect(result).not.toHaveProperty("FOG_V");
  });
});
