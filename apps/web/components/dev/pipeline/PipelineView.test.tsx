import { render, screen } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import type { PipelineSummary } from "@/lib/types";
import PipelineView, { PIPELINE_SUBTITLE } from "./PipelineView";
vi.mock("@/lib/api");
const summary = (total: number): PipelineSummary => ({
  status_counts: { active: 1271, pending: 2, archived: 30 }, total_pages: total,
  decisions: [], skip_methods: [], skip_gate_reasons: [],
  skip_gate_config: { model: "m", temperature: 0, prompt_name: "p1", prompt: "x", tools: [] },
});
beforeEach(() => {
  vi.mocked(api.fetchArchiveHealth).mockResolvedValue({ active_count: 5, archived_count: 7, by_reason: [], per_capture: [] });
  vi.mocked(api.fetchSkipTrends).mockResolvedValue({ range: "30d", skip_rate: [], skip_reasons: [] });
  vi.mocked(api.fetchPipelinePages).mockResolvedValue({ rows: [{ id: 1, title: "Row page", domain: "example.org", status: "active", processing_depth: null, archive_reason: null, skip_reasoning: null, visited_at: null, created_at: null }], total: 1, limit: 50, offset: 0, sort: "created_at", dir: "desc" });
});
it("shows loading, then formatted status cards and the subtitle", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary(1303));
  render(<PipelineView />);
  expect(screen.getAllByText("Loading…")).toHaveLength(4); // summary + table + archive health + skip trends
  expect(await screen.findByText("1,271")).toBeInTheDocument();
  expect(screen.getByText(PIPELINE_SUBTITLE)).toBeInTheDocument();
});
it("renders an alert when the summary fails", async () => {
  vi.mocked(api.fetchPipelineSummary).mockRejectedValue(new Error("boom"));
  render(<PipelineView />);
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});
it("shows No pages found. when total_pages is 0", async () => {
  vi.mocked(api.fetchPipelineSummary).mockResolvedValue(summary(0));
  render(<PipelineView />);
  expect(await screen.findByText("No pages found.")).toBeInTheDocument();
  await screen.findByText("Row page"); // table has a row, so the empty copy is the summary branch
  expect(screen.getAllByText("No pages found.")).toHaveLength(1); // not DecisionBars' empty caption
  expect(screen.queryByText("Page status")).not.toBeInTheDocument();
});
it("mounts the windowed sections even when the summary fails", async () => {
  vi.mocked(api.fetchPipelineSummary).mockRejectedValue(new Error("boom"));
  render(<PipelineView />);
  expect(await screen.findByText("Archive health")).toBeInTheDocument();
  expect(await screen.findByText("Skip trends")).toBeInTheDocument();
  expect(await screen.findByText("No skipped pages in this window.")).toBeInTheDocument();
});
