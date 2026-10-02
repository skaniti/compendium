import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import TimeWindowProvider from "@/components/TimeWindowProvider";
import OverviewView, { OVERVIEW_SUBTITLE } from "./OverviewView";
import { bucket, summary, timeline, zeroBucket } from "./fixtures";
vi.mock("@/lib/api");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([bucket(0), bucket(1)]));
});
const mount = () => render(<TimeWindowProvider initialWindow="all"><OverviewView /></TimeWindowProvider>);

it("loading, then subtitle, cards, timeline, spend in order", async () => {
  vi.mocked(api.fetchOverviewSummary).mockResolvedValue(summary());
  const { container } = mount();
  expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  await waitFor(() => expect(container.querySelector(".overview-spend")).toBeTruthy());
  await waitFor(() => expect(container.querySelector(".overview-tl-row")).toBeTruthy());
  expect(screen.getByText(OVERVIEW_SUBTITLE)).toBeInTheDocument();
  const order = [".overview-cards", ".overview-timeline", ".overview-spend"].map((s) => container.querySelector(s) as HTMLElement);
  expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("stale API", async () => {
  vi.mocked(api.fetchOverviewSummary).mockRejectedValue(new Error(STALE_API_MESSAGE));
  const { container } = mount();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The API is older than this view; restart it to load the overview.");
  await waitFor(() => expect(container.querySelector(".overview-timeline")).toBeNull());
});
it("other summary error", async () => {
  vi.mocked(api.fetchOverviewSummary).mockRejectedValue(new Error("boom"));
  mount();
  expect(await screen.findByText("Couldn't load the overview (boom).")).toHaveAttribute("role", "alert");
});
it("period pill refetches", async () => {
  vi.mocked(api.fetchOverviewSummary).mockResolvedValue(summary());
  mount();
  await screen.findByText("Spend by purpose");
  await userEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(api.fetchOverviewSummary).toHaveBeenCalledWith("7d", expect.any(String)));
});
it("empty account", async () => {
  vi.mocked(api.fetchOverviewSummary).mockResolvedValue(summary({
    pages: { captured: 0, in_graph: 0, all_time_captured: 0 }, captures: { total: 0, desktop: 0, phone: 0 },
    spend: { usd: 0, calls: 0, all_time_usd: 0, purposes: [] }, clusters: null,
  }));
  vi.mocked(api.fetchOverviewTimeline).mockResolvedValue(timeline([zeroBucket(0), zeroBucket(1)]));
  mount();
  await screen.findByText("No activity in this period.");
  await screen.findByText("No LLM spend recorded in this period.");
  expect(document.body.textContent).not.toContain("NaN");
});
