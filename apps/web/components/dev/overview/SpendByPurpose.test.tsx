import { render } from "@testing-library/react";
import { it, expect } from "vitest";
import SpendByPurpose from "./SpendByPurpose";
import { summary } from "./fixtures";

it("two purposes: bar segments, ordered list, shares and event types", () => {
  const { container } = render(<SpendByPurpose spend={summary().spend} />);
  expect(container.querySelectorAll(".overview-spend-bar > span")).toHaveLength(2);
  const items = [...container.querySelectorAll(".overview-spend-list > li")] as HTMLElement[];
  expect(items.map((li) => li.querySelector(".overview-spend-label")?.textContent)).toEqual(["Skip & learning gates", "Chat"]);
  for (const t of ["$1.04", "68.3%", "7,348 calls"]) expect(items[0]).toHaveTextContent(t);
  const lines = [...items[0].querySelectorAll(".overview-spend-types li")].map((e) => e.textContent);
  expect(lines).toEqual(["Skip gate $1.03 · 7,067 calls", "Learning gate $0.01 · 281 calls"]);
});
it("no spend", () => {
  const { container } = render(<SpendByPurpose spend={{ usd: 0, calls: 0, all_time_usd: 0, purposes: [] }} />);
  expect(container).toHaveTextContent("No LLM spend recorded in this period.");
  expect(container.querySelector(".overview-spend-bar")).toBeNull();
});
it("zero-cost purposes list without a bar", () => {
  const p = summary().spend.purposes[1];
  const { container } = render(<SpendByPurpose spend={{ usd: 0, calls: 5, all_time_usd: 0, purposes: [{ ...p, usd: 0, event_types: [] }] }} />);
  expect(container.querySelectorAll(".overview-spend-list > li")).toHaveLength(1);
  expect(container.querySelector(".overview-spend-bar")).toBeNull();
});
it("bar segments fill the whole bar even when paid dollars sum below $1", () => {
  const [g, c] = summary().spend.purposes;
  const spend = { usd: 0.07, calls: 10, all_time_usd: 0.07, purposes: [{ ...g, usd: 0.05, calls: 6 }, { ...c, usd: 0.02, calls: 4 }] };
  const { container } = render(<SpendByPurpose spend={spend} />);
  const grows = [...container.querySelectorAll<HTMLElement>(".overview-spend-bar > span")].map((s) => Number(s.style.flexGrow));
  expect(grows).toHaveLength(2);
  expect(grows.reduce((a, n) => a + n, 0)).toBeCloseTo(1);
  expect(grows[0]).toBeCloseTo(5 / 7);
});
