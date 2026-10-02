import type { FlowOutcomeKey, PipelinePage, RangeKey, TimeWindow } from "./types";

// The shared TimeWindow ("365" has no pipeline bucket, so it widens to "all").
export function rangeKeyFor(tw: TimeWindow): RangeKey {
  return tw === "7" ? "7d" : tw === "30" ? "30d" : tw === "90" ? "90d" : "all";
}
export const DASH = "—";
export const PERIOD_LABELS: Record<RangeKey, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };
/** Table cells for the flow redesign: decision / skip kind / skip reason (free text rides in the title). */
export function flowColumns(p: PipelinePage): { decision: string; skip: string; skipReason: string; skipReasonTitle?: string } {
  const decision = p.outcome === "processed" ? "keep" : p.outcome === "gate" || p.outcome === "rule_filter" ? "skip" : DASH;
  const skip = p.outcome === "before_gate" ? "pre-gate" : p.outcome === "rule_filter" ? "rule" : p.outcome === "gate" ? "LLM gate" : DASH;
  return { decision, skip, skipReason: p.fate === "active" ? DASH : p.detail_label, skipReasonTitle: p.skip_reasoning ?? undefined };
}

/** CSS custom-property references; the view's stylesheet defines the --flow-* variables. */
export const OUTCOME_COLOR: Record<FlowOutcomeKey, string> = {
  processed: "var(--flow-processed)",
  gate: "var(--flow-gate)",
  rule_filter: "var(--flow-rule)",
  before_gate: "var(--flow-before)",
  pending: "var(--flow-pending)",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
export function formatVisited(iso: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${MONTHS[d.getMonth()]} ${two(d.getDate())}, ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function percentOf(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}
/** Backend archive_ratio (a 0..1 fraction) as "xx.x%"; missing or non-finite input reads 0.0%, never NaN. */
export function formatRatio(ratio: number | null | undefined): string {
  return `${(Number.isFinite(ratio) ? (ratio as number) * 100 : 0).toFixed(1)}%`;
}
/** The viewer's IANA zone, sent as `tz` so the backend buckets visited_at in local time. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
