import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import ClusterCards from "./ClusterCards";
import { formatRunDate } from "@/lib/overview";
import { summary } from "./test-fixtures";

const card = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(".dev-stat-card")).find((c) => c.querySelector(".dev-stat-label")?.textContent === label)!;

it("shows the five cards with values and lines", () => {
  const { container } = render(<ClusterCards summary={summary()} />);
  const value = (l: string) => card(container, l).querySelector(".dev-stat-value")?.textContent;
  expect(value("Clusters")).toBe("30");
  expect(card(container, "Clusters")).toHaveClass("is-accent");
  expect(value("In a cluster")).toBe("44.0%");
  expect(value("Noise")).toBe("6.3%");
  expect(value("Superclusters")).toBe("3");
  expect(value("Similarity edges")).toBe("41");
  for (const line of [
    "176 of 400 pages in your graph", "224 not in a cluster", "12 of 192 pages clustering considered",
    "6 featured on the graph", "4 topics · 5 suggested groups", "mean 47% · range 18–86%", "kept above 15%, at most 3 per cluster",
  ]) expect(container.textContent).toContain(line);
  // zone-independent: the date text depends on the host time zone
  expect(container.textContent).toContain(`run #40 · ${formatRunDate(summary().run!.completed_at)}`);
  expect(container.textContent).toMatch(/run #40 · \S/);
});
it("links: loose pages anchor and a plain graph anchor", () => {
  render(<ClusterCards summary={summary()} />);
  expect(screen.getByText("224 not in a cluster")).toHaveAttribute("href", "#clusters-unclustered");
  expect(screen.getByText("See them on the graph →")).toHaveAttribute("href", "/");
});
it("zero edges", () => {
  render(<ClusterCards summary={summary({ edges: { count: 0, min: null, max: null, mean: null, bins: [] } })} />);
  expect(screen.getByText("No edges")).toBeInTheDocument();
});
