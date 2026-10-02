import type { OverviewBucket, OverviewSummary, OverviewTimeline } from "@/lib/types";

export const summary = (o: Partial<OverviewSummary> = {}): OverviewSummary => ({
  range: "all",
  pages: { captured: 4812, in_graph: 731, all_time_captured: 4812 },
  captures: { total: 512, desktop: 300, phone: 212 },
  spend: { usd: 0.8421, calls: 3250, all_time_usd: 0.8421, purposes: [
    { key: "gates", label: "Skip & learning gates", usd: 0.61, calls: 3000, event_types: [{ key: "skip_gate", label: "Skip gate", usd: 0.5932, calls: 2900 }, { key: "learning_gate", label: "Learning gate", usd: 0.0168, calls: 100 }] },
    { key: "chat", label: "Chat", usd: 0.2321, calls: 250, event_types: [{ key: "agent_query", label: "Chat answers", usd: 0.2321, calls: 250 }] },
  ] },
  clusters: { run_completed_at: "2026-09-23T12:00:00+00:00", clusters: 42, superclusters: 5, topics: 7 },
  ...o,
});
export const bucket = (i: number, o: Partial<OverviewBucket> = {}): OverviewBucket => ({
  start: `2026-0${3 + i}-01T00:00:00+00:00`, label_key: "month", captured: 10 * (i + 1), in_graph: i + 1,
  captures: { desktop: i, phone: 1 }, spend: { gates: 0.01 * i, clustering: 0, chat: 0.001, other: 0 }, calls: 3, ...o,
});
export const timeline = (buckets: OverviewBucket[]): OverviewTimeline => ({ range: "all", granularity: "month", baseline: { captured: 0, in_graph: 0 }, buckets });
export const zeroBucket = (i: number): OverviewBucket => bucket(i, { captured: 0, in_graph: 0, captures: { desktop: 0, phone: 0 }, spend: { gates: 0, clustering: 0, chat: 0, other: 0 }, calls: 0 });
