import { render, screen, fireEvent } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import * as api from "@/lib/api";
import type { PipelineTimeline, TimelineBucket } from "@/lib/types";
import FlowTimeline from "./FlowTimeline";
vi.mock("@/lib/api");
const bk = (start: string, o: Partial<TimelineBucket> = {}): TimelineBucket => ({ start, label_key: "day", archived: 0, categories: {}, total: 0, outcomes: { before_gate: 0, rule_filter: 0, gate: 0, processed: 0, pending: 0 }, reached_gate: 0, ...o });
const tl = (buckets: TimelineBucket[]): PipelineTimeline => ({ range: "30d", granularity: "day", buckets });
const live = (d: number, o: Partial<TimelineBucket> = {}) => bk(`2026-09-${String(d).padStart(2, "0")}T00:00:00Z`, {
  total: 10, archived: 8, reached_gate: 5, outcomes: { before_gate: 2, rule_filter: 1, gate: 4, processed: 3, pending: 0 }, categories: { login: 3, store: 1 }, ...o });
const props = { range: "30d" as const, tz: "UTC", order: ["login", "store"], labels: { login: "Login Wall", store: "Store" }, catColors: { login: "var(--a)", store: "var(--b)" } };

it("renders three labelled panels, two rate lines and the shared x axis once", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([live(1), live(2), live(3)]));
  const { container } = render(<FlowTimeline {...props} />);
  await screen.findByText("Volume");
  expect(api.fetchPipelineTimeline).toHaveBeenCalledWith("30d", "UTC");
  for (const t of ["captured, by outcome", "colours = flow above", "Rates", "archive rate", "skip rate (gate)", "Skip mix", "share of gate skips"]) expect(screen.getByText(t)).toBeInTheDocument();
  expect(container.querySelectorAll(".flow-tl-row")).toHaveLength(3);
  expect(container.querySelectorAll("path.flow-rate-line")).toHaveLength(2);
  expect(container.querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
  expect(container.querySelectorAll(".flow-tl-row:not(:last-child) text.chart-xlabel")).toHaveLength(0);
});
it("volume hover lists non-zero outcomes and the total", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([live(1), live(2)]));
  const { container } = render(<FlowTimeline {...props} />);
  await screen.findByText("Volume");
  fireEvent.mouseMove(container.querySelectorAll("rect.flow-tl-hit-volume")[0]);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines).toEqual(["Sep 01", "Processed · kept  3", "Skipped by LLM gate  4", "Rule filter · no LLM  1", "Archived before gate  2", "total 10"]);
});
it("rates hover shows both rates with n/d", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([live(1), live(2)]));
  const { container } = render(<FlowTimeline {...props} />);
  await screen.findByText("Volume");
  fireEvent.mouseMove(container.querySelectorAll("rect.flow-tl-hit-rates")[0]);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines).toEqual(["Sep 01", "archive rate: 80.0% (8/10)", "skip rate (gate): 80.0% (4/5)"]);
});
it("marks a leading run with no gate decisions as gate not live", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([live(1, { reached_gate: 0, categories: {}, outcomes: { before_gate: 5, rule_filter: 5, gate: 0, processed: 0, pending: 0 } }), live(2), live(3)]));
  render(<FlowTimeline {...props} />);
  expect(await screen.findByText("gate not live")).toBeInTheDocument();
});
it("shows the empty copy and no NaN for an inactive period", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([bk("2026-09-01T00:00:00Z"), bk("2026-09-02T00:00:00Z")]));
  const { container } = render(<FlowTimeline {...props} />);
  expect(await screen.findByText("No activity in this period.")).toBeInTheDocument();
  expect(container.innerHTML).not.toContain("NaN");
});
it("shows the no-skips copy inside the mix panel", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([live(1, { categories: {} }), live(2, { categories: {} })]));
  const { container } = render(<FlowTimeline {...props} />);
  expect(await screen.findByText("No gate skips in this period.")).toBeInTheDocument();
  expect(container.innerHTML).not.toContain("NaN");
});
it("shows Loading… first and an alert on failure", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockRejectedValue(new Error("boom"));
  render(<FlowTimeline {...props} />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});
