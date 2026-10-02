import type { PipelinePage, RangeKey, TimeWindow } from "./types";

// The shared TimeWindow ("365" has no pipeline bucket, so it widens to "all").
export function rangeKeyFor(tw: TimeWindow): RangeKey {
  return tw === "7" ? "7d" : tw === "30" ? "30d" : tw === "90" ? "90d" : "all";
}
export const DASH = "—";
const GATE_REASONS = new Set(["skip_gate", "manual_exclusion", "trivial_capture"]);

export function deriveSkipColumns(p: PipelinePage): { skip: string; skipReason: string } {
  const r = p.archive_reason;
  const skip = r === "domain_skip" ? "domain" : r && GATE_REASONS.has(r) ? "gate" : DASH;
  const skipReason = r === "domain_skip" ? "domain filter" : p.skip_reasoning ? p.skip_reasoning.slice(0, 80) : DASH;
  return { skip, skipReason };
}

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
