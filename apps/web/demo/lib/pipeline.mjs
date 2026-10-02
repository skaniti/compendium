// demo/lib/pipeline.mjs -- the stub's v2 Pipeline dev-view computation.
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
//   - top-3 domains per group, ordered n DESC, domain; groups total DESC, key.
//
// TWIN: SKIP_CATEGORY_LABELS and SKIP_METHOD_LABELS below duplicate
// apps/api/backend/services/skip_categories.py and
// apps/api/backend/services/pipeline_summary.py; keep them in step.
// (skip_gate_config itself is replayed from the recorded summary.)

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };
const GRANULARITY = { "7d": ["6h", "block"], "30d": ["day", "day"], "90d": ["week", "week"], all: ["month", "month"] };
const TOP_DOMAINS = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STATUS_KEYS = ["active", "pending", "archived"];

export const SKIP_CATEGORY_LABELS = {
  login_wall: "Login Wall",
  user_specific: "User-Specific Page",
  store_listing: "Store / Pricing Page",
  homepage_index: "Homepage / Index",
  search_results: "Search Results",
  asset_library: "Asset Library Listing",
  entertainment_video: "Entertainment Video",
  disambiguation: "Disambiguation Page",
  error_page: "Error Page",
  content_free_stub: "Content-Free Stub",
  local_file: "Local File",
  web_app: "Web App / Tool",
  other: "Other",
};

const SKIP_METHOD_LABELS = {
  skip_gate: "LLM Skip Gate",
  domain_skip: "Domain Filter",
  manual_exclusion: "Manual Exclusion",
  trivial_capture: "Trivial Capture",
  placeholder_no_content: "Placeholder No Content",
  dedup: "Dedup",
  app_chrome_junk: "App Chrome Junk",
  dedupe_fold: "Dedupe Fold",
  other: "Other",
};

