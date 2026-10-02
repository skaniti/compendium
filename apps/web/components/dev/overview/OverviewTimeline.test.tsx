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
const noCaptures = (i: number, spend = { gates: 0.01, clustering: 0, chat: 0.001, other: 0 }, calls = 3) =>
  bucket(i, { captures: { desktop: 0, phone: 0 }, spend, calls });
const noSpend = { gates: 0, clustering: 0, chat: 0, other: 0 };
it("no captures with spend: captures row says so and spend carries the x labels", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([noCaptures(0), noCaptures(1), noCaptures(2)]));
  const { container } = mount();
  await screen.findByText("No captures in this period.");
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows[1]).toHaveTextContent("No captures in this period.");
  expect(rows[1].querySelector("svg")).toBeNull();
  expect(rows[1].querySelectorAll("text.chart-xlabel")).toHaveLength(0);
  expect(rows[0].querySelectorAll("text.chart-xlabel")).toHaveLength(0);
  expect(rows[2].querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
});
it("no captures and no spend: growth row carries the x labels", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([noCaptures(0, noSpend, 0), noCaptures(1, noSpend, 0)]));
  const { container } = mount();
  await screen.findByText("No captures in this period.");
  await screen.findByText("No LLM spend in this period.");
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows[0].querySelectorAll("text.chart-xlabel").length).toBeGreaterThan(0);
});
const legendOf = (row: HTMLElement) => [...row.querySelectorAll(".overview-tl-legend li")].map((li) => li.textContent);
it("stacked-row legends list top-of-stack first; growth legend keeps series order", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([
    bucket(0, { spend: { gates: 0.01, clustering: 0.02, chat: 0.001, other: 0 } }),
    bucket(1, { spend: { gates: 0.01, clustering: 0.02, chat: 0.001, other: 0 } }),
  ]));
  const { container } = mount();
  await waitFor(() => expect(container.querySelectorAll(".overview-tl-row")).toHaveLength(3));
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(legendOf(rows[0])).toEqual(["Captured", "In your graph"]);
  expect(legendOf(rows[1])).toEqual(["Phone", "Desktop"]);
  expect(legendOf(rows[2])).toEqual(["Chat", "Clustering & naming", "Skip & learning gates"]);
});
it("no captures: the captures row has no legend; spend row keeps its own", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([noCaptures(0), noCaptures(1)]));
  const { container } = mount();
  await screen.findByText("No captures in this period.");
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows[1].querySelector(".overview-tl-legend")).toBeNull();
  expect(rows[2].querySelector(".overview-tl-legend")).not.toBeNull();
});
it("no spend: the spend row has no legend", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([noCaptures(0, noSpend, 0), bucket(1, { spend: noSpend, calls: 0 })]));
  const { container } = mount();
  await screen.findByText("No LLM spend in this period.");
  const rows = [...container.querySelectorAll(".overview-tl-row")] as HTMLElement[];
  expect(rows[2].querySelector(".overview-tl-legend")).toBeNull();
});
const day = (i: number) => bucket(i, { start: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
it("growth point markers only when the period has at most 16 buckets", async () => {
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline(Array.from({ length: 16 }, (_, i) => day(i))));
  const a = mount();
  await waitFor(() => expect(a.container.querySelectorAll(".overview-tl-row")).toHaveLength(3));
  expect(a.container.querySelector(".overview-tl-row")!.querySelectorAll("circle.chart-point").length).toBeGreaterThan(0);
  a.unmount();
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline(Array.from({ length: 17 }, (_, i) => day(i))));
  const b = mount();
  await waitFor(() => expect(b.container.querySelectorAll(".overview-tl-row")).toHaveLength(3));
  expect(b.container.querySelector(".overview-tl-row")!.querySelectorAll("circle.chart-point")).toHaveLength(0);
});
