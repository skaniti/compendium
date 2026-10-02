import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/clusters-api";
import ClusterTable from "./ClusterTable";
import { row, summary } from "./test-fixtures";
vi.mock("@/lib/clusters-api");

beforeEach(() => vi.resetAllMocks());
const names = (c: HTMLElement) => Array.from(c.querySelectorAll("tbody .clusters-name")).map((n) => n.textContent);
const members = (total: number, n: number) => ({
  cluster_id: 1, total,
  pages: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Member ${i + 1}`, domain: "example.org", url: `https://example.org/m/${i + 1}` })),
});

it("25 rows by default, largest first, then all", async () => {
  const { container } = render(<ClusterTable clusters={summary().clusters} runId={40} />);
  expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
  const sizes = Array.from(container.querySelectorAll(".clusters-size-num")).map((n) => Number(n.textContent));
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  await userEvent.click(screen.getByRole("button", { name: "Show all 30 clusters" }));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(30);
});
it("confidence header sorts desc then asc", async () => {
  const clusters = [row(1, 5, { confidence: 0.9 }), row(2, 9, { confidence: 0.2 }), row(3, 7, { confidence: 0.5 })];
  const { container } = render(<ClusterTable clusters={clusters} runId={1} />);
  await userEvent.click(screen.getByRole("button", { name: /Confidence/ }));
  expect(names(container)).toEqual(["Cluster 1", "Cluster 3", "Cluster 2"]);
  await userEvent.click(screen.getByRole("button", { name: /Confidence/ }));
  expect(names(container)).toEqual(["Cluster 2", "Cluster 3", "Cluster 1"]);
});
it("expanding fetches members once and renders safe links", async () => {
  const data = members(2, 2);
  data.pages[1].url = "javascript:x";
  vi.mocked(api.fetchClusterMembers).mockResolvedValue(data);
  const { container } = render(<ClusterTable clusters={[row(1, 5)]} runId={1} />);
  const btn = screen.getByRole("button", { name: /Cluster 1/ });
  expect(btn).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(btn);
  expect(btn).toHaveAttribute("aria-expanded", "true");
  const link = await screen.findByRole("link", { name: "Member 1" });
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByText("Member 2")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Member 2" })).toBeNull();
  expect(api.fetchClusterMembers).toHaveBeenCalledTimes(1);
  expect(api.fetchClusterMembers).toHaveBeenCalledWith(1);
  await userEvent.click(btn);
  expect(container.querySelector(".clusters-members-row")).toBeNull();
});
it("says how many members are not shown", async () => {
  vi.mocked(api.fetchClusterMembers).mockResolvedValue(members(205, 200));
  render(<ClusterTable clusters={[row(1, 5)]} runId={1} />);
  await userEvent.click(screen.getByRole("button", { name: /Cluster 1/ }));
  expect(await screen.findByText("and 5 more")).toBeInTheDocument();
});
it("carried names are marked", () => {
  const { container } = render(<ClusterTable clusters={[row(1, 5, { name_carried: true }), row(2, 4, { name_carried: false })]} runId={1} />);
  const trs = container.querySelectorAll("tbody tr");
  expect(within(trs[0] as HTMLElement).getByText("· carried")).toBeInTheDocument();
  expect(within(trs[1] as HTMLElement).queryByText("· carried")).toBeNull();
});
it("member load error", async () => {
  vi.mocked(api.fetchClusterMembers).mockRejectedValue(new Error("fetchClusterMembers failed: 404 Err"));
  render(<ClusterTable clusters={[row(1, 5)]} runId={1} />);
  await userEvent.click(screen.getByRole("button", { name: /Cluster 1/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load pages (fetchClusterMembers failed: 404 Err)."));
});
