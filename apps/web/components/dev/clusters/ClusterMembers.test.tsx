import { render, screen } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/clusters-api";
import ClusterMembers from "./ClusterMembers";
vi.mock("@/lib/clusters-api");

beforeEach(() => vi.resetAllMocks());

it("loading then members with domains", async () => {
  vi.mocked(api.fetchClusterMembers).mockResolvedValue({ cluster_id: 4, total: 1, pages: [{ id: 1, title: null, domain: "example.org", url: "https://example.org/a" }] });
  render(<ClusterMembers clusterId={4} />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Untitled" })).toHaveAttribute("href", "https://example.org/a");
  expect(screen.getByText("example.org")).toBeInTheDocument();
});
it("empty cluster", async () => {
  vi.mocked(api.fetchClusterMembers).mockResolvedValue({ cluster_id: 4, total: 0, pages: [] });
  render(<ClusterMembers clusterId={4} />);
  expect(await screen.findByText("No pages in this cluster.")).toBeInTheDocument();
});
