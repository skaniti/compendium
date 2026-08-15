// Fixture date-shift primitives for the demo stub server (Task 4).
//
// demo/fixtures/ is baked once by demo/tools/build-fixtures.mjs, with every
// date relative to a frozen `meta.json` anchor (the UTC calendar date the
// fixtures were built on). This module re-derives every date-bearing field
// relative to "today" at server-boot time, by a single additive whole-day
// delta = today - anchor, so a demo deployed weeks after the fixtures were
// built still shows recently-active browsing instead of stale dates.
//
// CRITICAL: all date math here is UTC-based, matching build-fixtures.mjs's
// own anchor computation (`Date.UTC(...)`) -- computing "today" in local
// time would silently introduce an off-by-one whenever the server's local
// date and UTC date disagree (flagged in the task-3 report: the build
// machine is America/New_York, and a build run shortly after local midnight
// is already the next UTC day). Reuses the exact day/week/month key+label
// formatting algorithms build-fixtures.mjs uses, so a shifted key/label pair
// always has the same shape as one build-fixtures.mjs would have produced
// directly.

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_MS = 86400000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function isoDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function parseIsoDateUTC(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDaysUTC(d, days) {
  return new Date(d.getTime() + days * DAY_MS);
}

function isoWeekInfo(d) {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Thursday of this ISO week
  const isoYear = target.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNr = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4.getTime());
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4DayNr);
  const weekNo = Math.round((target - week1Mon) / (7 * DAY_MS)) + 1;
  return { isoYear, weekNo };
}

export function isoWeekKey(d) {
  const { isoYear, weekNo } = isoWeekInfo(d);
  return `${isoYear}-W${pad2(weekNo)}`;
}

export function weekMonday(d) {
  const dayNr = (d.getUTCDay() + 6) % 7;
  return addDaysUTC(d, -dayNr);
}

// Inverse of isoWeekKey: the Monday (UTC midnight) of the given ISO week key.
export function mondayOfIsoWeekKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) throw new Error(`not an ISO week key: ${key}`);
  const isoYear = Number(m[1]);
  const weekNo = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNr = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = addDaysUTC(jan4, -jan4DayNr);
  return addDaysUTC(week1Mon, (weekNo - 1) * 7);
}

export function formatDayLabel(dateStr) {
  const d = parseIsoDateUTC(dateStr);
  return `${MONTH_ABBR[d.getUTCMonth()]} ${pad2(d.getUTCDate())}, ${d.getUTCFullYear()}`;
}

export function formatWeekLabel(monday) {
  const sunday = addDaysUTC(monday, 6);
  const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth() && monday.getUTCFullYear() === sunday.getUTCFullYear();
  if (sameMonth) {
    return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())}–${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
  }
  const sameYear = monday.getUTCFullYear() === sunday.getUTCFullYear();
  if (sameYear) {
    return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())} – ${MONTH_ABBR[sunday.getUTCMonth()]} ${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
  }
  return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())}, ${monday.getUTCFullYear()} – ${MONTH_ABBR[sunday.getUTCMonth()]} ${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
}

export function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// today - anchor, in whole UTC days. Positive once the demo has aged past
// the day the fixtures were built; can be 0 or negative right after a fresh
// build (anchor == today, or a clock skew edge case).
export function computeDeltaDays(anchorIsoDate, now = new Date()) {
  const anchor = parseIsoDateUTC(anchorIsoDate);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((today.getTime() - anchor.getTime()) / DAY_MS);
}

// Shift a single ISO-8601 timestamp's DATE portion by deltaDays, preserving
// its time-of-day exactly (graph node first_visited_at). Passes through
// null/undefined/non-matching shapes unchanged rather than throwing -- a
// stub server should degrade gracefully on an unexpected fixture shape
// instead of blind-regexing content text (see the brief's D-note: do NOT
// blind-regex date-shaped substrings inside page extract text).
export function shiftIsoDateTime(iso, deltaDays) {
  if (!iso) return iso;
  const m = /^(\d{4}-\d{2}-\d{2})(T.*)$/.exec(iso);
  if (!m) return iso;
  const [, datePart, timePart] = m;
  const shifted = addDaysUTC(parseIsoDateUTC(datePart), deltaDays);
  return `${isoDateStr(shifted)}${timePart}`;
}

// Shift a day-granularity diary window's {key, label} by deltaDays.
export function shiftDayKeyLabel(key, deltaDays) {
  const shifted = addDaysUTC(parseIsoDateUTC(key), deltaDays);
  const newKey = isoDateStr(shifted);
  return { key: newKey, label: formatDayLabel(newKey) };
}

// Shift a week-granularity diary window's {key, label} by deltaDays. Weeks
// are keyed by ISO year+week (e.g. "2026-W33"). A rigid delta-day shift of a
// 7-day span does not generally stay aligned to the Monday-Sunday ISO grid
// (delta is rarely a multiple of 7), so instead of translating the span
// itself, this re-derives the Monday from the key, shifts THAT representative
// day, and finds the real ISO week the shifted day now falls in -- mirroring
// how build-fixtures.mjs derives a week window from a day in the first place.
// Consequence (intentional): a shift smaller than the distance to the next
// Sunday can leave the key unchanged; a shift that crosses a Sunday rolls it
// forward by one or more real weeks. Only key/label move -- see
// shiftDiaryWindow for why the rest of the window is left untouched.
export function shiftWeekKeyLabel(key, deltaDays) {
  const monday = mondayOfIsoWeekKey(key);
  const shiftedMonday = weekMonday(addDaysUTC(monday, deltaDays));
  return { key: isoWeekKey(shiftedMonday), label: formatWeekLabel(shiftedMonday) };
}

// Shift a month-granularity diary window's {key, label} by deltaDays, using
// the 1st of the month as the representative day to shift + re-derive from
// (same rationale as shiftWeekKeyLabel: a month's length varies, so there is
// no single "rigid translation" of a month span -- re-deriving from a shifted
// representative day is the only way to land on a real calendar month).
export function shiftMonthKeyLabel(key, deltaDays) {
  const [y, m] = key.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const shifted = addDaysUTC(first, deltaDays);
  const newKey = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
  return { key: newKey, label: formatMonthLabel(newKey) };
}

// Shift a DiaryWindow's key+label by deltaDays for the given granularity.
// Everything else (node_ids, graph_node_ids, cluster_freq, cluster_names,
// page_count) is copied through unchanged -- those describe WHICH pages were
// visited and how they cluster, not WHEN the window falls on the calendar,
// so they carry no date-shaped fields to shift.
export function shiftDiaryWindow(window, granularity, deltaDays) {
  const shiftFn =
    granularity === "day" ? shiftDayKeyLabel
    : granularity === "week" ? shiftWeekKeyLabel
    : shiftMonthKeyLabel;
  const { key, label } = shiftFn(window.key, deltaDays);
  return { ...window, key, label };
}
