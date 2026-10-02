import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import type { PipelineSummary } from "@/lib/types";
import TimeWindowProvider from "@/components/TimeWindowProvider";
import PipelineView, { PIPELINE_SUBTITLE } from "./PipelineView";
vi.mock("@/lib/api");
const cfg = { model: "m", temperature: 0, prompt_name: "p1", prompt: "x", tools: [], categories: [{ id: "login_wall", label: "Login Wall", description: "Needs sign-in" }] };
const summary = (o: Partial<PipelineSummary> = {}): PipelineSummary => ({
  range: "30d", status_counts: { active: 1271, pending: 2, archived: 40 }, total_pages: 1313, archive_ratio: 0.031,
  decisions: [{ key: "skipped", label: "Skipped", count: 30, evaluated: true }],
  archive_reasons: [{ key: "skip_gate", label: "Skip Gate", count: 30, top_domains: [{ domain: "a.example", count: 12 }] }, { key: "dedup", label: "Dedup", count: 10, top_domains: [] }],
  skip_categories: [{ key: "login_wall", label: "Login Wall", count: 20, top_domains: [{ domain: "b.example", count: 7 }] }, { key: "uncategorized", label: "Uncategorized", count: 10, top_domains: [] }],
  skip_gate_config: cfg, ...o,
});
const row = { id: 1, title: "Row page", domain: "example.org", status: "active", processing_depth: null, archive_reason: null, skip_reasoning: null, skip_category: null, visited_at: null, created_at: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue({ range: "30d", granularity: "day", buckets: [] });
  vi.mocked(api.fetchPipelinePages).mockResolvedValue({ rows: [row], total: 1, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
});
const mount = (tw: "7" | "30" | "all" = "30") => render(<TimeWindowProvider initialWindow={tw}><PipelineView /></TimeWindowProvider>);
it("loads, then shows four status cards (ratio xx.x%), the subtitle, reason lists with domains", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  mount();
  expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(3); // summary, timeline, table
  expect(await screen.findByText("1,271")).toBeInTheDocument();
  expect(screen.getByText("3.1%")).toBeInTheDocument();
  expect(screen.getByText(PIPELINE_SUBTITLE)).toBeInTheDocument();
  expect(screen.getByText("top: a.example (12)")).toBeInTheDocument();
  expect(screen.getByText("top: b.example (7)")).toBeInTheDocument();
  expect(screen.getByText("20").parentElement).toHaveTextContent("20 67%"); // of 30 gate-archived pages
  expect(screen.getByText("Skip Gate").closest(".dev-bar-row")).toHaveTextContent("30 75%"); // of 40 archived
});
it("section order follows the spec", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  const { container } = mount();
  await screen.findByText("1,271");
  await screen.findByText("Row page");
  const titles = Array.from(container.querySelectorAll(".dev-section-title, .dev-bars-title, .dev-config-panel > summary")).map((e) => e.textContent);
  const order = ["Skip gate config", "Page decisions", "Archive reasons", "Skip gate categories", "Archive over time", "Skip rate", "Skip category mix", "All pages"];
  const idx = order.map((t) => titles.indexOf(t));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
});
it("pills are sticky with the header and every section refetches on period change", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary());
  const { container } = mount();
  await screen.findByText("1,271");
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
  expect(await screen.findByText("Archive over time")).toBeInTheDocument();
});
it("a zero-page period renders every empty state with 0 / 0.0%, never NaN", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary({ status_counts: { active: 0, pending: 0, archived: 0 }, total_pages: 0, archive_ratio: 0, decisions: [], archive_reasons: [], skip_categories: [] }));
  vi.mocked(api.fetchPipelinePages).mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
  const { container } = mount();
  expect(await screen.findByText("0.0%")).toBeInTheDocument();
  await screen.findAllByText("No activity in this period.");
  expect(screen.getAllByText("No pages in this period.").length).toBeGreaterThanOrEqual(3); // decisions, reasons, table
  expect(screen.getAllByText("No gate skips in this period.").length).toBeGreaterThanOrEqual(2); // categories list + mix
  expect(container.textContent).not.toContain("NaN");
  expect(within(container).queryByText("Loading…")).toBeNull();
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
  await screen.findByText("1,271");
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
