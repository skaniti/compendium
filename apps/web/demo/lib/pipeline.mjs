// demo/lib/pipeline.mjs -- the stub's Pipeline dev-view computation.
//
// Mirrors apps/api/backend/db/pipeline_repo.py + services/pipeline_summary.py
// in plain JS over the recorded pages fixture, so summary / timeline / pages
// answer any `range` + `tz` without the real backend:
//   - window on `visited_at`: 7d/30d/90d = [now - N days, now]; `all` has no
//     lower bound and is the only range that counts NULL visits (always
//     capped at visited_at <= now);
//   - timeline buckets in local wall-clock time (Intl parts, no dependency):
//     7d -> 6h blocks aligned 00/06/12/18, 30d -> days, 90d -> weeks starting
//     Monday, all -> months from the first visited month; empty buckets are
//     zeros; each `start` is ISO with the zone's UTC offset;
//   - top-3 domains per group, ordered n DESC, domain.
//
// Flow classification (outcome / detail / fate) is NOT recomputed here: each
// recorded page row already carries the backend SQL's verdict (`outcome`,
// `detail`, `detail_label`, `fate`), so summary / timeline aggregate those.
// Only the display constants below are mirrored.
//
// TWIN: OUTCOME_ORDER, FATE_ORDER, OUTCOME_LABELS, FATE_LABELS and the
// detail ordering in detailSortKey() duplicate OUTCOME_ORDER / FATE_ORDER /
// OUTCOME_LABELS / FATE_LABELS / _DETAIL_ORDER / _detail_sort_key in
// apps/api/backend/services/pipeline_summary.py (build_flow); keep them in
// step. Detail labels come from the recorded rows. rule_filter_config (redacted
// to counts, as for non-admins) and skip_gate_config are replayed from the recorded summary.

import { DAY, GRANULARITY, RANGE_DAYS, bucketWalls, floorWall, isValidTz, isoWithOffset, normalizeRange, prepare, wallOf, windowRows } from "./period.mjs";

export { isValidTz, normalizeRange };

