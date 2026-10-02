import { render, screen, waitFor } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import OverviewTimeline, { GROWTH_FOOTNOTE } from "./OverviewTimeline";
import { bucket, timeline, zeroBucket } from "./fixtures";
vi.mock("@/lib/api");

beforeEach(() => vi.resetAllMocks());
const mount = () => render(<OverviewTimeline range="all" tz="UTC" />);

it("three rows with growth, captures and spend", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([bucket(0), bucket(1), bucket(2)]));
  const { container } = mount();
  await waitFor(() => expect(container.querySelectorAll(".overview-tl-row")).toHaveLength(3));
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows.map((r) => r.querySelector(".overview-tl-title")?.textContent)).toEqual(["Corpus growth", "Captures", "LLM spend"]);
  expect(rows[0].querySelector(".overview-tl-figure")?.textContent).toBe("+60 captured");
  expect(rows[0].querySelector(".overview-tl-sub")?.textContent).toBe("+6 in your graph");
  expect(rows[1].querySelector(".overview-tl-figure")?.textContent).toBe("6 captures");
  expect(rows[1].querySelector(".overview-tl-sub")?.textContent).toBe("desktop 3 · phone 3");
  expect(rows[0].querySelectorAll("path.chart-line")).toHaveLength(2);
  expect(rows[0].querySelectorAll("text.chart-xlabel")).toHaveLength(0);
  expect(rows[1].querySelectorAll("text.chart-xlabel")).toHaveLength(0);
  expect(rows[2].querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
  expect(screen.getByText(GROWTH_FOOTNOTE)).toBeInTheDocument();
});
it("all-zero spend moves the x labels to the captures row", async () => {
  const z = (i: number) => bucket(i, { spend: { gates: 0, clustering: 0, chat: 0, other: 0 }, calls: 0 });
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([z(0), z(1), z(2)]));
  const { container } = mount();
  await screen.findByText("No LLM spend in this period.");
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows[1].querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
});
it("no activity", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([zeroBucket(0), zeroBucket(1)]));
  const { container } = mount();
  await screen.findByText("No activity in this period.");
  expect(container.querySelector(".overview-tl-row")).toBeNull();
});
it("stale API renders nothing", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockRejectedValue(new Error(STALE_API_MESSAGE));
  const { container } = mount();
  await waitFor(() => expect(api.fetchOverviewTimeline).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
it("other errors alert", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockRejectedValue(new Error("boom"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the timeline");
});
