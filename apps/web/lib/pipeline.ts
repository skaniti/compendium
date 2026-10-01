import type { PipelinePage, RangeKey } from "./types";

export const RANGE_KEYS: RangeKey[] = ["7d", "30d", "90d", "all"];
export const RANGE_LABELS: Record<RangeKey, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };
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
export function archiveRatio(active: number, archived: number): string {
  const total = active + archived;
  return `${(total > 0 ? (archived / total) * 100 : 0).toFixed(1)}%`;
}

export function skipRatePoints(rows: { day: string; total: number; skipped: number }[]) {
  return rows.map((r) => ({
    day: new Date(`${r.day}T00:00:00`),
    rate: r.total > 0 ? Math.round((r.skipped / r.total) * 1000) / 10 : 0,
    skipped: r.skipped,
    total: r.total,
  }));
}

export function skipReasonMix(rows: { day: string; reason: string; cnt: number }[]) {
  const days = Array.from(new Set(rows.map((r) => r.day))).sort();
  const names = Array.from(new Set(rows.map((r) => r.reason))).sort();
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.day, (totals.get(r.day) ?? 0) + r.cnt);
  const lookup = new Map(rows.map((r) => [`${r.day}\u0000${r.reason}`, r.cnt]));
  const series = names.map((name) => ({
    name,
    values: days.map((d) => {
      const t = totals.get(d) ?? 0;
      const c = lookup.get(`${d}\u0000${name}`) ?? 0;
      return t > 0 ? Math.round((c / t) * 1000) / 10 : 0;
    }),
  }));
  return { days, series };
}

// Twin of SKIP_METHOD_LABELS in apps/api/backend/services/pipeline_summary.py; keep in sync.
const ARCHIVE_REASON_LABELS: Record<string, string> = {
  skip_gate: "LLM Skip Gate", domain_skip: "Domain Filter", manual_exclusion: "Manual Exclusion", trivial_capture: "Trivial Capture",
  placeholder_no_content: "Placeholder No Content", dedup: "Dedup", app_chrome_junk: "App Chrome Junk", dedupe_fold: "Dedupe Fold", other: "Other",
};
export function archiveReasonLabel(raw: string): string {
  return ARCHIVE_REASON_LABELS[raw] ?? raw.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
