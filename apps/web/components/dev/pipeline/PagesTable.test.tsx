import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect } from "vitest";
import * as api from "@/lib/api";
import type { PageSortColumn, PipelinePagesResponse, SortDir } from "@/lib/types";
import PagesTable from "./PagesTable";
vi.mock("@/lib/api");
const row = (id: number) => ({ id, title: `Page ${id}`, domain: "example.org", status: "archived", processing_depth: "skipped",
  archive_reason: "skip_gate", skip_reasoning: "login wall", skip_category: null, visited_at: "2026-08-13T23:17:14+00:00", created_at: null });
const resp = (rows: ReturnType<typeof row>[], total: number, offset = 0, sort: PageSortColumn = "created_at", dir: SortDir = "desc"): PipelinePagesResponse =>
  ({ rows, total, limit: 50, offset, sort, dir });
it("renders rows, derived skip columns, and pages through", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValueOnce(resp([row(1), row(2)], 120)).mockResolvedValueOnce(resp([row(51)], 120, 50));
  render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  expect(screen.getAllByText("gate")).toHaveLength(2);
  expect(screen.getByText("page 1 of 3")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 51");
  expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 50, "created_at", "desc", "30d", "UTC");
});
it("clicking a header sorts by that column, toggles direction, and resets to page 1", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "asc", "30d", "UTC"));
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "desc", "30d", "UTC"));
  expect(screen.getByRole("columnheader", { name: /^Domain/ })).toHaveAttribute("aria-sort", "descending");
});
it("Newest first resets to the default order and disables itself there", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  const reset = screen.getByRole("button", { name: "Newest first" });
  expect(reset).toBeDisabled();
  expect(screen.getByRole("columnheader", { name: /^Domain/ })).toHaveAttribute("aria-sort", "none");
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "asc", "30d", "UTC"));
  expect(reset).toBeEnabled();
  await userEvent.click(reset);
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "created_at", "desc", "30d", "UTC"));
  expect(screen.getByRole("button", { name: "Newest first" })).toBeDisabled();
});
it("empty -> No pages found.", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([], 0));
  render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("No pages in this period.");
});
it("pins column widths with a 7-col colgroup and renders SVG sort icons", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  const { container } = render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  expect(container.querySelector("table.dev-table")).toHaveClass("dev-table-fixed");
  expect(container.querySelectorAll("table.dev-table colgroup col")).toHaveLength(7);
  const btn = screen.getByRole("button", { name: /^Domain/ });
  expect(btn.querySelector("svg.sort-icon")).toBeTruthy();
  expect(btn.textContent).toBe("Domain");
  expect(container.querySelectorAll("svg.sort-icon[data-state='none']")).toHaveLength(5);
  await userEvent.click(btn);
  await waitFor(() => expect(container.querySelector("svg.sort-icon[data-state='asc']")).toBeTruthy());
});
it("resets to page 1 and refetches when the period changes", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  const { rerender } = render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 50, "created_at", "desc", "30d", "UTC"));
  rerender(<PagesTable range="all" tz="UTC" />);
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "created_at", "desc", "all", "UTC"));
  expect(vi.mocked(api.fetchPipelinePages).mock.calls.some((c) => c[1] === 50 && c[4] === "all")).toBe(false); // never fetched the old page under the new period
  expect(screen.getByText("page 1 of 3")).toBeInTheDocument();
});
it("is aria-busy while a new page or period loads, and clears on arrival", async () => {
  let resolve!: (r: PipelinePagesResponse) => void;
  vi.mocked(api.fetchPipelinePages).mockResolvedValueOnce(resp([row(1)], 120)).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { container } = render(<PagesTable range="30d" tz="UTC" />);
  await screen.findByText("Page 1");
  const section = () => container.querySelector("section")!;
  expect(section().getAttribute("aria-busy")).not.toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(section().getAttribute("aria-busy")).toBe("true");
  expect(section().classList.contains("is-refreshing")).toBe(true);
  resolve(resp([row(51)], 120, 50));
  await screen.findByText("Page 51");
  expect(section().getAttribute("aria-busy")).not.toBe("true");
});