export function normalizeRange(range) {
  return Object.hasOwn(RANGE_DAYS, range ?? "") ? range : "all";
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA zone name (same bar as the API's ZoneInfo check). */
export function isValidTz(tz) {
  if (typeof tz !== "string" || tz === "" || /^[+-]/.test(tz) || /[^A-Za-z0-9_+\-/]/.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Local wall clock of instant `ms` in `tz`, as "UTC ms of the wall components". */
function wallOf(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetAt(ms, tz) {
  return wallOf(Math.floor(ms / 1000) * 1000, tz) - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC offset (ms) to attach to a local wall-clock start. Matches Python
 * zoneinfo fold=0: an ambiguous time takes the earlier (pre-change) offset,
 * a skipped time keeps the pre-change offset.
 */
function offsetForWall(wall, tz) {
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  if (before === after) return before;
  if (offsetAt(wall - before, tz) === before) return before;
  if (offsetAt(wall - after, tz) === after) return after;
  return before;
}

function isoWithOffset(wall, tz) {
  const off = offsetForWall(wall, tz);
  const sign = off < 0 ? "-" : "+";
  const mins = Math.round(Math.abs(off) / 60000);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${new Date(wall).toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

// Wall-clock arithmetic runs on "wall ms" (a naive local timestamp stored as
// UTC ms), exactly like Postgres timestamp-without-time-zone.
function floorWall(wall, granularity) {
  const d = new Date(wall);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  switch (granularity) {
    case "6h":
      return dayStart + Math.floor(d.getUTCHours() / 6) * 6 * HOUR;
    case "day":
      return dayStart;
    case "week":
      return dayStart - ((d.getUTCDay() + 6) % 7) * DAY; // Monday
    default:
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

function stepWall(wall, granularity) {
  switch (granularity) {
    case "6h":
      return wall + 6 * HOUR;
    case "day":
      return wall + DAY;
    case "week":
      return wall + 7 * DAY;
    default: {
      const d = new Date(wall);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

function prepare(rows) {
  return rows.map((r) => ({ ...r, _visited: r.visited_at ? Date.parse(r.visited_at) : null }));
}

function windowRows(rows, range, nowMs) {
  const days = RANGE_DAYS[range];
  if (days === undefined) return rows.filter((r) => r._visited === null || r._visited <= nowMs);
  const since = nowMs - days * DAY;
  return rows.filter((r) => r._visited !== null && r._visited >= since && r._visited <= nowMs);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function skipMethodLabel(key) {
  return SKIP_METHOD_LABELS[key] || key.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function skipCategoryLabel(key) {
  if (key === "uncategorized") return "Uncategorized";
  return SKIP_CATEGORY_LABELS[key] || skipMethodLabel(key);
}

function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupedWithTopDomains(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    const g = groups.get(key) ?? { total: 0, domains: new Map() };
    const domain = r.domain ?? "(unknown)";
    g.total += 1;
    g.domains.set(domain, (g.domains.get(domain) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.total - a.total || byCodePoint(ka, kb))
    .map(([key, g]) => ({
      key,
      count: g.total,
      top_domains: [...g.domains.entries()]
        .sort(([da, na], [db, nb]) => nb - na || byCodePoint(da, db))
        .slice(0, TOP_DOMAINS)
        .map(([domain, count]) => ({ domain, count })),
    }));
}

const NULL_KEYS = { Pending: "pending", "Trivial Capture": "trivial_capture", Other: "other" };

function buildDecisionRows(rows) {
  const depthCounts = new Map();
  const nullBreakdown = new Map();
  for (const r of rows) {
    const depth = r.processing_depth ?? "null";
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
    if (r.processing_depth === null || r.processing_depth === undefined) {
      const reason =
        r.status === "active" ? "legacy_active" : r.status === "pending" ? "Pending" : r.archive_reason === "trivial_capture" ? "Trivial Capture" : "Other";
      nullBreakdown.set(reason, (nullBreakdown.get(reason) ?? 0) + 1);
    }
  }
  const legacyActive = nullBreakdown.get("legacy_active") ?? 0;
  nullBreakdown.delete("legacy_active");
  const out = [];
  for (const [raw, count] of depthCounts) {
    if (raw === "null") {
      for (const [label, n] of nullBreakdown) out.push({ key: NULL_KEYS[label] ?? label.toLowerCase(), label, count: n, evaluated: false });
    } else if (raw === "processed") {
      out.push({ key: "processed", label: "Processed", count: count + legacyActive, evaluated: true });
    } else {
      out.push({ key: raw, label: raw === "skipped" ? "Skipped" : raw[0].toUpperCase() + raw.slice(1), count, evaluated: true });
    }
  }
  if (!depthCounts.has("processed") && legacyActive > 0) out.push({ key: "processed", label: "Processed", count: legacyActive, evaluated: true });
  return out.sort((a, b) => b.count - a.count);
}

export function computeSummary(allRows, range, nowMs, skipGateConfig) {
  const key = normalizeRange(range);
  const rows = windowRows(prepare(allRows), key, nowMs);
  const status_counts = Object.fromEntries(STATUS_KEYS.map((k) => [k, rows.filter((r) => r.status === k).length]));
  const total = rows.length;
  return {
    range: key,
    status_counts,
    total_pages: total,
    archive_ratio: total ? status_counts.archived / total : 0,
    decisions: buildDecisionRows(rows),
    archive_reasons: groupedWithTopDomains(
      rows.filter((r) => r.status === "archived"),
      (r) => r.archive_reason ?? "other",
    ).map((g) => ({ ...g, label: skipMethodLabel(g.key) })),
    skip_categories: groupedWithTopDomains(
      rows.filter((r) => r.archive_reason === "skip_gate"),
      (r) => r.skip_category ?? "uncategorized",
    ).map((g) => ({ ...g, label: skipCategoryLabel(g.key) })),
    skip_gate_config: skipGateConfig,
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
  const last = floorWall(wallOf(nowMs, tz), granularity);
  const slots = new Map();
  for (let w = floorWall(wallOf(firstMs, tz), granularity); w <= last; w = stepWall(w, granularity)) {
    slots.set(w, { kept: 0, archived: 0, evaluated: 0, skipped: 0, categories: {} });
  }
  for (const r of rows) {
    const b = slots.get(floorWall(wallOf(r._visited, tz), granularity));
    if (!b) continue;
    if (r.status === "archived") b.archived += 1;
    else b.kept += 1;
    if (r.processing_depth !== null && r.processing_depth !== undefined) b.evaluated += 1;
    if (r.processing_depth === "skipped") b.skipped += 1;
    if (r.archive_reason === "skip_gate") {
      const cat = r.skip_category ?? "uncategorized";
      b.categories[cat] = (b.categories[cat] ?? 0) + 1;
    }
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
const PAGE_KEEP = ["id", "title", "domain", "status", "processing_depth", "archive_reason", "skip_reasoning", "visited_at", "created_at"];

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
