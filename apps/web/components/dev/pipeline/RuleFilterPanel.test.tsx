import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import type { PipelineFlow, RuleFilterConfig } from "@/lib/types";
import RuleFilterPanel from "./RuleFilterPanel";
const config: RuleFilterConfig = {
  counts: { domains: 3, url_patterns: 2, path_rules: 4 }, lists_visible: true,
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
  expect(screen.getByText(/pages · 26\.7% of captured/)).toBeInTheDocument();
  expect(screen.getByText("Matched a fixed domain or URL rule before the LLM gate. Never sent to an LLM, by API or subscription, during processing, and never embedded or clustered unless you restore the page.")).toBeInTheDocument();
  expect(container.querySelector(".rule-filter-split")).toHaveTextContent("domain rules 1,920 · URL pattern rules 775");
  expect(screen.getByText("Rules: 3 domains · 2 URL patterns · 4 path rules")).toBeInTheDocument();
  expect(screen.getByText("a.example")).toBeInTheDocument();
  expect(screen.getByText("/login")).toBeInTheDocument();
  expect(screen.getByText("p4")).toBeInTheDocument();
  expect(screen.getByText("Stored on your server as an audit row. Not yet covered: DQ bot reads, chat page lookups by id, LangSmith tracing, and stored extension text.")).toBeInTheDocument();
});
it("non-admin: counts in the summary, lists replaced by a note", () => {
  const redacted: RuleFilterConfig = { counts: { domains: 120, url_patterns: 15, path_rules: 4 }, lists_visible: false, domains: [], domain_suffixes: [], url_patterns: [], path_rules: [] };
  const { container } = render(<RuleFilterPanel flow={flow(100, 10, 6, 4)} config={redacted} />);
  expect(screen.getByText("Rules: 120 domains · 15 URL patterns · 4 path rules")).toBeInTheDocument();
  expect(screen.getByText("Rule lists are visible to admins.")).toBeInTheDocument();
  expect(container.querySelector(".rule-filter-domains")).toBeNull();
  expect(container.querySelector(".rule-filter-paths")).toBeNull();
});
it("admin: the summary uses counts, not list lengths", () => {
  render(<RuleFilterPanel flow={flow(100, 10, 6, 4)} config={{ ...config, counts: { domains: 9, url_patterns: 8, path_rules: 7 } }} />);
  expect(screen.getByText("Rules: 9 domains · 8 URL patterns · 7 path rules")).toBeInTheDocument();
  expect(screen.queryByText("Rule lists are visible to admins.")).toBeNull();
});
it("empty flow reads 0 and a dash share", () => {
  const { container } = render(<RuleFilterPanel flow={{ total: 0, outcomes: [], details: [], fates: [] }} config={config} />);
  expect(container.querySelector(".rule-filter-number")).toHaveTextContent("0");
  expect(screen.getByText("pages · — of captured")).toBeInTheDocument();
});
