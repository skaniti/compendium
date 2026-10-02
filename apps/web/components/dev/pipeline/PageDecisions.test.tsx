import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PageDecisions from "./PageDecisions";
it("lists decisions with percent of total pages", () => {
  render(<PageDecisions total={50} decisions={[{ key: "skipped", label: "Skipped", count: 25, evaluated: true }, { key: "other", label: "Not evaluated", count: 0, evaluated: false }]} />);
  expect(screen.getByText("Page decisions")).toBeInTheDocument();
  expect(screen.getByText("25").parentElement).toHaveTextContent("25 50%");
});
it("empty period reads No pages in this period. with no NaN", () => {
  const { container } = render(<PageDecisions total={0} decisions={[]} />);
  expect(screen.getByText("No pages in this period.")).toBeInTheDocument();
  expect(container.textContent).not.toContain("NaN");
});
