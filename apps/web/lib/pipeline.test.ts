import { describe, it, expect } from "vitest";
import { deriveSkipColumns, formatVisited, percentOf, formatRatio, browserTimeZone, rangeKeyFor } from "./pipeline";
import type { PipelinePage } from "./types";

const base: PipelinePage = { id: 1, title: "T", domain: "example.org", status: "active", processing_depth: "processed",
  archive_reason: null, skip_reasoning: null, skip_category: null, visited_at: null, created_at: null };

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
  it("percentOf guards zero totals", () => {
    expect(percentOf(3, 0)).toBe(0);
    expect(percentOf(1, 4)).toBe(25);
  });
  it("formatRatio renders the backend fraction as xx.x% and never NaN", () => {
    expect(formatRatio(0)).toBe("0.0%");
    expect(formatRatio(0.8394)).toBe("83.9%");
    expect(formatRatio(1)).toBe("100.0%");
    expect(formatRatio(Number.NaN)).toBe("0.0%");
    expect(formatRatio(undefined)).toBe("0.0%");
  });
  it("browserTimeZone returns a non-empty IANA-looking name", () => {
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});

describe("rangeKeyFor", () => {
  it("maps the shared TimeWindow onto the pipeline API range key", () => {
    expect(rangeKeyFor("7")).toBe("7d");
    expect(rangeKeyFor("30")).toBe("30d");
    expect(rangeKeyFor("90")).toBe("90d");
    expect(rangeKeyFor("all")).toBe("all");
    expect(rangeKeyFor("365")).toBe("all");
  });
});
