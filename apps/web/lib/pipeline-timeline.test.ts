import { describe, it, expect } from "vitest";
import { axisLabels, bucketTitle, archiveBars, skipRateSeries, categoryMix, hasActivity } from "./pipeline-timeline";
import type { TimelineBucket } from "./types";

const b = (start: string, o: Partial<TimelineBucket> = {}): TimelineBucket =>
  ({ start, label_key: "x", kept: 0, archived: 0, evaluated: 0, skipped: 0, categories: {}, total: 0, outcomes: { before_gate: 0, rule_filter: 0, gate: 0, processed: 0, pending: 0 }, reached_gate: 0, ...o });

describe("bucket labels", () => {
  it("6h: tooltip names the block of the day, axis shows the day at the first block", () => {
    const bs = [b("2026-09-28T00:00:00-05:00"), b("2026-09-28T06:00:00-05:00"), b("2026-09-28T12:00:00-05:00"), b("2026-09-28T18:00:00-05:00"), b("2026-09-29T00:00:00-05:00")];
    expect(bs.map((x) => bucketTitle(x, "6h"))).toEqual(["Sep 28 · night", "Sep 28 · morning", "Sep 28 · afternoon", "Sep 28 · evening", "Sep 29 · night"]);
    expect(axisLabels(bs, "6h")).toEqual(["Sep 28", null, null, null, "Sep 29"]);
  });
  it("6h: a range starting mid-day still labels its first block", () => {
    expect(axisLabels([b("2026-09-28T12:00:00-05:00"), b("2026-09-28T18:00:00-05:00"), b("2026-09-29T00:00:00-05:00")], "6h")).toEqual(["Sep 28", null, "Sep 29"]);
  });
  it("6h uses the local wall clock in the offset, not UTC", () => {
    expect(bucketTitle(b("2026-11-01T18:00:00-05:00"), "6h")).toBe("Nov 01 · evening");
  });
  it("day, week and month labels", () => {
    expect(bucketTitle(b("2026-09-28T00:00:00-05:00"), "day")).toBe("Sep 28");
    expect(bucketTitle(b("2026-09-22T00:00:00-05:00"), "week")).toBe("wk of Sep 22");
    expect(bucketTitle(b("2026-09-01T00:00:00-05:00"), "month")).toBe("Sep 2026");
    expect(axisLabels([b("2026-09-22T00:00:00-05:00")], "week")).toEqual(["wk of Sep 22"]);
    expect(axisLabels([b("2026-09-01T00:00:00-05:00"), b("2026-10-01T00:00:00-05:00")], "month")).toEqual(["Sep 2026", "Oct 2026"]);
    expect(axisLabels([b("2026-09-28T00:00:00-05:00")], "day")).toEqual(["Sep 28"]);
  });
});

describe("series", () => {
  const bs = [
    b("2026-09-28T00:00:00Z", { kept: 3, archived: 1, evaluated: 4, skipped: 1, categories: { login_wall: 1 } }),
    b("2026-09-29T00:00:00Z"),
  ];
  it("archiveBars carries counts and a guarded rate", () => {
    const bars = archiveBars(bs);
    expect(bars[0]).toMatchObject({ kept: 3, archived: 1, rate: 25 });
    expect(bars[1]).toMatchObject({ kept: 0, archived: 0, rate: 0 });
  });
  it("skipRateSeries leaves buckets with nothing evaluated undefined, not 0%", () => {
    const s = skipRateSeries(bs);
    expect(s[0]).toMatchObject({ y: 25, skipped: 1, evaluated: 4 });
    expect(s[1].y).toBeNull();
  });
  it("categoryMix normalizes each bucket to 100 over its gate skips, labels from the map", () => {
    const mix = categoryMix([
      b("2026-09-28T00:00:00Z", { categories: { login_wall: 3, other: 1 } }),
      b("2026-09-29T00:00:00Z"),
    ], { login_wall: "Login Wall" });
    expect(mix.series.map((s) => s.name)).toEqual(["Login Wall", "Other"]);
    expect(mix.series[0].values).toEqual([75, 0]);
    expect(mix.series[0].counts).toEqual([3, 0]);
    expect(mix.series[1].values).toEqual([25, 0]);
  });
  it("hasActivity is false for all-zero buckets and empty lists", () => {
    expect(hasActivity([])).toBe(false);
    expect(hasActivity([b("2026-09-28T00:00:00Z")])).toBe(false);
    expect(hasActivity(bs)).toBe(true);
  });
});

