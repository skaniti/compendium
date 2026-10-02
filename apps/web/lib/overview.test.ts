import { describe, it, expect } from "vitest";
import { bucketSpend, formatCount, formatRunDate, formatUsd, formatUsdTick, hasOverviewActivity, periodDeltas, plural, runningTotals, shareOf, SPEND_LABELS, SPEND_ORDER } from "./overview";
import type { OverviewBucket } from "./types";

const b = (o: Partial<OverviewBucket> = {}): OverviewBucket => ({
  start: "2026-09-01T00:00:00+00:00", label_key: "day", captured: 0, in_graph: 0,
  captures: { desktop: 0, phone: 0 }, spend: { gates: 0, clustering: 0, chat: 0, other: 0 }, calls: 0, ...o,
});

describe("overview lib", () => {
  it("formatUsd: zero, sub-cent, cents", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(0.0031)).toBe("$0.0031");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.8421)).toBe("$0.84");
  });
  it("formatUsdTick keeps axis labels short", () => {
    expect(formatUsdTick(0)).toBe("$0");
    expect(formatUsdTick(0.015)).toBe("$0.015");
    expect(formatUsdTick(1.5)).toBe("$1.5");
    expect(formatUsdTick(10)).toBe("$10");
  });
  it("formatCount and plural", () => {
    expect(formatCount(4812)).toBe("4,812");
    expect(plural(1, "capture")).toBe("1 capture");
    expect(plural(512, "capture")).toBe("512 captures");
    expect(plural(0, "call")).toBe("0 calls");
  });
  it("shareOf never NaN", () => {
    expect(shareOf(0, 0)).toBe("0.0%");
    expect(shareOf(731, 4812)).toBe("15.2%");
  });
  it("formatRunDate", () => {
    expect(formatRunDate("2026-09-23T12:00:00+00:00")).toBe("Sep 23");
    expect(formatRunDate(null)).toBe("—");
    expect(formatRunDate("garbage")).toBe("—");
  });
  it("runningTotals start from the baseline", () => {
    const t = runningTotals({ captured: 100, in_graph: 10 }, [b({ captured: 5, in_graph: 1 }), b(), b({ captured: 2, in_graph: 2 })]);
    expect(t.captured).toEqual([105, 105, 107]);
    expect(t.inGraph).toEqual([11, 11, 13]);
    expect(runningTotals({ captured: 0, in_graph: 0 }, [])).toEqual({ captured: [], inGraph: [] });
  });
  it("periodDeltas, bucketSpend, hasOverviewActivity", () => {
    const bs = [b({ captured: 3, in_graph: 1 }), b({ spend: { gates: 0.01, clustering: 0.02, chat: 0, other: 0 }, calls: 4 })];
    expect(periodDeltas(bs)).toEqual({ captured: 3, inGraph: 1 });
    expect(bucketSpend(bs[1])).toBeCloseTo(0.03);
    expect(hasOverviewActivity(bs)).toBe(true);
    expect(hasOverviewActivity([b(), b()])).toBe(false);
    expect(hasOverviewActivity([b({ captures: { desktop: 0, phone: 1 } })])).toBe(true);
    expect(hasOverviewActivity([b({ calls: 1 })])).toBe(true);
  });
  it("spend order and labels twin the backend", () => {
    expect(SPEND_ORDER).toEqual(["gates", "clustering", "chat", "other"]);
    expect(SPEND_LABELS.gates).toBe("Skip & learning gates");
  });
});
