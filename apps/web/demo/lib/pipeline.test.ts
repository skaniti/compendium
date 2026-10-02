import { describe, expect, it } from "vitest";
import { computeSummary } from "./pipeline.mjs";

const skip = { model: "m", categories: [], tools: [] };
const summaryFor = (rule_filter_config: unknown) => computeSummary([], "all", Date.UTC(2026, 0, 1), { rule_filter_config, skip_gate_config: skip });

describe("computeSummary rule_filter_config redaction", () => {
  it("keeps recorded counts when the capture is already redacted", () => {
    const cfg = summaryFor({ counts: { domains: 120, url_patterns: 15, path_rules: 4 }, lists_visible: false, domains: [], domain_suffixes: [], url_patterns: [], path_rules: [] }).rule_filter_config;
    expect(cfg.counts).toEqual({ domains: 120, url_patterns: 15, path_rules: 4 });
    expect(cfg.lists_visible).toBe(false);
  });
  it("computes counts from legacy lists-only captures and empties the lists", () => {
    const cfg = summaryFor({ domains: ["a.example", "b.example"], domain_suffixes: [".c.example"], url_patterns: [{ domain: "x.example", path: "/p" }], path_rules: ["r1", "r2", "r3", "r4"] }).rule_filter_config;
    expect(cfg.counts).toEqual({ domains: 3, url_patterns: 1, path_rules: 4 });
    expect(cfg.lists_visible).toBe(false);
    for (const k of ["domains", "domain_suffixes", "url_patterns", "path_rules"]) expect(cfg[k]).toEqual([]);
  });
});
