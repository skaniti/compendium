import { render } from "@testing-library/react";
import { it, expect } from "vitest";
import SpendByPurpose from "./SpendByPurpose";
import { summary } from "./fixtures";

it("two purposes: figures ride the bar, the legend keeps names and event types", () => {
  const { container } = render(<SpendByPurpose spend={summary().spend} />);
  const segs = [...container.querySelectorAll(".overview-spend-bar > span")];
  expect(segs).toHaveLength(2);
  // jsdom width 640: the gates segment fits the full label, chat only the short one.
  expect(segs.map((s) => s.querySelector(".overview-spend-seg-label")?.textContent)).toEqual(["$0.61 · 72.4% · 3,000 calls", "$0.23 · 27.6%"]);
  expect(container.querySelector(".overview-spend-bar")?.getAttribute("aria-label")).toContain("Chat $0.23, 27.6%, 250 calls");
  expect(container.querySelector(".overview-spend-callouts")).toBeNull();
  const items = [...container.querySelectorAll(".overview-spend-list > li")] as HTMLElement[];
  expect(items.map((li) => li.querySelector(".overview-spend-label")?.textContent)).toEqual(["Skip & learning gates", "Chat"]);
  expect(items[0]).not.toHaveTextContent("72.4%");
  const lines = [...items[0].querySelectorAll(".overview-spend-types li")].map((e) => e.textContent);
  expect(lines).toEqual(["Skip gate $0.59 · 2,900 calls", "Learning gate $0.02 · 100 calls"]);
});
it("a segment too narrow for its figures gets a callout above the bar instead", () => {
  const [g, c] = summary().spend.purposes;
  const spend = { usd: 1, calls: 3010, all_time_usd: 1, purposes: [{ ...g, usd: 0.99 }, { ...c, usd: 0.01, calls: 10 }] };
  const { container } = render(<SpendByPurpose spend={spend} />);
  const segs = [...container.querySelectorAll(".overview-spend-bar > span")];
  expect(segs[1].querySelector(".overview-spend-seg-label")).toBeNull();
  expect([...container.querySelectorAll(".overview-spend-callout")].map((e) => e.textContent)).toEqual(["$0.01 · 1.0% · 10 calls"]);
  expect(container.querySelectorAll(".overview-spend-tick")).toHaveLength(1);
});
it("a zero-dollar purpose has no segment, so its legend entry carries its figures", () => {
  const [g, c] = summary().spend.purposes;
  const spend = { usd: 0.61, calls: 3005, all_time_usd: 0.61, purposes: [g, { ...c, usd: 0, calls: 5, event_types: [] }] };
  const { container } = render(<SpendByPurpose spend={spend} />);
  const items = [...container.querySelectorAll(".overview-spend-list > li")] as HTMLElement[];
  expect(items[1].querySelector(".overview-spend-unbarred")?.textContent).toBe(" $0.00 · 5 calls");
  expect(items[0].querySelector(".overview-spend-unbarred")).toBeNull();
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
