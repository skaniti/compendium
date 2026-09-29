import { describe, it, expect } from "vitest";
import { deriveSkipColumns, formatVisited, percentOf, archiveRatio, skipRatePoints, skipReasonMix } from "./pipeline";
import type { PipelinePage } from "./types";

const base: PipelinePage = { id: 1, title: "T", domain: "example.org", status: "active", processing_depth: "processed",
  archive_reason: null, skip_reasoning: null, visited_at: null, created_at: null };

describe("deriveSkipColumns (Dash pipeline_monitor.py:338-370)", () => {
  it("domain_skip -> domain / domain filter", () => {
    expect(deriveSkipColumns({ ...base, archive_reason: "domain_skip", skip_reasoning: "x" })).toEqual({ skip: "domain", skipReason: "domain filter" });
  });
  it("gate reasons collapse to gate and truncate to 80 chars", () => {
    const long = "a".repeat(100);
    for (const r of ["skip_gate", "manual_exclusion", "trivial_capture"]) {
      const out = deriveSkipColumns({ ...base, archive_reason: r, skip_reasoning: long });
      expect(out.skip).toBe("gate");
      expect(out.skipReason).toHaveLength(80);
    }
  });
  it("other reasons and nulls show em dashes", () => {
    expect(deriveSkipColumns({ ...base, archive_reason: "dedup" })).toEqual({ skip: "—", skipReason: "—" });
    expect(deriveSkipColumns({ ...base })).toEqual({ skip: "—", skipReason: "—" });
  });
});

describe("formatVisited", () => {
  it("null -> em dash; ISO -> 'Mon DD, HH:MM:SS' in local time", () => {
    expect(formatVisited(null)).toBe("—");
    expect(formatVisited("2026-08-13T23:17:14+00:00")).toMatch(/^[A-Z][a-z]{2} \d{2}, \d{2}:\d{2}:\d{2}$/);
  });
});

describe("numbers", () => {
  it("percentOf and archiveRatio guard zero totals", () => {
    expect(percentOf(3, 0)).toBe(0);
    expect(percentOf(1, 4)).toBe(25);
    expect(archiveRatio(0, 0)).toBe("0.0%");
    expect(archiveRatio(224, 1164)).toBe("83.9%");
  });
});

describe("skipRatePoints (trends.py:268-341)", () => {
  it("computes rounded percentages and guards total 0", () => {
    const pts = skipRatePoints([{ day: "2026-08-01", total: 3, skipped: 1 }, { day: "2026-08-02", total: 0, skipped: 0 }]);
    expect(pts.map((p) => p.rate)).toEqual([33.3, 0]);
    expect(pts[0].day).toBeInstanceOf(Date);
  });
});

describe("skipReasonMix (trends.py:344-424)", () => {
  it("normalizes each day to 100 over the returned reasons, alphabetical series", () => {
    const mix = skipReasonMix([
      { day: "2026-08-01", reason: "login wall", cnt: 3 },
      { day: "2026-08-01", reason: "content-free stub", cnt: 1 },
      { day: "2026-08-02", reason: "login wall", cnt: 2 },
    ]);
    expect(mix.days).toEqual(["2026-08-01", "2026-08-02"]);
    expect(mix.series.map((s) => s.name)).toEqual(["content-free stub", "login wall"]);
    expect(mix.series[1].values).toEqual([75, 100]);
    expect(mix.series[0].values).toEqual([25, 0]);
  });
  it("empty input -> empty days/series", () => {
    expect(skipReasonMix([])).toEqual({ days: [], series: [] });
  });
});
