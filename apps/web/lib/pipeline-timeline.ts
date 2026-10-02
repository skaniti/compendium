import type { TimelineBucket, TimelineGranularity } from "./types";

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

export function hasActivity(buckets: TimelineBucket[]): boolean {
  return buckets.some((b) => b.kept + b.archived > 0 || b.evaluated > 0 || b.skipped > 0);
}

export function archiveBars(buckets: TimelineBucket[]) {
  return buckets.map((b) => ({ kept: b.kept, archived: b.archived, rate: round1(pct(b.archived, b.kept + b.archived)) }));
}

/** y is null where nothing was evaluated, so the line breaks instead of reading 0%. */
export function skipRateSeries(buckets: TimelineBucket[]) {
  return buckets.map((b) => ({ y: b.evaluated > 0 ? round1(pct(b.skipped, b.evaluated)) : null, skipped: b.skipped, evaluated: b.evaluated }));
}

/** 100%-stacked category shares per bucket (0 across the board for a bucket with no gate skips). `labels` maps category id -> display label, in display order. */
export function categoryMix(buckets: TimelineBucket[], labels: Record<string, string>) {
  const ids = new Set<string>();
  for (const b of buckets) for (const [id, n] of Object.entries(b.categories)) if (n > 0) ids.add(id);
  const known = Object.keys(labels).filter((id) => ids.has(id));
  const rest = [...ids].filter((id) => !Object.hasOwn(labels, id)).sort();
  const totals = buckets.map((b) => Object.values(b.categories).reduce((a, n) => a + n, 0));
  const series = [...known, ...rest].map((id) => {
    const counts = buckets.map((b) => b.categories[id] ?? 0);
    return {
      name: Object.hasOwn(labels, id) ? labels[id] : id.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      counts,
      values: counts.map((n, i) => round1(pct(n, totals[i]))),
    };
  });
  return { series };
}
