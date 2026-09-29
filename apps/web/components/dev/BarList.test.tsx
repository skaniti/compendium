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