import { VOLUME_ORDER, hasFlowActivity, rateSeries, rateDomain, mixSeries, gateNotLiveRun } from "./pipeline-timeline";

const fb = (o: Partial<Record<"before_gate" | "rule_filter" | "gate" | "processed" | "pending", number>>, extra: Partial<TimelineBucket> = {}): TimelineBucket => {
  const outcomes = { before_gate: 0, rule_filter: 0, gate: 0, processed: 0, pending: 0, ...o };
  const total = Object.values(outcomes).reduce((a, n) => a + n, 0);
  return b("2026-09-28T00:00:00-05:00", { outcomes, total, reached_gate: outcomes.gate + outcomes.processed, ...extra });
};

describe("flow timeline helpers", () => {
  it("VOLUME_ORDER stacks bottom to top", () => {
    expect(VOLUME_ORDER).toEqual(["processed", "gate", "rule_filter", "before_gate", "pending"]);
  });
  it("hasFlowActivity reads totals", () => {
    expect(hasFlowActivity([fb({}), fb({})])).toBe(false);
    expect(hasFlowActivity([fb({}), fb({ processed: 1 })])).toBe(true);
  });
  it("rateSeries: null on a zero denominator, 1 decimal otherwise", () => {
    const s = rateSeries([fb({}), fb({ before_gate: 1, gate: 1, processed: 1 }), fb({ before_gate: 2 })]);
    expect(s.archive).toEqual([{ y: null, n: 0, d: 0 }, { y: 66.7, n: 2, d: 3 }, { y: 100, n: 2, d: 2 }]);
    expect(s.gate).toEqual([{ y: null, n: 0, d: 0 }, { y: 50, n: 1, d: 2 }, { y: null, n: 0, d: 0 }]);
  });
  it("rateDomain floors to 20 and never exceeds a 60 floor", () => {
    const p = (y: number | null) => ({ y, n: 0, d: 0 });
    expect(rateDomain({ archive: [p(95), p(null)], gate: [p(88)] })).toEqual([60, 100]);
    expect(rateDomain({ archive: [p(47.2)], gate: [p(80)] })).toEqual([40, 100]);
    expect(rateDomain({ archive: [p(5)], gate: [] })).toEqual([0, 100]);
    expect(rateDomain({ archive: [p(null)], gate: [] })).toEqual([60, 100]);
  });
  it("mixSeries follows the given order, appends unknown ids, and computes shares", () => {
    const bs = [fb({}, { categories: { b: 1, zz: 1, a: 2 } }), fb({}, { categories: {} })];
    const s = mixSeries(bs, ["a", "b", "c"], { a: "Alpha", b: "Beta" });
    expect(s.map((x) => x.id)).toEqual(["a", "b", "zz"]);
    expect(s.map((x) => x.name)).toEqual(["Alpha", "Beta", "Zz"]);
    expect(s[0].counts).toEqual([2, 0]);
    expect(s[0].values).toEqual([50, 0]);
  });
  it("gateNotLiveRun: no-activity leading buckets -> 0", () => {
    expect(gateNotLiveRun([fb({}), fb({}), fb({ gate: 1 })])).toBe(0);
  });
  it("gateNotLiveRun: gate never live -> 0", () => {
    expect(gateNotLiveRun([fb({ before_gate: 1 }), fb({ before_gate: 2 })])).toBe(0);
  });
  it("gateNotLiveRun: active captures, gate live later -> run length", () => {
    expect(gateNotLiveRun([fb({ before_gate: 1 }), fb({}), fb({ rule_filter: 1 }), fb({ gate: 1 })])).toBe(3);
    expect(gateNotLiveRun([fb({ gate: 1 }), fb({})])).toBe(0);
  });
});
