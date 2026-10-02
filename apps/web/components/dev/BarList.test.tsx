import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import BarList from "./BarList";
it("renders rows with width proportional to max and shows pct when given", () => {
  render(<BarList title="Page decisions" rows={[{ label: "Skipped", count: 40, pct: 57, fill: "var(--primary)" }, { label: "Other", count: 20, fill: "#2b2e34" }]} emptyText="none" />);
  const fills = document.querySelectorAll(".dev-bar-fill") as NodeListOf<HTMLElement>;
  expect(fills[0].style.width).toBe("100%");
  expect(fills[1].style.width).toBe("50%");
  expect(screen.getByText("57%")).toBeInTheDocument();
});
it("renders emptyText when there are no rows", () => {
  render(<BarList title="Skip gate reasons" rows={[]} emptyText="No archived pages yet." />);
  expect(screen.getByText("No archived pages yet.")).toBeInTheDocument();
});
it("renders a muted second line under a row when sub is given", () => {
  render(<BarList title="Archive reasons" rows={[{ label: "Dedup", count: 3, pct: 30, fill: "x", sub: "top: a.com (2)" }, { label: "Other", count: 1, fill: "x" }]} emptyText="none" />);
  expect(screen.getByText("top: a.com (2)")).toHaveClass("dev-bar-sub");
  expect(document.querySelectorAll(".dev-bar-sub")).toHaveLength(1);
});
