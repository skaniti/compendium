/**
 * Pure date/time formatting helpers for the cache viewer -- no DOM, no
 * Chrome API calls, so they're directly node:test-able (see
 * tests/format.test.mjs).
 */

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function partsOf(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
  };
}

function formatDatePart(parts, includeYear) {
  const monthDay = `${MONTH_ABBR[parts.month]} ${parts.day}`;
  return includeYear ? `${monthDay}, ${parts.year}` : monthDay;
}

function formatTimePart(parts) {
  return `${pad2(parts.hours)}:${pad2(parts.minutes)}`;
}

/**
 * Format a capture's date range for the cache card summary, local time,
 * 24h clock, en-dash (U+2013) with spaces around it:
 *   same calendar day:  "Sep 10, 13:02 – 14:11"
 *   different day:      "Sep 9, 22:05 – Sep 10, 00:14"
 *   either end's year differs from `now`'s year: year is included on BOTH
 *     ends, e.g. "Sep 9, 2025, 22:05 – Sep 10, 2025, 00:14"
 *   missing end (still recording): "Sep 10, 13:02 – …"
 *
 * `startIso`/`endIso` accept anything `new Date(...)` accepts (an ISO
 * string, or an epoch-ms number for the still-open live capture, which has
 * no ISO startedAt yet). Returns '' if `startIso` is missing.
 */
export function formatRange(startIso, endIso, now = new Date()) {
  if (!startIso) return '';

  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return '';

  const startParts = partsOf(start);
  const nowParts = partsOf(now);

  // An unparseable end is treated the same as a missing one -- render the
  // trailing "…" rather than propagating an "Invalid Date" string.
  const end = endIso ? new Date(endIso) : null;
  const hasEnd = Boolean(end) && !Number.isNaN(end.getTime());
  const endParts = hasEnd ? partsOf(end) : null;

  const includeYear = startParts.year !== nowParts.year
    || (hasEnd && endParts.year !== nowParts.year);

  const startDateStr = formatDatePart(startParts, includeYear);
  const startTimeStr = formatTimePart(startParts);

  if (!hasEnd) {
    return `${startDateStr}, ${startTimeStr} – …`;
  }

  const sameDay = startParts.year === endParts.year
    && startParts.month === endParts.month
    && startParts.day === endParts.day;

  const endTimeStr = formatTimePart(endParts);

  if (sameDay) {
    return `${startDateStr}, ${startTimeStr} – ${endTimeStr}`;
  }

  const endDateStr = formatDatePart(endParts, includeYear);
  return `${startDateStr}, ${startTimeStr} – ${endDateStr}, ${endTimeStr}`;
}
