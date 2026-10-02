import type { OverviewBucket, OverviewSummary, OverviewTimeline } from "@/lib/types";

export const summary = (o: Partial<OverviewSummary> = {}): OverviewSummary => ({
  range: "all",
  pages: { captured: 10094, in_graph: 1276, all_time_captured: 10094 },
  captures: { total: 1095, desktop: 418, phone: 677 },
  spend: { usd: 1.5234, calls: 7724, all_time_usd: 1.5234, purposes: [
    { key: "gates", label: "Skip & learning gates", usd: 1.04, calls: 7348, event_types: [{ key: "skip_gate", label: "Skip gate", usd: 1.0251, calls: 7067 }, { key: "learning_gate", label: "Learning gate", usd: 0.0144, calls: 281 }] },
    { key: "chat", label: "Chat", usd: 0.0482, calls: 104, event_types: [{ key: "agent_query", label: "Chat answers", usd: 0.0482, calls: 104 }] },
  ] },
  clusters: { run_completed_at: "2026-09-23T12:00:00+00:00", clusters: 86, superclusters: 6, topics: 8 },
  ...o,
});
export const bucket = (i: number, o: Partial<OverviewBucket> = {}): OverviewBucket => ({
  start: `2026-0${3 + i}-01T00:00:00+00:00`, label_key: "month", captured: 10 * (i + 1), in_graph: i + 1,
  captures: { desktop: i, phone: 1 }, spend: { gates: 0.01 * i, clustering: 0, chat: 0.001, other: 0 }, calls: 3, ...o,
});
export const timeline = (buckets: OverviewBucket[]): OverviewTimeline => ({ range: "all", granularity: "month", baseline: { captured: 0, in_graph: 0 }, buckets });
export const zeroBucket = (i: number): OverviewBucket => bucket(i, { captured: 0, in_graph: 0, captures: { desktop: 0, phone: 0 }, spend: { gates: 0, clustering: 0, chat: 0, other: 0 }, calls: 0 });
