// Task 4: fixture date-shift primitives. All math is UTC-based on purpose
// (task-3 report's flagged concern: meta.anchor is a UTC calendar date, so
// computing "today" in local time would silently introduce an off-by-one
// whenever the server's local date and UTC date disagree around midnight).
import { describe, expect, it } from "vitest";
import {
  computeDeltaDays,
  shiftDayKeyLabel,
  shiftWeekKeyLabel,
  shiftMonthKeyLabel,
  shiftIsoDateTime,
  shiftDiaryWindow,
} from "./dates.mjs";

describe("computeDeltaDays", () => {
  it("is 0 when anchor and now are the same UTC date", () => {
    const now = new Date("2026-08-15T10:00:00Z");
    expect(computeDeltaDays("2026-08-15", now)).toBe(0);
  });

  it("is positive when now is after the anchor", () => {
    const now = new Date("2026-08-20T10:00:00Z");
    expect(computeDeltaDays("2026-08-15", now)).toBe(5);
  });

  it("is negative when now is before the anchor", () => {
    const now = new Date("2026-08-10T10:00:00Z");
    expect(computeDeltaDays("2026-08-15", now)).toBe(-5);
  });

  it("uses the UTC date, not local time, near a UTC midnight boundary", () => {
    // 2026-08-14T23:30 America/New_York-style "late night local" is already
    // 2026-08-15 in UTC -- the delta must be computed off the UTC date.
    const now = new Date("2026-08-15T02:00:00Z");
    expect(computeDeltaDays("2026-08-15", now)).toBe(0);
  });
});

describe("shiftDayKeyLabel", () => {
  it("shifts the key by deltaDays and re-formats the label to match", () => {
    const { key, label } = shiftDayKeyLabel("2026-08-14", 1);
    expect(key).toBe("2026-08-15");
    expect(label).toBe("Aug 15, 2026");
  });

  it("deltaDays=0 is a no-op", () => {
    const { key, label } = shiftDayKeyLabel("2026-08-14", 0);
    expect(key).toBe("2026-08-14");
    expect(label).toBe("Aug 14, 2026");
  });

  it("crosses a month boundary correctly", () => {
    const { key, label } = shiftDayKeyLabel("2026-08-31", 1);
    expect(key).toBe("2026-09-01");
    expect(label).toBe("Sep 01, 2026");
  });
});

describe("shiftWeekKeyLabel", () => {
  it("deltaDays=0 leaves an ISO week key and its same-month label unchanged", () => {
    // 2026-W33 = Aug 10-16, 2026 (same month -- en-dash, no spaces).
    const { key, label } = shiftWeekKeyLabel("2026-W33", 0);
    expect(key).toBe("2026-W33");
    expect(label).toBe("Aug 10–16, 2026");
  });

  it("a small shift within the same ISO week does not change the key", () => {
    const { key } = shiftWeekKeyLabel("2026-W33", 2);
    expect(key).toBe("2026-W33");
  });

  it("a shift past the week boundary rolls the key forward", () => {
    // Monday of W33 is Aug 10; +7 days lands on Aug 17, the following Monday.
    const { key } = shiftWeekKeyLabel("2026-W33", 7);
    expect(key).toBe("2026-W34");
  });

  it("formats a cross-month week label with the wider en-dash form", () => {
    // 2026-W31 = Jul 27 - Aug 02, 2026 (crosses the month boundary).
    const { label } = shiftWeekKeyLabel("2026-W31", 0);
    expect(label).toBe("Jul 27 – Aug 02, 2026");
  });
});

describe("shiftMonthKeyLabel", () => {
  it("deltaDays=0 is a no-op", () => {
    const { key, label } = shiftMonthKeyLabel("2026-08", 0);
    expect(key).toBe("2026-08");
    expect(label).toBe("August 2026");
  });

  it("shifts across a year boundary", () => {
    const { key, label } = shiftMonthKeyLabel("2026-12", 31);
    expect(key).toBe("2027-01");
    expect(label).toBe("January 2027");
  });
});

describe("shiftIsoDateTime", () => {
  it("shifts the date portion and preserves the time-of-day exactly", () => {
    expect(shiftIsoDateTime("2026-08-14T23:31:45+00:00", 1)).toBe("2026-08-15T23:31:45+00:00");
  });

  it("deltaDays=0 is a no-op", () => {
    expect(shiftIsoDateTime("2026-08-14T23:31:45+00:00", 0)).toBe("2026-08-14T23:31:45+00:00");
  });

  it("passes through null/undefined unchanged", () => {
    expect(shiftIsoDateTime(null, 5)).toBe(null);
  });
});

describe("shiftDiaryWindow", () => {
  it("shifts only key/label, leaving node_ids/cluster_freq/page_count untouched", () => {
    const window = {
      key: "2026-08-14",
      label: "Aug 14, 2026",
      node_ids: ["1", "2"],
      graph_node_ids: ["a", "b"],
      cluster_freq: { x: 2 },
      cluster_names: { x: "X" },
      page_count: 2,
    };
    const shifted = shiftDiaryWindow(window, "day", 1);
    expect(shifted.key).toBe("2026-08-15");
    expect(shifted.label).toBe("Aug 15, 2026");
    expect(shifted.node_ids).toEqual(window.node_ids);
    expect(shifted.cluster_freq).toEqual(window.cluster_freq);
    expect(shifted.page_count).toBe(2);
  });
});
