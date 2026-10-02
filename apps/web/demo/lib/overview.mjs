// demo/lib/overview.mjs -- the stub's Overview dev-view computation.
//
// TWIN of apps/api/backend/db/overview_repo.py (+ services/overview_summary.py
// for the empty spend shape), computed over the recorded fixtures:
//   - pages: the Pipeline fixture rows (each carries the backend's `fate`), windowed
//     on visited_at exactly like Pipeline (All time also counts NULL visits);
//   - captures: [{started_at, source}] from the demo seed, windowed on started_at;
//   - spend: always empty -- the demo seed has no cost events;
//   - clusters: the recorded latest-run block, replayed.
import { DAY, GRANULARITY, RANGE_DAYS, bucketWalls, floorWall, isoWithOffset, normalizeRange, prepare, wallOf, windowRows } from "./period.mjs";

const DESKTOP = new Set(["desktop_active", "desktop_passive"]);
const SPEND_KEYS = ["gates", "clustering", "chat", "other"];
const emptySpend = () => ({ usd: 0, calls: 0, all_time_usd: 0, purposes: [] });
const zeroSpend = () => Object.fromEntries(SPEND_KEYS.map((k) => [k, 0]));
// prepare() keys rows on `visited_at`; captures carry `started_at`.
const prepCaptures = (rows) => rows.map((c) => ({ ...c, _visited: Date.parse(c.started_at) }));

export function computeOverviewSummary(pages, captures, clusters, range, nowMs) {
  const key = normalizeRange(range);
  const p = prepare(pages);
  const inWindow = windowRows(p, key, nowMs);
  const caps = windowRows(prepCaptures(captures), key, nowMs);
  const desktop = caps.filter((c) => DESKTOP.has(c.source)).length;
  return {
    range: key,
    pages: { captured: inWindow.length, in_graph: inWindow.filter((r) => r.fate === "active").length, all_time_captured: windowRows(p, "all", nowMs).length },
    captures: { total: caps.length, desktop, phone: caps.filter((c) => c.source === "mobile_passive").length },
    spend: emptySpend(),
    clusters: clusters ?? null,
  };
}

export function computeOverviewTimeline(pages, captures, range, tz, nowMs) {
  const key = normalizeRange(range);
  const [granularity, labelKey] = GRANULARITY[key];
  const p = prepare(pages);
  const c = prepCaptures(captures);
  const days = RANGE_DAYS[key];
  let firstMs = nowMs;
  let baseline = { captured: 0, in_graph: 0 };
  if (days !== undefined) {
    firstMs = nowMs - days * DAY;
    const before = p.filter((r) => r._visited !== null && r._visited < firstMs);
    baseline = { captured: before.length, in_graph: before.filter((r) => r.fate === "active").length };
  } else {
    const times = [...p, ...c].map((r) => r._visited).filter((t) => t !== null && t <= nowMs);
    if (times.length) firstMs = Math.min(...times);
  }
  const slots = new Map(bucketWalls(firstMs, nowMs, tz, granularity).map((w) => [w, { captured: 0, in_graph: 0, captures: { desktop: 0, phone: 0 }, spend: zeroSpend(), calls: 0 }]));
  for (const r of windowRows(p, key, nowMs)) {
    if (r._visited === null) continue;
    const b = slots.get(floorWall(wallOf(r._visited, tz), granularity));
    if (!b) continue;
    b.captured += 1;
    if (r.fate === "active") b.in_graph += 1;
  }
  for (const r of windowRows(c, key, nowMs)) {
    const b = slots.get(floorWall(wallOf(r._visited, tz), granularity));
    if (!b) continue;
    if (DESKTOP.has(r.source)) b.captures.desktop += 1;
    else if (r.source === "mobile_passive") b.captures.phone += 1;
  }
  return {
    range: key,
    granularity,
    baseline,
    buckets: [...slots].map(([w, b]) => ({ start: isoWithOffset(w, tz), label_key: labelKey, ...b })),
  };
}
