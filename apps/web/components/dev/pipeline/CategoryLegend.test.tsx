import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import CategoryLegend from "./CategoryLegend";

it("renders a swatch, label and count per category", () => {
  const { container } = render(<CategoryLegend items={[{ id: "a", label: "Login Wall", count: 688, color: "var(--x)" }, { id: "b", label: "Other", count: 3, color: "var(--y)" }]} />);
  expect(container.querySelector("ul.chart-legend-flow")).toBeTruthy();
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(screen.getByText("Login Wall")).toBeInTheDocument();
  expect(screen.getByText("688")).toBeInTheDocument();
  expect((container.querySelector(".swatch") as HTMLElement).style.background).toContain("var(--x)");
});
