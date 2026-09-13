import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRange } from '../modules/format.js';

// `now` is fixed per test so year-inclusion logic (which compares against
// "this year") is deterministic. ISO strings below deliberately omit the
// trailing 'Z' -- a date-time string with no time zone designator is parsed
// as LOCAL time per the ES spec, so these tests are stable regardless of
// the machine/CI timezone they run under (both the input and `now` are
// read back via local getters).
const NOW_2026 = new Date('2026-09-13T12:00:00');

test('formatRange: same calendar day', () => {
  const result = formatRange('2026-09-10T13:02:00', '2026-09-10T14:11:00', NOW_2026);
  assert.equal(result, 'Sep 10, 13:02 – 14:11');
});

test('formatRange: cross-day (spans midnight)', () => {
  const result = formatRange('2026-09-09T22:05:00', '2026-09-10T00:14:00', NOW_2026);
  assert.equal(result, 'Sep 9, 22:05 – Sep 10, 00:14');
});

test('formatRange: cross-year -- start year differs from now, includes year on both ends', () => {
  // Same calendar day, but that day is not in `now`'s year.
  const result = formatRange('2025-09-10T13:02:00', '2025-09-10T14:11:00', NOW_2026);
  assert.equal(result, 'Sep 10, 2025, 13:02 – 14:11');
});

test('formatRange: cross-day AND cross-year (spans New Year\'s Eve)', () => {
  const result = formatRange('2025-12-31T23:50:00', '2026-01-01T00:10:00', NOW_2026);
  assert.equal(result, 'Dec 31, 2025, 23:50 – Jan 1, 2026, 00:10');
});

test('formatRange: missing end (still recording) renders a trailing ellipsis', () => {
  const result = formatRange('2026-09-10T13:02:00', null, NOW_2026);
  assert.equal(result, 'Sep 10, 13:02 – …');
});

test('formatRange: missing end, with a year that differs from now', () => {
  const result = formatRange('2025-09-10T13:02:00', undefined, NOW_2026);
  assert.equal(result, 'Sep 10, 2025, 13:02 – …');
});

test('formatRange: missing start returns empty string', () => {
  assert.equal(formatRange(null, '2026-09-10T14:11:00', NOW_2026), '');
  assert.equal(formatRange(undefined, undefined, NOW_2026), '');
});

test('formatRange: accepts an epoch-ms number for startIso (live capture has no ISO yet)', () => {
  const startMs = new Date('2026-09-10T13:02:00').getTime();
  const result = formatRange(startMs, null, NOW_2026);
  assert.equal(result, 'Sep 10, 13:02 – …');
});

test('formatRange: unparseable start returns empty string', () => {
  assert.equal(formatRange('not-a-date', '2026-09-10T14:11:00', NOW_2026), '');
  assert.equal(formatRange('not-a-date', null, NOW_2026), '');
});

test('formatRange: unparseable end is treated as missing (trailing ellipsis)', () => {
  const result = formatRange('2026-09-10T13:02:00', 'not-a-date', NOW_2026);
  assert.equal(result, 'Sep 10, 13:02 – …');
});
