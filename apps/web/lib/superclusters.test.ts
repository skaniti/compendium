import { describe, expect, it } from "vitest";
import { clustersPagesLabel, MAX_SUPERCLUSTERS, scLayout, spanLabel, suggestionReason } from "./superclusters";
import type { TopicSuggestion } from "./types";

function sug(overrides: Partial<TopicSuggestion> = {}): TopicSuggestion {
  return {
    id: 1, label: "Science", source: "suggested", topic: null, topic_similarity: null, interest_tier: "core",
    evidence: { n_weeks: 13, span_days: 210 }, member_count: 9, page_count: 82, cluster_ids: [], cluster_names: [],
    split_proposal: null, cluster_slugs: [], ...overrides,
  };
}

describe("superclusters helpers", () => {
  it("allows 24 slots", () => expect(MAX_SUPERCLUSTERS).toBe(24));

  it("clustersPagesLabel pluralises", () => {
    expect(clustersPagesLabel(sug())).toBe("9 clusters · 82 pages");
    expect(clustersPagesLabel(sug({ member_count: 1, page_count: 1 }))).toBe("1 cluster · 1 page");
  });

  it("spanLabel: days under 60, months from 60", () => {
    expect(spanLabel(45)).toBe("45 days");
    expect(spanLabel(59)).toBe("59 days");
    expect(spanLabel(60)).toBe("2 months");
    expect(spanLabel(210)).toBe("7 months");
  });

  it("suggestionReason includes the active-in part only when the evidence has both numbers", () => {
    expect(suggestionReason(sug())).toBe("9 clusters · 82 pages · active in 13 weeks over 7 months");
    expect(suggestionReason(sug({ evidence: { n_weeks: 1, span_days: 20 } }))).toBe("9 clusters · 82 pages · active in 1 week over 20 days");
    expect(suggestionReason(sug({ evidence: { n_weeks: 4 } }))).toBe("9 clusters · 82 pages");
    expect(suggestionReason(sug({ evidence: null }))).toBe("9 clusters · 82 pages");
  });

  it("suggestionReason leaves the active-in part out for thin evidence (under 1 week or under 1 day)", () => {
    expect(suggestionReason(sug({ evidence: { n_weeks: 0, span_days: 30 } }))).toBe("9 clusters · 82 pages");
    expect(suggestionReason(sug({ evidence: { n_weeks: 3, span_days: 0 } }))).toBe("9 clusters · 82 pages");
    expect(suggestionReason(sug({ evidence: { n_weeks: 1, span_days: 1 } }))).toBe("9 clusters · 82 pages · active in 1 week over 1 day");
  });

  it("scLayout: two rows of half the allowance above 12 slots, the original single row at 12 or fewer", () => {
    expect(scLayout(24)).toMatchObject({ cols: 12, rows: 2, tilePx: 23 });
    expect(scLayout(13)).toMatchObject({ cols: 7, rows: 2 });
    expect(scLayout(12)).toMatchObject({ cols: 12, rows: 1, tilePx: 33, iconPx: 34 });
    expect(scLayout(6)).toMatchObject({ cols: 6, rows: 1 });
  });

  it("the two-row layout fits the card body (2 tiles + gap <= 51px)", () => {
    const l = scLayout(24);
    expect(l.rows * l.tilePx + (l.rows - 1) * l.gapPx).toBeLessThanOrEqual(51);
  });
});
