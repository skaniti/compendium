import type { FlowOutcomeKey, TimelineBucket, TimelineGranularity } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BLOCKS = ["night", "morning", "afternoon", "evening"]; // 00-06, 06-12, 12-18, 18-24 local

// Bucket starts arrive as ISO strings carrying the viewer's local offset; read
// the wall clock straight off the string so no Date conversion shifts it.
function wall(start: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(start);
  if (!m) return { y: 0, mo: 0, d: 0, h: 0 };
  return { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), h: Number(m[4]) };
}
const monthDay = (w: ReturnType<typeof wall>) => `${MONTHS[w.mo] ?? "???"} ${String(w.d).padStart(2, "0")}`;

/** Hover title for one bucket. */
export function bucketTitle(bucket: TimelineBucket, g: TimelineGranularity): string {
  const w = wall(bucket.start);
  if (g === "6h") return `${monthDay(w)} · ${BLOCKS[Math.min(3, Math.floor(w.h / 6))]}`;
  if (g === "week") return `wk of ${monthDay(w)}`;
  if (g === "month") return `${MONTHS[w.mo] ?? "???"} ${w.y}`;
  return monthDay(w);
}

/** x-axis label candidates, one per bucket (null = no label here). 6h blocks label only the first block of each day. */
export function axisLabels(buckets: TimelineBucket[], g: TimelineGranularity): (string | null)[] {
  return buckets.map((bk, i) => {
    if (g !== "6h") return bucketTitle(bk, g);
    const w = wall(bk.start);
    return w.h < 6 || i === 0 ? monthDay(w) : null;
  });
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Stack order of the volume panel, bottom to top. */
export const VOLUME_ORDER: FlowOutcomeKey[] = ["processed", "gate", "rule_filter", "before_gate", "pending"];

export function hasFlowActivity(buckets: TimelineBucket[]): boolean {
  return buckets.some((b) => b.total > 0);
}

/** y in percent (1 decimal); null where the denominator is 0 so the line breaks. */
export interface RatePoint { y: number | null; n: number; d: number }
const ratePoint = (n: number, d: number): RatePoint => ({ y: d > 0 ? round1(pct(n, d)) : null, n, d });

/** archive = archived (by fate, i.e. effective status) / total; gate = gate / reached_gate. */
export function rateSeries(buckets: TimelineBucket[]): { archive: RatePoint[]; gate: RatePoint[] } {
  return {
    archive: buckets.map((b) => ratePoint(b.archived, b.total)),
    gate: buckets.map((b) => ratePoint(b.outcomes.gate, b.reached_gate)),
  };
}

/** Rate points over fewer pages than this are noise: drawn hollow and kept out of the axis domain. */
export const MIN_RATE_DENOM = 10;
export const isSparse = (p: RatePoint): boolean => p.d < MIN_RATE_DENOM;

/** [min(60, lowest y rounded down to 20), 100]; points with a denominator below MIN_RATE_DENOM do not count. */
export function rateDomain(series: { archive: RatePoint[]; gate: RatePoint[] }): [number, number] {
  const ys = [...series.archive, ...series.gate].filter((p) => !isSparse(p)).map((p) => p.y).filter((y): y is number => y !== null);
  if (ys.length === 0) return [60, 100];
  return [Math.min(60, Math.floor(Math.min(...ys) / 20) * 20), 100];
}

/** 100%-stacked gate-category shares per bucket: ids in `order` first, unknown ids appended sorted; ids with no counts are dropped. */
export function mixSeries(buckets: TimelineBucket[], order: string[], labels: Record<string, string>): { id: string; name: string; counts: number[]; values: number[] }[] {
  const seen = new Set<string>();
  for (const b of buckets) for (const [id, n] of Object.entries(b.categories)) if (n > 0) seen.add(id);
  const ids = [...order.filter((id) => seen.has(id)), ...[...seen].filter((id) => !order.includes(id)).sort()];
  const totals = buckets.map((b) => Object.values(b.categories).reduce((a, n) => a + n, 0));
  return ids.map((id) => {
    const counts = buckets.map((b) => b.categories[id] ?? 0);
    const name = Object.hasOwn(labels, id) ? labels[id] : id.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return { id, name, counts, values: counts.map((n, i) => round1(pct(n, totals[i]))) };
  });
}

/** Length of the leading run of buckets with no gate decisions, but only for monthly (All time) buckets, when the run had captures and the gate went live later; else 0. Finer buckets lacking gate decisions are ordinary. */
export function gateNotLiveRun(buckets: TimelineBucket[], g: TimelineGranularity): number {
  if (g !== "month") return 0;
  let run = 0;
  while (run < buckets.length && buckets[run].reached_gate === 0) run++;
  if (run === 0 || run === buckets.length) return 0;
  const hadActivity = buckets.slice(0, run).some((b) => b.total > 0);
  return hadActivity ? run : 0;
}
