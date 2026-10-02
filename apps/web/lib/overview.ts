import type { OverviewBucket, SpendPurposeKey } from "./types";

/** usePeriodFetch keeps only an error's message, so a 404 from the Overview routes (API older than the view) travels as this string. */
export const STALE_API_MESSAGE = "stale-api";

// TWIN of PURPOSES in apps/api/backend/services/overview_summary.py: keep keys, order and labels in step.
export const SPEND_ORDER: SpendPurposeKey[] = ["gates", "clustering", "chat", "other"];
export const SPEND_LABELS: Record<SpendPurposeKey, string> = { gates: "Skip & learning gates", clustering: "Clustering & naming", chat: "Chat", other: "Other" };

const NF = new Intl.NumberFormat("en-US");
export function formatCount(n: number): string { return NF.format(Number.isFinite(n) ? n : 0); }
export function plural(n: number, word: string): string { return `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`; }
/** $0.00 for zero, four decimals below one cent (demo spend stays legible), two otherwise. */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0.00";
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}
/** Short axis tick: "$0", "$0.015", "$1.5". */
export function formatUsdTick(v: number): string { return v === 0 ? "$0" : `$${Number(v.toPrecision(3))}`; }
export function shareOf(n: number, d: number): string { return `${(d > 0 ? (n / d) * 100 : 0).toFixed(1)}%`; }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 23" in the viewer's zone; "—" when missing or unparseable. */
export function formatRunDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Corpus size at the end of each bucket: the pre-period baseline plus everything visited up to it. */
export function runningTotals(baseline: { captured: number; in_graph: number }, buckets: OverviewBucket[]): { captured: number[]; inGraph: number[] } {
  let c = baseline.captured, g = baseline.in_graph;
  const captured: number[] = [], inGraph: number[] = [];
  for (const b of buckets) { c += b.captured; g += b.in_graph; captured.push(c); inGraph.push(g); }
  return { captured, inGraph };
}
export function periodDeltas(buckets: OverviewBucket[]): { captured: number; inGraph: number } {
  return buckets.reduce((a, b) => ({ captured: a.captured + b.captured, inGraph: a.inGraph + b.in_graph }), { captured: 0, inGraph: 0 });
}
export function bucketSpend(b: OverviewBucket): number { return SPEND_ORDER.reduce((a, k) => a + (b.spend[k] ?? 0), 0); }
export function hasOverviewActivity(buckets: OverviewBucket[]): boolean {
  return buckets.some((b) => b.captured > 0 || b.captures.desktop + b.captures.phone > 0 || b.calls > 0 || bucketSpend(b) > 0);
}
