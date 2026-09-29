import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect } from "vitest";
import * as api from "@/lib/api";
import type { PageSortColumn, PipelinePagesResponse, SortDir } from "@/lib/types";
import PagesTable from "./PagesTable";
vi.mock("@/lib/api");
const row = (id: number) => ({ id, title: `Page ${id}`, domain: "example.org", status: "archived", processing_depth: "skipped",
  archive_reason: "skip_gate", skip_reasoning: "login wall", visited_at: "2026-08-13T23:17:14+00:00", created_at: null });
const resp = (rows: ReturnType<typeof row>[], total: number, offset = 0, sort: PageSortColumn = "created_at", dir: SortDir = "desc"): PipelinePagesResponse =>
  ({ rows, total, limit: 50, offset, sort, dir });
it("renders rows, derived skip columns, and pages through", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValueOnce(resp([row(1), row(2)], 120)).mockResolvedValueOnce(resp([row(51)], 120, 50));
  render(<PagesTable />);
  await screen.findByText("Page 1");
  expect(screen.getAllByText("gate")).toHaveLength(2);
  expect(screen.getByText("page 1 of 3")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 51");
  expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 50, "created_at", "desc");
});
it("clicking a header sorts by that column, toggles direction, and resets to page 1", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  render(<PagesTable />);
  await screen.findByText("Page 1");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "asc"));
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "desc"));
  expect(screen.getByRole("columnheader", { name: /^Domain/ })).toHaveAttribute("aria-sort", "descending");
});
it("Newest first resets to the default order and disables itself there", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([row(1)], 120));
  render(<PagesTable />);
  await screen.findByText("Page 1");
  const reset = screen.getByRole("button", { name: "Newest first" });
  expect(reset).toBeDisabled();
  expect(screen.getByRole("columnheader", { name: /^Domain/ })).toHaveAttribute("aria-sort", "none");
  await userEvent.click(screen.getByRole("button", { name: /^Domain/ }));
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "domain", "asc"));
  expect(reset).toBeEnabled();
  await userEvent.click(reset);
  await waitFor(() => expect(api.fetchPipelinePages).toHaveBeenLastCalledWith(50, 0, "created_at", "desc"));
  expect(screen.getByRole("button", { name: "Newest first" })).toBeDisabled();
});
it("empty -> No pages found.", async () => {
  vi.mocked(api.fetchPipelinePages).mockResolvedValue(resp([], 0));
  render(<PagesTable />);
  await screen.findByText("No pages found.");
});
