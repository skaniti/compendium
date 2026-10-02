import { describe, it, expect } from "vitest";
import { computeOverviewSummary, computeOverviewTimeline } from "./overview.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const pages = [
  { visited_at: iso(NOW - 1 * day), fate: "active" },
  { visited_at: iso(NOW - 2 * day), fate: "archived" },
  { visited_at: iso(NOW - 40 * day), fate: "active" },
  { visited_at: null, fate: "pending" },
  { visited_at: iso(NOW + 3_600_000), fate: "active" },
];
const captures = [
  { started_at: iso(NOW - 1 * day), source: "desktop_active" },
  { started_at: iso(NOW - 3 * day), source: "mobile_passive" },
  { started_at: iso(NOW - 50 * day), source: "desktop_passive" },
];
const clusters = { run_completed_at: "2026-09-19T08:00:00+00:00", clusters: 49, superclusters: 4, topics: 4 };

describe("overview stub", () => {
  it("summary windows pages like Pipeline and captures by started_at; spend is empty", () => {
    const s = computeOverviewSummary(pages, captures, clusters, "7d", NOW);
    expect(s).toEqual({
      range: "7d",
      pages: { captured: 2, in_graph: 1, all_time_captured: 4 },
      captures: { total: 2, desktop: 1, phone: 1 },
      spend: { usd: 0, calls: 0, all_time_usd: 0, purposes: [] },
      clusters,
    });
    expect(computeOverviewSummary(pages, captures, null, "all", NOW).pages).toEqual({ captured: 4, in_graph: 2, all_time_captured: 4 });
    expect(computeOverviewSummary(pages, captures, null, "bogus", NOW).range).toBe("all");
  });
  it("timeline: baseline, zero-filled buckets, spend keys, local offsets", () => {
    const t = computeOverviewTimeline(pages, captures, "30d", "UTC", NOW);
    expect(t.granularity).toBe("day");
    expect(t.buckets).toHaveLength(31);
    expect(t.baseline).toEqual({ captured: 1, in_graph: 1 });
    expect(t.buckets.reduce((a, b) => a + b.captured, 0)).toBe(2);
    expect(t.buckets.reduce((a, b) => a + b.captures.desktop + b.captures.phone, 0)).toBe(2);
    expect(t.buckets[0].spend).toEqual({ gates: 0, clustering: 0, chat: 0, other: 0 });
    expect(computeOverviewTimeline(pages, captures, "7d", "Asia/Kolkata", NOW).buckets.every((b) => b.start.endsWith("+05:30"))).toBe(true);
  });
  it("All time starts at the earliest page or capture, baseline zero", () => {
    const t = computeOverviewTimeline(pages, captures, "all", "UTC", NOW);
    expect(t.baseline).toEqual({ captured: 0, in_graph: 0 });
    expect(t.buckets[0].start.startsWith("2026-08-01")).toBe(true); // the 50-day-old capture
  });
});
