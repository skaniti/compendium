import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import HeadlineCards from "./HeadlineCards";
import { summary } from "./fixtures";

const cards = (c: HTMLElement) => [...c.querySelectorAll(".dev-stat-card")] as HTMLElement[];

it("all time: four cards in order with values, lines and the pipeline link", () => {
  const { container } = render(<HeadlineCards summary={summary()} range="all" />);
  const cs = cards(container);
  expect(cs.map((c) => c.querySelector(".dev-stat-label")?.textContent)).toEqual(["Captured", "In your graph", "Clusters", "LLM spend"]);
  expect(cs.map((c) => c.querySelector(".dev-stat-value")?.textContent)).toEqual(["10,094", "1,276", "86", "$1.52"]);
  for (const t of ["pages from 1,095 captures", "12.6% of captured", "6 superclusters · 8 topics", "latest run · Sep 23", "7,724 LLM calls"]) expect(screen.getByText(t)).toBeInTheDocument();
  expect(container.textContent).not.toContain("all time");
  expect(cs[1]).toHaveClass("is-accent");
  expect(screen.getByRole("link", { name: "Where the rest went → Pipeline" })).toHaveAttribute("href", "/dev/pipeline");
});
it("7 days: zero period shows all-time context", () => {
  const s = summary({ range: "7d", pages: { captured: 0, in_graph: 0, all_time_captured: 10094 }, spend: { usd: 0, calls: 0, all_time_usd: 1.5, purposes: [] } });
  const { container } = render(<HeadlineCards summary={s} range="7d" />);
  for (const t of ["0.0% of captured", "10,094 all time", "No LLM calls in this period", "$1.50 all time"]) expect(screen.getByText(t)).toBeInTheDocument();
  expect(cards(container)[3].querySelector(".dev-stat-value")?.textContent).toBe("$0.00");
});
it("no clustering run", () => {
  const { container } = render(<HeadlineCards summary={summary({ clusters: null })} range="all" />);
  expect(cards(container)[2].querySelector(".dev-stat-value")?.textContent).toBe("—");
  expect(screen.getByText("No clustering run yet")).toBeInTheDocument();
});
it("singulars", () => {
  const base = summary();
  render(<HeadlineCards range="all" summary={summary({
    captures: { total: 1, desktop: 1, phone: 0 },
    clusters: { run_completed_at: "2026-09-23T12:00:00+00:00", clusters: 1, superclusters: 1, topics: 8 },
    spend: { ...base.spend, calls: 1 },
  })} />);
  for (const t of ["pages from 1 capture", "1 supercluster · 8 topics", "1 LLM call"]) expect(screen.getByText(t)).toBeInTheDocument();
});
