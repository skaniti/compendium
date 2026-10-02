// demo/lib/period.mjs -- shared range / time-zone / bucket helpers for the stub's
// dev-view computations (pipeline.mjs, overview.mjs).
//
// Mirrors the backend's period machinery: windows on `visited_at`
// (7d/30d/90d = [now - N days, now]; `all` has no lower bound and is the only
// range that counts NULL visits, capped at <= now) and timeline buckets in
// local wall-clock time (Intl parts, no dependency).

export const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };
export const GRANULARITY = { "7d": ["6h", "block"], "30d": ["day", "day"], "90d": ["week", "week"], all: ["month", "month"] };
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function normalizeRange(range) {
  return Object.hasOwn(RANGE_DAYS, range ?? "") ? range : "all";
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatters = new Map();
/** Formatter for `tz`, cached by the resolved zone name (throws on invalid zones). */
export function formatter(tz) {
  const resolved = formatters.get(tz);
  if (resolved) return resolved;
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const zone = f.resolvedOptions().timeZone;
  const canonical = formatters.get(`\0${zone}`) ?? f;
  formatters.set(`\0${zone}`, canonical);
  formatters.set(tz, canonical);
  return canonical;
}

/** True when `tz` is a canonical IANA zone name: close to ZoneInfo; canonical names only. */
export function isValidTz(tz) {
  if (typeof tz !== "string" || tz === "" || /^[+-]/.test(tz) || /[^A-Za-z0-9_+\-/]/.test(tz)) return false;
  try {
    const zone = formatter(tz).resolvedOptions().timeZone;
    if (zone === tz) return true;
    // ICU resolves some canonical names to legacy aliases (Asia/Kolkata ->
    // Asia/Calcutta): accept those unless the input is only a case variant of
    // the resolved zone or has a segment that is not Capitalized.
    if (zone.toLowerCase() === tz.toLowerCase()) return false;
    return tz.split("/").every((seg) => /^[A-Z]/.test(seg) && seg !== seg.toUpperCase() || seg.length <= 3 && seg === seg.toUpperCase());
  } catch {
    return false;
  }
}

/** Local wall clock of instant `ms` in `tz`, as "UTC ms of the wall components". */
export function wallOf(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

export function offsetAt(ms, tz) {
  return wallOf(Math.floor(ms / 1000) * 1000, tz) - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC offset (ms) to attach to a local wall-clock start. Matches Python
 * zoneinfo fold=0: an ambiguous time takes the earlier (pre-change) offset,
 * a skipped time keeps the pre-change offset.
 */
export function offsetForWall(wall, tz) {
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  if (before === after) return before;
  if (offsetAt(wall - before, tz) === before) return before;
  if (offsetAt(wall - after, tz) === after) return after;
  return before;
}

export function isoWithOffset(wall, tz) {
  const off = offsetForWall(wall, tz);
  const sign = off < 0 ? "-" : "+";
  const mins = Math.round(Math.abs(off) / 60000);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${new Date(wall).toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

// Wall-clock arithmetic runs on "wall ms" (a naive local timestamp stored as
// UTC ms), exactly like Postgres timestamp-without-time-zone.
export function floorWall(wall, granularity) {
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

export function stepWall(wall, granularity) {
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

export function prepare(rows) {
  return rows.map((r) => ({ ...r, _visited: r.visited_at ? Date.parse(r.visited_at) : null }));
}

export function windowRows(rows, range, nowMs) {
  const days = RANGE_DAYS[range];
  if (days === undefined) return rows.filter((r) => r._visited === null || r._visited <= nowMs);
  const since = nowMs - days * DAY;
  return rows.filter((r) => r._visited !== null && r._visited >= since && r._visited <= nowMs);
}

/** Local wall-clock bucket starts ("wall ms") from firstMs's bucket through nowMs's. */
export function bucketWalls(firstMs, nowMs, tz, granularity) {
  const out = [];
  const last = floorWall(wallOf(nowMs, tz), granularity);
  for (let w = floorWall(wallOf(firstMs, tz), granularity); w <= last; w = stepWall(w, granularity)) out.push(w);
  return out;
}
