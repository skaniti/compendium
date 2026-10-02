import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import type { PipelineSummary } from "@/lib/types";
import TimeWindowProvider from "@/components/TimeWindowProvider";
import PipelineView, { PIPELINE_SUBTITLE } from "./PipelineView";
vi.mock("@/lib/api");
const cfg = { model: "m", temperature: 0, prompt_name: "p1", prompt: "x", tools: [], categories: [{ id: "login_wall", label: "Login Wall", description: "Needs sign-in" }] };
const flow = {
  total: 1313,
  outcomes: [
    { key: "before_gate" as const, label: "Archived before gate", count: 10, top_domains: [] },
    { key: "rule_filter" as const, label: "Rule filter · no LLM", count: 20, top_domains: [] },
    { key: "gate" as const, label: "Skipped by LLM gate", count: 30, top_domains: [] },
    { key: "processed" as const, label: "Processed · kept", count: 1251, top_domains: [] },
    { key: "pending" as const, label: "Pending", count: 2, top_domains: [] },
  ],
  details: [
    { outcome: "gate" as const, key: "login_wall", label: "Login Wall", count: 20, top_domains: [], fates: { archived: 20, active: 0, pending: 0 } },
    { outcome: "gate" as const, key: "paywall", label: "Paywall", count: 7, top_domains: [], fates: { archived: 7, active: 0, pending: 0 } },
    { outcome: "gate" as const, key: "uncategorized", label: "Uncategorized", count: 3, top_domains: [], fates: { archived: 3, active: 0, pending: 0 } },
  ],
  fates: [{ key: "archived" as const, label: "Archived", count: 40 }, { key: "active" as const, label: "Active", count: 1271 }, { key: "pending" as const, label: "Pending", count: 2 }],
};
const summary = (o: Partial<PipelineSummary> = {}): PipelineSummary => ({
  range: "30d", status_counts: { active: 1271, pending: 2, archived: 40 }, total_pages: 1313, archive_ratio: 0.031,
  skip_gate_config: cfg, flow, rule_filter_config: { domains: [], domain_suffixes: [], url_patterns: [], path_rules: [] }, ...o,
});
const row = { id: 1, title: "Row page", domain: "example.org", status: "active", processing_depth: null, archive_reason: null, skip_reasoning: null, skip_category: null, visited_at: null, created_at: null, outcome: "processed" as const, detail: "active", detail_label: "Active", fate: "active" as const };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue({ range: "30d", granularity: "day", buckets: [] });
  vi.mocked(api.fetchPipelinePages).mockResolvedValue({ rows: [row], total: 1, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
});
const loaded = () => waitFor(() => expect(document.querySelector(".chart-legend-flow")).toBeTruthy());
const mount = (tw: "7" | "30" | "all" = "30") => render(<TimeWindowProvider initialWindow={tw}><PipelineView /></TimeWindowProvider>);
it("loads, then shows the subtitle and a legend entry per category with counts", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  mount();
  expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(2); // summary, table
  await loaded();
  expect(screen.getByText(PIPELINE_SUBTITLE)).toBeInTheDocument();
  const legend = document.querySelector(".chart-legend-flow") as HTMLElement;
  for (const [name, n] of [["Login Wall", "20"], ["Paywall", "7"], ["Uncategorized", "3"]]) {
    const li = within(legend).getByText(name).closest("li") as HTMLElement;
    expect(li).toHaveTextContent(n);
  }
  expect(within(legend).getAllByRole("listitem")).toHaveLength(3);
});
it("section order: flow panel, filters row, pages; no old lists", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  const { container } = mount();
  await loaded();
  await screen.findByText("Row page");
  const panel = container.querySelector("section.dev-panel.pipeline-flow-panel") as HTMLElement;
  const filters = container.querySelector("div.pipeline-filters-row") as HTMLElement;
  const pages = screen.getByText("All pages").closest("section, div") as HTMLElement;
  expect(panel).toBeTruthy();
  expect(filters).toBeTruthy();
  expect(filters).toHaveTextContent("Skip gate · LLM");
  const follows = (x: Node, y: Node) => Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(panel, filters)).toBe(true);
  expect(follows(filters, pages)).toBe(true);
  expect(panel.querySelector(".chart-legend-flow")).toBeTruthy();
  for (const t of ["Page decisions", "Archive reasons", "Skip gate categories", "Archive over time", "Skip category mix"]) expect(container.textContent).not.toContain(t);
});
it("a summary without flow shows the stale-API message in the flow panel", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary({ flow: undefined, rule_filter_config: undefined }));
  const { container } = mount();
  const msg = await screen.findByText("The API is older than this view; restart it to load the flow.");
  expect(msg).toHaveAttribute("role", "alert");
  expect(container.querySelector(".pipeline-flow-panel")).toContainElement(msg);
  expect(await screen.findByText("Row page")).toBeInTheDocument();
});
it("pills are sticky with the header and every section refetches on period change", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  const { container } = mount();
  await loaded();
  expect(container.querySelector(".trends-sticky-header .trends-range-bar")).toBeTruthy();
  expect(api.fetchPipelineSummary).toHaveBeenCalledWith("30d", expect.any(String));
  expect(api.fetchPipelineTimeline).toHaveBeenCalledWith("30d", expect.any(String));
  expect(api.fetchPipelinePages).toHaveBeenCalledWith(50, 0, "created_at", "desc", "30d", expect.any(String));
  await userEvent.click(screen.getByRole("button", { name: "All time" }));
  await waitFor(() => expect(api.fetchPipelineSummary).toHaveBeenLastCalledWith("all", expect.any(String)));
  await waitFor(() => expect(api.fetchPipelineTimeline).toHaveBeenLastCalledWith("all", expect.any(String)));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "created_at", "desc", "all", expect.any(String)));
});
it("a failing summary alerts but the timeline and table still load", async () => {
  vi.mocked(api.fetchPipelineSummary).mockRejectedValue(new Error("boom"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  expect(await screen.findByText("Row page")).toBeInTheDocument();
});
it("a zero-page period renders empty states, never NaN", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary({ status_counts: { active: 0, pending: 0, archived: 0 }, total_pages: 0, archive_ratio: 0, flow: { total: 0, outcomes: flow.outcomes.map((o) => ({ ...o, count: 0 })), details: [], fates: flow.fates.map((f) => ({ ...f, count: 0 })) } }));
  vi.mocked(api.fetchPipelinePages).mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
  const { container } = mount();
  await screen.findAllByText("No pages in this period.");
  expect(container.textContent).not.toContain("NaN");
  await waitFor(() => expect(within(container).queryByText("Loading…")).toBeNull());
});
it("the initial pill state reflects the provider's initialWindow", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  mount("7");
  expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "All time" })).toHaveAttribute("aria-pressed", "false");
  await waitFor(() => expect(api.fetchPipelineSummary).toHaveBeenCalledWith("7d", expect.any(String)));
});
it("a pill click marks the sections aria-busy until the new responses resolve", async () => {
  let resolveSummary!: (s: PipelineSummary) => void;
  vi.mocked(api.fetchPipelineSummary).mockResolvedValueOnce(summary()).mockReturnValueOnce(new Promise((r) => { resolveSummary = r; }));
  const { container } = mount();
  await loaded();
  await screen.findByText("Row page");
  const busy = () => container.querySelectorAll('[aria-busy="true"]').length;
  expect(busy()).toBe(0);
  await userEvent.click(screen.getByRole("button", { name: "All time" }));
  await waitFor(() => expect(busy()).toBeGreaterThan(0));
  expect(container.querySelector('[data-section="summary"]')).toHaveAttribute("aria-busy", "true");
  resolveSummary(summary({ range: "all" }));
  await waitFor(() => expect(container.querySelector('[data-section="summary"]')).toHaveAttribute("aria-busy", "false"));
  await waitFor(() => expect(busy()).toBe(0));
});
