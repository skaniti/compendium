import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import type { PipelineFlow, RuleFilterConfig } from "@/lib/types";
import RuleFilterPanel from "./RuleFilterPanel";
const config: RuleFilterConfig = {
  domains: ["a.example", "b.example", "c.example"], domain_suffixes: [],
  url_patterns: [{ domain: "x.example", path: "/login" }, { domain: "y.example", path: "/auth" }],
  path_rules: ["p1", "p2", "p3", "p4"],
};
const flow = (total: number, ruleCount: number, d: number, u: number): PipelineFlow => ({
  total,
  outcomes: [{ key: "rule_filter", label: "Rule filter · no LLM", count: ruleCount, top_domains: [] }],
  details: [
    { outcome: "rule_filter", key: "domain", label: "Domain rule", count: d, top_domains: [], fates: { archived: d, active: 0, pending: 0 } },
    { outcome: "rule_filter", key: "url_pattern", label: "URL pattern rule", count: u, top_domains: [], fates: { archived: u, active: 0, pending: 0 } },
  ],
  fates: [],
});
it("shows count, share, verbatim claim, split line, rules and footnote", () => {
  const { container } = render(<RuleFilterPanel flow={flow(10094, 2695, 1920, 775)} config={config} />);
  expect(container.querySelector("section.dev-panel.rule-filter-panel")).toBeTruthy();
  expect(screen.getByText("Rule filter · no LLM")).toBeInTheDocument();
  expect(screen.getByText("2,695")).toBeInTheDocument();
  expect(screen.getByText(/26\.7% of captured/)).toBeInTheDocument();
  expect(screen.getByText("Matched a fixed domain or URL rule before the LLM gate. Never sent to an LLM, by API or subscription, during processing, and never embedded or clustered.")).toBeInTheDocument();
  expect(screen.getByText("domain rules 1,920 · URL pattern rules 775")).toBeInTheDocument();
  expect(screen.getByText("Rules: 3 domains · 2 URL patterns · 4 path rules")).toBeInTheDocument();
  expect(screen.getByText("a.example")).toBeInTheDocument();
  expect(screen.getByText("/login")).toBeInTheDocument();
  expect(screen.getByText("p4")).toBeInTheDocument();
  expect(screen.getByText("Stored on your server as an audit row. Not yet covered: DQ bot reads and LangSmith tracing.")).toBeInTheDocument();
});
it("empty flow reads 0 and 0.0%", () => {
  render(<RuleFilterPanel flow={{ total: 0, outcomes: [], details: [], fates: [] }} config={config} />);
  expect(screen.getByText("0")).toBeInTheDocument();
  expect(screen.getByText(/0\.0% of captured/)).toBeInTheDocument();
});
