import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import type { FlowDetail, PipelineFlow as Flow } from "@/lib/types";
import { FLOW_MIN_WIDTH } from "@/lib/pipeline-flow";
import PipelineFlow, { canScrollRight } from "./PipelineFlow";

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
  const pct = screen.getByText("70.0%");
  expect(pct).toHaveClass("flow-ratio-pct");
  expect(pct.parentElement).toHaveTextContent("70.0% archive ratio");
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
it("fate hierarchy: ARCHIVED count is the large headline, ACTIVE the smaller one", () => {
  const { container } = mount();
  const heads = Array.from(container.querySelectorAll("text.flow-headline"));
  expect(heads.find((h) => h.textContent === "70")).toHaveClass("flow-headline-lg");
  const active = heads.find((h) => h.textContent === "30")!;
  expect(active).toHaveClass("flow-headline-active");
  expect(active).not.toHaveClass("flow-headline-lg");
});
it("fate captions stay below the column header when the archived node is tiny", () => {
  const f: Flow = {
    total: 1000,
    outcomes: [{ key: "processed", label: "Processed · kept", count: 1000, top_domains: [] }],
    details: [det("processed", "later_manual", "Archived later", 2, 2, 0), det("processed", "kept", "Still active", 998, 0, 998)],
    fates: [{ key: "archived", label: "Archived", count: 2 }, { key: "active", label: "Active", count: 998 }],
  };
  const { container } = mount(f);
  const cap = Array.from(container.querySelectorAll("text.flow-cap")).find((t) => t.textContent === "ARCHIVED")!;
  const headY = Number(container.querySelector("text.flow-colhead:last-of-type")!.getAttribute("y")); // svg coords
  const capY = Number(cap.getAttribute("y")) + 36; // group offset TOP
  expect(capY - 10).toBeGreaterThan(headY); // cap text (10px) top clears the header baseline
});
it("grey ribbons are more opaque than cyan ones, and archived-later is grey", () => {
  const { container } = mount();
  const op = (sel: string) => Number(container.querySelector(sel)!.getAttribute("fill-opacity"));
  expect(op('path[data-link="captured>rule_filter"]')).toBe(0.55);
  expect(op('path[data-link="captured>processed"]')).toBe(0.35);
  expect(container.querySelector('rect[data-node="processed:later"]')).toHaveStyle({ fill: "var(--flow-archived)" });
});
it("captured tooltip marks merged top domains approximate", () => {
  const { container } = mount();
  fireEvent.mouseMove(container.querySelector('rect[data-node="captured"]')!);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines).toContain("TOP DOMAINS (approx.)");
});
it("flags overflow with a right-edge fade until scrolled to the end", () => {
  const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1200);
  const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  try {
    const { container } = mount();
    const fadeEl = container.querySelector(".pipeline-flow-fade")!;
    const scroll = container.querySelector(".pipeline-flow-scroll") as HTMLElement;
    expect(fadeEl).toHaveClass("is-overflowing");
    scroll.scrollLeft = 600;
    fireEvent.scroll(scroll);
    expect(fadeEl).not.toHaveClass("is-overflowing");
    scroll.scrollLeft = 100;
    fireEvent.scroll(scroll);
    expect(fadeEl).toHaveClass("is-overflowing");
  } finally { sw.mockRestore(); cw.mockRestore(); }
});
it("no fade when the flow fits", () => {
  const { container } = mount();
  expect(container.querySelector(".pipeline-flow-fade")).not.toHaveClass("is-overflowing");
});
it("canScrollRight is false at the end and true before it", () => {
  expect(canScrollRight({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 600 })).toBe(false);
  expect(canScrollRight({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 })).toBe(true);
});
