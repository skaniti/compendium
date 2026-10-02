import { render, screen, waitFor } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/clusters-api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import ClustersView, { CLUSTERS_SUBTITLE, NO_RUN_TEXT, STALE_TEXT } from "./ClustersView";
import { runOf, summary, unclustered } from "./test-fixtures";
vi.mock("@/lib/clusters-api");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchUnclustered).mockResolvedValue(unclustered(3));
});

it("loading, then subtitle and every section in order", async () => {
  vi.mocked(api.fetchClustersSummary).mockResolvedValue(summary());
  const { container } = render(<ClustersView />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector(".clusters-cards")).toBeTruthy());
  expect(screen.getByText(CLUSTERS_SUBTITLE)).toBeInTheDocument();
  const order = [".clusters-cards", ".clusters-config-row", ".clusters-runs", ".clusters-dist-row", ".clusters-table-panel", "#clusters-unclustered"]
    .map((s) => container.querySelector(s) as HTMLElement);
  order.forEach((el) => expect(el).toBeTruthy());
  for (let i = 0; i < order.length - 1; i++) {
    expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});
it("stale API", async () => {
  vi.mocked(api.fetchClustersSummary).mockRejectedValue(new Error(STALE_API_MESSAGE));
  const { container } = render(<ClustersView />);
  expect(await screen.findByRole("alert")).toHaveTextContent(STALE_TEXT);
  expect(container.querySelector(".clusters-cards")).toBeNull();
});
it("other error", async () => {
  vi.mocked(api.fetchClustersSummary).mockRejectedValue(new Error("boom"));
  render(<ClustersView />);
  expect(await screen.findByText("Couldn't load clusters (boom).")).toHaveAttribute("role", "alert");
});
it("no run: panel, config and history, nothing else, no NaN", async () => {
  vi.mocked(api.fetchClustersSummary).mockResolvedValue(summary({ run: null, pages: null, clusters: [], runs: { total: 1, items: [runOf(3, "failed")] } }));
  const { container } = render(<ClustersView />);
  expect(await screen.findByText(NO_RUN_TEXT)).toBeInTheDocument();
  expect(container.querySelector(".clusters-config-row")).toBeTruthy();
  expect(container.querySelector(".clusters-runs")).toBeTruthy();
  expect(container.querySelector(".clusters-table-panel")).toBeNull();
  expect(container.querySelector("#clusters-unclustered")).toBeNull();
  expect(document.body.textContent).not.toContain("NaN");
});
it("has no period pills", async () => {
  vi.mocked(api.fetchClustersSummary).mockResolvedValue(summary());
  const { container } = render(<ClustersView />);
  await waitFor(() => expect(container.querySelector(".clusters-cards")).toBeTruthy());
  expect(screen.queryByRole("group", { name: "Window" })).toBeNull();
});
