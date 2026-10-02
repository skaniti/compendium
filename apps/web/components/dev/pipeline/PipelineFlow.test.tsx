import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect } from "vitest";
import type { FlowDetail, PipelineFlow as Flow } from "@/lib/types";
import { FLOW_MIN_WIDTH } from "@/lib/pipeline-flow";
import PipelineFlow from "./PipelineFlow";

const dom = (a: number, b: number, c: number) => [{ domain: "a.example", count: a }, { domain: "b.example", count: b }, { domain: "c.example", count: c }];
const det = (outcome: FlowDetail["outcome"], key: string, label: string, count: number, archived: number, active: number): FlowDetail =>
  ({ outcome, key, label, count, top_domains: dom(count, 2, 1), fates: { archived, active, pending: 0 } });
const flow = (pending = 0): Flow => ({
  total: 100,
  outcomes: [
    { key: "before_gate", label: "Archived before gate", count: 20, top_domains: dom(9, 5, 3) },
    { key: "rule_filter", label: "Rule filter · no LLM", count: 10, top_domains: dom(4, 3, 2) },
    { key: "gate", label: "Skipped by LLM gate", count: 40, top_domains: dom(7, 6, 5) },
    { key: "processed", label: "Processed · kept", count: 30 - pending, top_domains: dom(8, 4, 2) },
    ...(pending ? [{ key: "pending" as const, label: "Pending", count: pending, top_domains: [] }] : []),
  ],
  details: [
    det("before_gate", "placeholder", "Placeholder", 20, 20, 0),
    det("rule_filter", "domain", "Domain filter", 10, 10, 0),
    det("gate", "store", "Store", 15, 15, 0), det("gate", "login", "Login Wall", 10, 10, 0), det("gate", "search", "Search", 8, 8, 0),
    det("gate", "tiny_a", "Tiny A", 4, 4, 0), det("gate", "tiny_b", "Tiny B", 3, 3, 0),
    det("processed", "kept", "Still active", 25, 0, 25), det("processed", "later_manual", "Archived later", 5, 5, 0),
  ],
  fates: [
    { key: "archived", label: "Archived", count: 70 }, { key: "active", label: "Active", count: 30 - pending },
    ...(pending ? [{ key: "pending" as const, label: "Pending", count: pending }] : []),
  ],
});
const colors = { store: "var(--a)", login: "var(--b)", search: "var(--c)", tiny_a: "var(--d)", tiny_b: "var(--e)" };
const mount = (f = flow()) => render(<PipelineFlow flow={f} catColors={colors} ratio={0.7} />);

it("renders the column headers, captured headline, fate captions and archive ratio", () => {
  mount();
  for (const h of ["CAPTURED", "OUTCOME", "BREAKDOWN", "FATE"]) expect(screen.getByText(h)).toBeInTheDocument();
  expect(screen.getByText("CAPTURED PAGES")).toBeInTheDocument();
  expect(screen.getByText("100")).toBeInTheDocument();
  expect(screen.getByText("ARCHIVED")).toBeInTheDocument();
  expect(screen.getByText("70.0% archive ratio")).toBeInTheDocument();
  expect(screen.getByText("ACTIVE · in your graph")).toBeInTheDocument();
  expect(screen.getByText("Skipped by LLM gate")).toBeInTheDocument();
});
it("bundles small gate categories and shows the Pending 0 markers", () => {
  mount();
  expect(screen.getByText(/2 smaller categories/)).toBeInTheDocument();
  expect(screen.getByText("Pending 0 ····")).toBeInTheDocument();
  expect(screen.getByText("···· PENDING 0")).toBeInTheDocument();
});
it("shows PENDING n and no zero marker when there are pending pages", () => {
  mount(flow(6));
  expect(screen.getByText("PENDING 6")).toBeInTheDocument();
  expect(screen.queryByText("Pending 0 ····")).toBeNull();
  expect(screen.queryByText("···· PENDING 0")).toBeNull();
});
it("the sub-line for archived-later sits on its own line", () => {
  mount();
  expect(screen.getByText("5 manual")).toBeInTheDocument();
});
it("keeps a min-width of 1100px so narrow panels scroll", () => {
  const { container } = mount();
  const scroll = container.querySelector(".pipeline-flow-scroll")!;
  const wrap = scroll.querySelector(".chart-wrap") as HTMLElement;
  expect(wrap).toBeTruthy();
  expect(parseFloat(wrap.style.minWidth)).toBeGreaterThanOrEqual(FLOW_MIN_WIDTH);
  expect(scroll.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain("100");
});
it("node hover lists label, share of captured and the top domains", () => {
  const { container } = mount();
  fireEvent.mouseMove(container.querySelector('rect[data-node="gate"]')!);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines.slice(0, 3)).toEqual(["Skipped by LLM gate", "40 · 40.0% of captured", "TOP DOMAINS"]);
  expect(lines).toContain("a.example  7");
  expect(lines.filter((l) => /\.example {2}\d/.test(l ?? ""))).toHaveLength(3);
});
it("bundle strand hover shows the category label and count", () => {
  const { container } = mount();
  const strand = container.querySelector('path[data-link^="gate>gate:smaller:"]')!;
  fireEvent.mouseMove(strand);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/Tiny/);
});
it("an empty period renders the empty copy without NaN", () => {
  const { container } = mount({ total: 0, outcomes: [], details: [], fates: [] });
  expect(screen.getByText("No pages in this period.")).toBeInTheDocument();
  expect(container.innerHTML).not.toContain("NaN");
});
