import { describe, it, expect } from "vitest";
import { formatVisited, percentOf, formatRatio, browserTimeZone, rangeKeyFor } from "./pipeline";
import type { PipelinePage } from "./types";

const base: PipelinePage = { id: 1, title: "T", domain: "example.org", status: "active", processing_depth: "processed",
  archive_reason: null, skip_reasoning: null, skip_category: null, visited_at: null, created_at: null,
  outcome: "processed", detail: "active", detail_label: "Active", fate: "active" };

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

import { flowColumns, OUTCOME_COLOR, DASH } from "./pipeline";
import type { FateKey, FlowOutcomeKey } from "./types";

describe("flowColumns", () => {
  const outcomes: FlowOutcomeKey[] = ["before_gate", "rule_filter", "gate", "processed", "pending"];
  const fateKeys: FateKey[] = ["archived", "active", "pending"];
  const decision = { before_gate: DASH, rule_filter: "skip", gate: "skip", processed: "keep", pending: DASH };
  const skip = { before_gate: "pre-gate", rule_filter: "rule", gate: "LLM gate", processed: DASH, pending: DASH };
  for (const outcome of outcomes) for (const fate of fateKeys) {
    it(`${outcome} x ${fate}`, () => {
      const r = flowColumns({ ...base, outcome, fate, detail_label: "Label", skip_reasoning: null });
      expect(r.decision).toBe(decision[outcome]);
      expect(r.skip).toBe(skip[outcome]);
      expect(r.skipReason).toBe(fate === "active" ? DASH : "Label");
      expect(r.skipReasonTitle).toBeUndefined();
    });
  }
  it("carries the gate free text as the title", () => {
    expect(flowColumns({ ...base, outcome: "gate", fate: "archived", detail_label: "Login wall", skip_reasoning: "needs sign-in" }).skipReasonTitle).toBe("needs sign-in");
  });
  it("OUTCOME_COLOR references the --flow variables", () => {
    expect(OUTCOME_COLOR.processed).toBe("var(--flow-processed)");
    expect(Object.values(OUTCOME_COLOR).every((v) => /^var\(--flow-[a-z]+\)$/.test(v))).toBe(true);
  });
});
