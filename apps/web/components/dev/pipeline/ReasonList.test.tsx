import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ReasonList from "./ReasonList";
import type { ReasonRow } from "@/lib/types";
const rows: ReasonRow[] = [
  { key: "skip_gate", label: "Skip Gate", count: 30, top_domains: [{ domain: "a.example", count: 12 }, { domain: "b.example", count: 5 }, { domain: "c.example", count: 2 }, { domain: "d.example", count: 1 }] },
  { key: "dedup", label: "Dedup", count: 10, top_domains: [] },
];
it("renders label, count with percent of the base, and the top-3 domains line", () => {
  render(<ReasonList title="Archive reasons" rows={rows} base={40} emptyText="none" />);
  expect(screen.getByText("Skip Gate")).toBeInTheDocument();
  expect(screen.getByText("30").parentElement).toHaveTextContent("30 75%");
  expect(screen.getByText("10").parentElement).toHaveTextContent("10 25%");
  expect(screen.getByText("top: a.example (12), b.example (5), c.example (2)")).toBeInTheDocument();
  expect(document.querySelectorAll(".dev-bar-sub")).toHaveLength(1); // no domains -> no second line
  expect(document.querySelector(".dev-bar-fill")).toHaveStyle({ background: "var(--highlight)" });
});
it("shows 0%, never NaN, when the base is zero, and the empty copy for no rows", () => {
  const { container, rerender } = render(<ReasonList title="t" rows={[{ ...rows[1], count: 0 }]} base={0} emptyText="none" />);
  expect(container.textContent).toContain("0 0%");
  expect(container.textContent).not.toContain("NaN");
  rerender(<ReasonList title="t" rows={[]} base={0} emptyText="No gate skips in this period." />);
  expect(screen.getByText("No gate skips in this period.")).toBeInTheDocument();
});