const TOP_DOMAINS = 3;
export const OUTCOME_ORDER = ["before_gate", "rule_filter", "gate", "processed", "pending"];
export const FATE_ORDER = ["archived", "active", "pending"];
const OUTCOME_LABELS = {
  before_gate: "Archived before gate",
  rule_filter: "Rule filter \u00b7 no LLM",
  gate: "Skipped by LLM gate",
  processed: "Processed \u00b7 kept",
  pending: "Pending",
};
const FATE_LABELS = { archived: "Archived", active: "Active", pending: "Pending" };
// Display order of the fixed detail keys per outcome; gate is dynamic (count desc).
const DETAIL_ORDER = {
  before_gate: ["placeholder", "manual", "chrome", "duplicate", "other"],
  rule_filter: ["domain", "url_pattern"],
  processed: ["later_manual", "later_duplicate", "later_chrome", "later_other", "active"],
  pending: ["waiting"],
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function topDomains(rows) {
  const counts = new Map();
  for (const r of rows) {
    const domain = r.domain ?? "(unknown)";
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([da, na], [db, nb]) => nb - na || byCodePoint(da, db))
    .slice(0, TOP_DOMAINS)
    .map(([domain, count]) => ({ domain, count }));
}

function detailSortKey(outcome, key, count) {
  if (outcome === "gate") return [key === "uncategorized" ? 1 : 0, -count, key];
  const order = DETAIL_ORDER[outcome] ?? [];
  const i = order.indexOf(key);
  return [i === -1 ? order.length : i, 0, key];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function buildFlow(rows) {
  const outCounts = Object.fromEntries(OUTCOME_ORDER.map((k) => [k, 0]));
  const fateCounts = Object.fromEntries(FATE_ORDER.map((k) => [k, 0]));
  const outRows = new Map();
  const details = new Map();
  for (const r of rows) {
    outCounts[r.outcome] = (outCounts[r.outcome] ?? 0) + 1;
    fateCounts[r.fate] = (fateCounts[r.fate] ?? 0) + 1;
    (outRows.get(r.outcome) ?? outRows.set(r.outcome, []).get(r.outcome)).push(r);
    const dk = `${r.outcome}\0${r.detail}`;
    const d = details.get(dk) ?? { outcome: r.outcome, key: r.detail, label: r.detail_label, count: 0, rows: [], fates: Object.fromEntries(FATE_ORDER.map((k) => [k, 0])) };
    d.count += 1;
    d.rows.push(r);
    d.fates[r.fate] = (d.fates[r.fate] ?? 0) + 1;
    details.set(dk, d);
  }
  const ordered = [...details.values()].sort(
    (a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || compareKeys(detailSortKey(a.outcome, a.key, a.count), detailSortKey(b.outcome, b.key, b.count)),
  );
  return {
    total: rows.length,
    outcomes: OUTCOME_ORDER.map((k) => ({ key: k, label: OUTCOME_LABELS[k], count: outCounts[k], top_domains: topDomains(outRows.get(k) ?? []) })),
    details: ordered.map(({ rows: dr, ...d }) => ({ ...d, top_domains: topDomains(dr) })),
    fates: FATE_ORDER.map((k) => ({ key: k, label: FATE_LABELS[k], count: fateCounts[k] })),
  };
}

/**
 * The stub serves demo visitors, so the rule lists are redacted exactly like the
 * real API does for non-admins: counts kept from the recorded `counts` (a demo-account capture is already
 * redacted), else computed from legacy recorded lists; lists emptied.
 */
function redactRuleFilterConfig(cfg) {
  const domains = cfg.domains ?? [];
  const suffixes = cfg.domain_suffixes ?? [];
  const patterns = cfg.url_patterns ?? [];
  const paths = cfg.path_rules ?? [];
  return {
    counts: cfg.counts ?? { domains: domains.length + suffixes.length, url_patterns: patterns.length, path_rules: paths.length },
    lists_visible: false,
    domains: [],
    domain_suffixes: [],
    url_patterns: [],
    path_rules: [],
  };
}

/** `configs` = { rule_filter_config, skip_gate_config }, replayed from the recorded summary. */
export function computeSummary(allRows, range, nowMs, configs) {
  const key = normalizeRange(range);
  const rows = windowRows(prepare(allRows), key, nowMs);
  const flow = buildFlow(rows);
  const status_counts = Object.fromEntries(flow.fates.map((f) => [f.key, f.count]));
  return {
    range: key,
    total_pages: flow.total,
    status_counts,
    archive_ratio: flow.total ? status_counts.archived / flow.total : 0,
    flow,
    rule_filter_config: redactRuleFilterConfig(configs.rule_filter_config),
    skip_gate_config: configs.skip_gate_config,
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function computeTimeline(allRows, range, tz, nowMs) {
  const key = normalizeRange(range);
  const [granularity, labelKey] = GRANULARITY[key];
  const prepared = prepare(allRows);
  const rows = windowRows(prepared, key, nowMs).filter((r) => r._visited !== null);
  let firstMs = nowMs;
  if (RANGE_DAYS[key] !== undefined) firstMs = nowMs - RANGE_DAYS[key] * DAY;
  else {
    const visits = prepared.filter((r) => r._visited !== null && r._visited <= nowMs).map((r) => r._visited);
    if (visits.length) firstMs = Math.min(...visits);
  }
  const slots = new Map();
  for (const w of bucketWalls(firstMs, nowMs, tz, granularity)) {
    slots.set(w, { total: 0, archived: 0, outcomes: Object.fromEntries(OUTCOME_ORDER.map((k) => [k, 0])), reached_gate: 0, categories: {} });
  }
  for (const r of rows) {
    const b = slots.get(floorWall(wallOf(r._visited, tz), granularity));
    if (!b) continue;
    b.total += 1;
    if (r.fate === "archived") b.archived += 1;
    b.outcomes[r.outcome] += 1;
    if (r.outcome === "gate" || (r.outcome === "processed" && r.processing_depth !== null && r.processing_depth !== undefined)) b.reached_gate += 1;
    if (r.outcome === "gate") b.categories[r.detail] = (b.categories[r.detail] ?? 0) + 1;
  }
  return {
    range: key,
    granularity,
    buckets: [...slots].map(([w, b]) => ({ start: isoWithOffset(w, tz), label_key: labelKey, ...b })),
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const PAGE_SORTS = ["title", "domain", "status", "processing_depth", "visited_at", "created_at"];
const PAGE_KEEP = ["id", "title", "domain", "status", "processing_depth", "archive_reason", "skip_reasoning", "skip_category", "visited_at", "created_at", "outcome", "detail", "detail_label", "fate"];

export function computePages(allRows, range, nowMs, { limit, offset, sort, dir }) {
  const rows = windowRows(prepare(allRows), normalizeRange(range), nowMs);
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[sort] ?? null;
    const bv = b[sort] ?? null;
    if (av === null && bv === null) return b.id - a.id;
    if (av === null) return 1; // NULLS LAST both ways
    if (bv === null) return -1;
    return av < bv ? -sign : av > bv ? sign : b.id - a.id;
  });
  return {
    rows: rows.slice(offset, offset + limit).map((r) => Object.fromEntries(PAGE_KEEP.map((k) => [k, r[k] ?? null]))),
    total: rows.length,
    limit,
    offset,
    sort,
    dir,
  };
}
