import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/clusters-api";
import UnclusteredTable, { UNCLUSTERED_CAPTION } from "./UnclusteredTable";
import { summary, unclustered } from "./test-fixtures";
vi.mock("@/lib/clusters-api");

const pages = () => summary().pages!;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchUnclustered).mockImplementation(async (_l, offset) => unclustered(224, offset));
});

it("first page, meta, caption and note pills", async () => {
  const { container } = render(<UnclusteredTable pages={pages()} />);
  await screen.findByText("Loose page 1");
  expect(api.fetchUnclustered).toHaveBeenCalledWith(50, 0);
  expect(screen.getByText("224 pages · 6 featured · 3 new since the run")).toBeInTheDocument();
  expect(screen.getByText(UNCLUSTERED_CAPTION)).toBeInTheDocument();
  const rows = container.querySelectorAll("tbody tr");
  expect(rows[0].querySelector(".clusters-note")).toHaveTextContent("featured");
  expect(rows[1].querySelector(".clusters-note")).toHaveTextContent("new since run");
  expect(rows[2].querySelector(".clusters-note")).toBeNull();
});
it("pages forward and prev is disabled on the first page", async () => {
  render(<UnclusteredTable pages={pages()} />);
  await screen.findByText("Loose page 1");
  expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(api.fetchUnclustered).toHaveBeenCalledWith(50, 50));
  expect(await screen.findByText("Loose page 51")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
});
it("nothing left out", async () => {
  vi.mocked(api.fetchUnclustered).mockResolvedValue(unclustered(0));
  render(<UnclusteredTable pages={{ ...pages(), not_clustered: 0, featured: 0, since_run: 0 }} />);
  expect(await screen.findByText("Every page in your graph is in a cluster.")).toBeInTheDocument();
});
it("load error", async () => {
  vi.mocked(api.fetchUnclustered).mockRejectedValue(new Error("boom"));
  render(<UnclusteredTable pages={pages()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load pages (boom).");
});
