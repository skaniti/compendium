import { render } from "@testing-library/react";
import { it, expect } from "vitest";
import SpendByPurpose from "./SpendByPurpose";
import { summary } from "./fixtures";

it("two purposes: bar segments, ordered list, shares and event types", () => {
  const { container } = render(<SpendByPurpose spend={summary().spend} />);
  expect(container.querySelectorAll(".overview-spend-bar > span")).toHaveLength(2);
  const items = [...container.querySelectorAll(".overview-spend-list li")] as HTMLElement[];
  expect(items.map((li) => li.querySelector(".overview-spend-label")?.textContent)).toEqual(["Skip & learning gates", "Chat"]);
  for (const t of ["$1.04", "68.3%", "7,348 calls", "Skip gate $1.03 · 7,067 calls"]) expect(items[0]).toHaveTextContent(t);
});
it("no spend", () => {
  const { container } = render(<SpendByPurpose spend={{ usd: 0, calls: 0, all_time_usd: 0, purposes: [] }} />);
  expect(container).toHaveTextContent("No LLM spend recorded in this period.");
  expect(container.querySelector(".overview-spend-bar")).toBeNull();
});
it("zero-cost purposes list without a bar", () => {
  const p = summary().spend.purposes[1];
  const { container } = render(<SpendByPurpose spend={{ usd: 0, calls: 5, all_time_usd: 0, purposes: [{ ...p, usd: 0, event_types: [] }] }} />);
  expect(container.querySelectorAll(".overview-spend-list li")).toHaveLength(1);
  expect(container.querySelector(".overview-spend-bar")).toBeNull();
});
