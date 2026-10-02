import { render, screen, waitFor, act } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import * as api from "@/lib/api";
import type { PipelineTimeline, TimelineBucket } from "@/lib/types";
import TimelineSection from "./TimelineSection";
vi.mock("@/lib/api");
const bk = (start: string, o: Partial<TimelineBucket> = {}): TimelineBucket => ({ start, label_key: "day", kept: 0, archived: 0, evaluated: 0, skipped: 0, categories: {}, ...o });
const tl = (buckets: TimelineBucket[], granularity: PipelineTimeline["granularity"] = "day"): PipelineTimeline => ({ range: "30d", granularity, buckets });
const labels = { login_wall: "Login Wall" };
it("renders three full-width chart cells, each with its own title", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([
    bk("2026-09-28T00:00:00-05:00", { kept: 3, archived: 1, evaluated: 4, skipped: 1, categories: { login_wall: 1 } }),
    bk("2026-09-29T00:00:00-05:00", { kept: 2, archived: 2, evaluated: 4, skipped: 2, categories: { login_wall: 2 } }),
  ]));
  const { container } = render(<TimelineSection range="30d" tz="America/Chicago" categoryLabels={labels} />);
  await screen.findByText("Archive over time");
  expect(api.fetchPipelineTimeline).toHaveBeenCalledWith("30d", "America/Chicago");
  const cells = container.querySelectorAll(".trends-grid > .trends-chart-cell");
  expect(cells).toHaveLength(3);
  expect(Array.from(cells).map((c) => c.querySelector(".dev-bars-title")?.textContent)).toEqual(["Archive over time", "Skip rate", "Skip category mix"]);
  cells.forEach((c) => expect(c.querySelector("svg")).toBeTruthy());
  expect(screen.getByText("Login Wall")).toBeInTheDocument(); // legend
});
it("refetches when the period changes", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([]));
  const { rerender } = render(<TimelineSection range="30d" tz="UTC" categoryLabels={{}} />);
  await waitFor(() => expect(api.fetchPipelineTimeline).toHaveBeenCalledWith("30d", "UTC"));
  rerender(<TimelineSection range="7d" tz="UTC" categoryLabels={{}} />);
  await waitFor(() => expect(api.fetchPipelineTimeline).toHaveBeenLastCalledWith("7d", "UTC"));
});
it("all-zero buckets show the empty copy in every cell", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([bk("2026-09-28T00:00:00Z"), bk("2026-09-29T00:00:00Z")]));
  const { container } = render(<TimelineSection range="7d" tz="UTC" categoryLabels={{}} />);
  await screen.findAllByText("No activity in this period.");
  expect(screen.getAllByText("No activity in this period.")).toHaveLength(2); // archive + skip rate
  expect(screen.getByText("No gate skips in this period.")).toBeInTheDocument();
  expect(container.textContent).not.toContain("NaN");
  expect(container.querySelectorAll(".trends-chart-cell")).toHaveLength(3);
});
it("6h buckets get day axis labels and block names in the tooltip title", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([0, 6, 12, 18].map((h) => bk(`2026-09-28T${String(h).padStart(2, "0")}:00:00-05:00`, { kept: 1 })).concat([bk("2026-09-29T00:00:00-05:00", { kept: 1 })]), "6h"));
  const { container } = render(<TimelineSection range="7d" tz="America/Chicago" categoryLabels={{}} />);
  await screen.findByText("Archive over time");
  expect(container.querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
  expect(Array.from(container.querySelectorAll("text.chart-xlabel")).every((t) => /^Sep \d\d$/.test(t.textContent ?? ""))).toBe(true);
});
it("shows an alert when the timeline fails, and Loading… beforehand", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockRejectedValue(new Error("boom"));
  render(<TimelineSection range="30d" tz="UTC" categoryLabels={{}} />);
  expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});
it("pages but nothing evaluated: skip rate says so, the other cells keep the activity copy rules", async () => {
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValue(tl([bk("2026-09-28T00:00:00Z", { kept: 2 }), bk("2026-09-29T00:00:00Z", { archived: 1 })]));
  render(<TimelineSection range="7d" tz="UTC" categoryLabels={{}} />);
  await screen.findByText("Nothing evaluated in this period.");
  expect(screen.queryByText("No activity in this period.")).toBeNull();
  expect(screen.getByText("No gate skips in this period.")).toBeInTheDocument();
});
it("is aria-busy and dimmed while a new period loads, and clears on arrival", async () => {
  let resolve!: (t: PipelineTimeline) => void;
  vi.mocked(api.fetchPipelineTimeline).mockResolvedValueOnce(tl([bk("2026-09-28T00:00:00Z", { kept: 1 })])).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { container, rerender } = render(<TimelineSection range="30d" tz="UTC" categoryLabels={{}} />);
  await screen.findByText("Skip rate");
  const grid = () => container.querySelector(".trends-grid")!;
  expect(grid().getAttribute("aria-busy")).not.toBe("true");
  rerender(<TimelineSection range="7d" tz="UTC" categoryLabels={{}} />);
  expect(grid().getAttribute("aria-busy")).toBe("true");
  expect(grid().classList.contains("is-refreshing")).toBe(true);
  await act(async () => { resolve(tl([bk("2026-09-28T00:00:00Z", { kept: 2 })])); });
  expect(grid().getAttribute("aria-busy")).not.toBe("true");
  expect(grid().classList.contains("is-refreshing")).toBe(false);
});
