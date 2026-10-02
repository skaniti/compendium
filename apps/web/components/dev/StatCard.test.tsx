import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import StatCard from "./StatCard";
it("renders label and value, plus optional lines and the accent class", () => {
  const { container, rerender } = render(<StatCard label="Captured" value="10" />);
  expect(container.querySelector(".dev-stat-label")?.textContent).toBe("Captured");
  expect(container.querySelector(".dev-stat-value")?.textContent).toBe("10");
  expect(container.querySelectorAll(".dev-stat-line")).toHaveLength(0);
  rerender(<StatCard label="In your graph" value="3" accent lines={["30.0% of captured", <a key="l" href="/x">link</a>]} />);
  expect(container.querySelectorAll(".dev-stat-line")).toHaveLength(2);
  expect(container.querySelector(".dev-stat-card")?.className).toContain("is-accent");
});
