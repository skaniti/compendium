import { it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import TimelineBars from "./TimelineBars";
import LineAreaChart from "./LineAreaChart";
import StackedBarChart from "./StackedBarChart";
import { seriesFill } from "./palette";
import { countTicks, labelSpacing, thinBandLabels } from "./scales";

function withWidth(w: number, fn: () => void) {
  class RO { constructor(private c: ResizeObserverCallback) {} observe() { this.c([{ contentRect: { width: w } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} }
  vi.stubGlobal("ResizeObserver", RO);
  try { fn(); } finally { vi.unstubAllGlobals(); }
}
const cats = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Sep ${String(i + 1).padStart(2, "0")}`, axis: `Sep ${String(i + 1).padStart(2, "0")}` as string | null }));
const axisTexts = (c: HTMLElement) => Array.from(c.querySelectorAll("text.chart-xlabel")).map((t) => t.textContent);

it("TimelineBars stacks kept below archived with the highlight colours and a tooltip", () => {
  const { container } = render(<TimelineBars cats={cats(2)} bars={[{ kept: 3, archived: 1, rate: 25 }, { kept: 0, archived: 0, rate: 0 }]} />);
  const kept = container.querySelectorAll("rect.bar-kept"); const arch = container.querySelectorAll("rect.bar-archived");
  expect(kept).toHaveLength(2); expect(arch).toHaveLength(2);
  expect(kept[0].getAttribute("fill")).toBe("color-mix(in oklch, var(--highlight) 35%, transparent)");
  expect(arch[0].getAttribute("fill")).toBe("var(--highlight)");
  expect(Number(arch[0].getAttribute("y")) + Number(arch[0].getAttribute("height"))).toBeCloseTo(Number(kept[0].getAttribute("y")));
  expect(Number(kept[1].getAttribute("height"))).toBe(0);
  expect(container.querySelector('[role="tooltip"]')).toBeNull();
  fireEvent.mouseMove(container.querySelector("rect.bar-hit")!);
  const lines = Array.from(container.querySelectorAll('[role="tooltip"] div')).map((d) => d.textContent);
  expect(lines).toEqual(["Sep 01", "kept: 3", "archived: 1", "archive rate: 25.0%"]);
  fireEvent.mouseLeave(container.querySelector("rect.bar-hit")!);
  expect(container.querySelector('[role="tooltip"]')).toBeNull();
});
it("TimelineBars renders axes only for no buckets", () => {
  const { container } = render(<TimelineBars cats={[]} bars={[]} />);
  expect(container.querySelector("svg")).toBeTruthy();
  expect(container.querySelectorAll("rect.bar-kept")).toHaveLength(0);
});
it("LineAreaChart draws one line per series, breaks at nulls, fills only area series, tooltips per bucket", () => {
  const { container } = render(<LineAreaChart cats={cats(3)} yMax={100} yTicks={[0, 50, 100]} yFormat={(v) => `${v}%`}
    series={[{ name: "a", color: "var(--panel-caption)", values: [20, null, 60] }, { name: "b", color: "var(--highlight)", values: [5, 6, 7], area: true }]}
    tip={(i) => [`bucket ${i}`]} />);
  const lines = container.querySelectorAll("path.chart-line");
  expect(lines).toHaveLength(2);
  expect((lines[0].getAttribute("d")!.match(/M/g) ?? []).length).toBe(2);
  expect(container.querySelectorAll("path.chart-area")).toHaveLength(1);
  expect(container.querySelectorAll("circle.chart-point")).toHaveLength(5);
  expect(Array.from(container.querySelectorAll("text.chart-tick")).map((t) => t.textContent)).toContain("50%");
  fireEvent.mouseMove(container.querySelectorAll(".chart-hit")[1]);
  expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Sep 02bucket 1");
});
it("LineAreaChart xAxis={false} draws no x labels and dots={false} no points", () => {
  withWidth(1600, () => {
    const { container } = render(<LineAreaChart cats={cats(5)} yMax={10} yTicks={[0, 10]} xAxis={false} dots={false} series={[{ name: "a", color: "red", values: [1, 2, 3, 4, 5] }]} />);
    expect(axisTexts(container)).toHaveLength(0);
    expect(container.querySelectorAll("circle.chart-point")).toHaveLength(0);
  });
});
it("StackedBarChart count mode: stacks raw values on a count axis, explicit colours, one tooltip per column", () => {
  const { container } = render(<StackedBarChart mode="count" cats={cats(2)} legend={false}
    series={[{ name: "Desktop", color: "var(--panel-caption)", values: [3, 0] }, { name: "Phone", color: "var(--highlight)", values: [1, 0] }]}
    tip={(i) => [`col ${i}`]} />);
  const segs = container.querySelectorAll("rect.chart-seg");
  expect(segs).toHaveLength(4);
  expect((segs[0] as SVGElement).style.fill).toBe("var(--panel-caption)");
  expect(container.querySelectorAll(".chart-seg-label")).toHaveLength(0);
  expect(container.querySelector("ul.chart-legend-flow")).toBeNull();
  expect(Array.from(container.querySelectorAll("text.chart-tick")).map((t) => t.textContent)).toContain("4");
  fireEvent.mouseMove(container.querySelectorAll("rect.chart-hit")[1]);
  expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Sep 02col 1");
});
it("StackedBarChart count mode formats a dollar axis", () => {
  const { container } = render(<StackedBarChart mode="count" cats={cats(1)} yFormat={(v) => `$${v}`} series={[{ name: "a", color: "red", values: [0.012] }]} />);
  expect(Array.from(container.querySelectorAll("text.chart-tick")).some((t) => t.textContent?.startsWith("$0.0"))).toBe(true);
});
it("valueTicks: nice non-integer ticks from zero covering the max", async () => {
  const { valueTicks } = await import("./scales");
  const { ticks, top } = valueTicks(0.0123);
  expect(ticks[0]).toBe(0); expect(top).toBeGreaterThanOrEqual(0.0123); expect(ticks.length).toBeGreaterThanOrEqual(3);
  expect(valueTicks(0)).toEqual({ ticks: [0, 1], top: 1 });
});
it("StackedBarChart stacks to 100, tooltips read 'name: n (pct%)', fills differ", () => {
  const series = Array.from({ length: 8 }, (_, i) => ({ name: `cat ${i}`, values: [12.5], counts: [i + 1] }));
  const { container } = render(<StackedBarChart cats={cats(1)} series={series} />);
  const rects = container.querySelectorAll("rect.chart-seg");
  expect(rects).toHaveLength(8);
  expect(new Set(Array.from(rects).map((r) => (r as SVGElement).style.fill)).size).toBe(8);
  fireEvent.mouseMove(rects[2]);
  expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Sep 01cat 2: 3 (12.5%)");
});
it("StackedBarChart legend is an HTML flow list with full labels, outside the svg", () => {
  const a = "User-Specific Page"; const b = "x".repeat(60);
  const { container } = render(<StackedBarChart cats={cats(1)} series={[{ name: a, values: [50], counts: [1] }, { name: b, values: [50], counts: [1] }]} />);
  expect(Array.from(container.querySelectorAll("ul.chart-legend-flow > li")).map((li) => li.textContent)).toEqual([a, b]);
  expect(Array.from(container.querySelectorAll("svg text")).some((t) => (t.textContent ?? "").includes(a))).toBe(false);
});
it("StackedBarChart draws no in-bar labels when bands are narrow, some when wide", () => {
  const s = [{ name: "a", values: Array(20).fill(60), counts: Array(20).fill(6) }, { name: "b", values: Array(20).fill(40), counts: Array(20).fill(4) }];
  withWidth(300, () => { expect(render(<StackedBarChart cats={cats(20)} series={s} />).container.querySelectorAll(".chart-seg-label")).toHaveLength(0); });
  withWidth(1600, () => { expect(render(<StackedBarChart cats={cats(6)} series={[{ name: "a", values: Array(6).fill(60), counts: Array(6).fill(6) }]} />).container.querySelectorAll(".chart-seg-label").length).toBeGreaterThan(0); });
});
it("every chart sizes its viewBox to the measured width", () => {
  withWidth(900, () => {
    const { container } = render(<><TimelineBars cats={cats(1)} bars={[{ kept: 1, archived: 0, rate: 0 }]} /><LineAreaChart cats={cats(1)} yMax={100} yTicks={[0]} series={[{ name: "a", color: "red", values: [1] }]} /><StackedBarChart cats={cats(1)} series={[{ name: "a", values: [100], counts: [1] }]} /></>);
    expect(Array.from(container.querySelectorAll("svg")).map((s) => s.getAttribute("viewBox"))).toEqual(["0 0 900 240", "0 0 900 240", "0 0 900 240"]);
  });
});
it("x labels thin by pixel spacing: dense when wide, fewer when narrow, none when tiny, always distinct", () => {
  const count = (w: number) => { let out: (string | null)[] = []; withWidth(w, () => { out = axisTexts(render(<TimelineBars cats={cats(30)} bars={Array(30).fill({ kept: 1, archived: 1, rate: 50 })} />).container); }); return out; };
  expect(count(1600).length).toBeGreaterThan(count(500).length);
  expect(count(100)).toHaveLength(0);
  const wide = count(1600); expect(new Set(wide).size).toBe(wide.length);
});
it("thinBandLabels keeps only labelled bands >= minSpacing apart and drops repeats", () => {
  const labels = ["Sep 28", null, null, null, "Sep 28", "Sep 29", null, "Sep 30"];
  expect(thinBandLabels(labels, 50, 100)).toEqual([0, 5, 7]);
});
it("seriesFill rotates hue and differs for neighbours", () => {
  expect(seriesFill(0, 4)).not.toBe(seriesFill(1, 4));
});
it("countTicks never yields fractional counts, 0..max in steps of 1 for small maxima", () => {
  for (const m of [0, 1, 2, 3, 4, 5, 7, 12, 99, 1000]) {
    const { ticks, top } = countTicks(m);
    expect(ticks.every(Number.isInteger)).toBe(true);
    expect(top).toBeGreaterThanOrEqual(m);
    expect(ticks[0]).toBe(0);
  }
  expect(countTicks(2).ticks).toEqual([0, 1, 2]);
  expect(countTicks(3).ticks).toEqual([0, 1, 2, 3]);
  expect(countTicks(1).ticks).toEqual([0, 1]);
});
it("week labels get wider spacing so 'wk of Sep 22' never runs together at 700px", () => {
  const week = Array.from({ length: 13 }, (_, i) => ({ title: `wk ${i}`, axis: `wk of Sep ${String(10 + i).padStart(2, "0")}` as string | null }));
  let texts: (string | null)[] = [];
  withWidth(700, () => { texts = axisTexts(render(<TimelineBars cats={week} bars={Array(13).fill({ kept: 1, archived: 0, rate: 0 })} />).container); });
  expect(texts.length).toBeGreaterThan(1);
  // 700 - margins = 640px plot / 13 bands ~ 49px pitch: labels must sit >= 96px apart
  expect(texts.length).toBeLessThanOrEqual(Math.floor(640 / 96) + 1);
  expect(labelSpacing(["wk of Sep 22", null])).toBeGreaterThanOrEqual(96);
  expect(labelSpacing(["Sep 22", null])).toBe(76);
});

it("categoryColors: named ids take their index's colour, uncategorized is the neutral grey", async () => {
  const { categoryColors, categoryFill, UNCATEGORIZED_FILL } = await import("./palette");
  const c = categoryColors(["a", "uncategorized", "b"]);
  expect(c.uncategorized).toBe(UNCATEGORIZED_FILL);
  expect(c.a).toBe(categoryFill(0));
  expect(c.b).toBe(categoryFill(1));
});
it("categoryColors: 14 ids, no hue within 30 degrees of the highlight, every pair differs by >=35 deg hue or >=0.15 lightness", async () => {
  const { categoryColors } = await import("./palette");
  const ids = Array.from({ length: 14 }, (_, i) => `c${i}`);
  const c = categoryColors(ids);
  const parsed = ids.map((id) => {
    const m = /calc\(l ([+-]) ([\d.]+)\).*calc\(h \+ (\d+)\)/.exec(c[id])!;
    return { h: Number(m[3]), l: (m[1] === "-" ? -1 : 1) * Number(m[2]) };
  });
  for (const { h } of parsed) { expect(Math.min(h % 360, 360 - (h % 360))).toBeGreaterThanOrEqual(30); expect(h).toBeGreaterThanOrEqual(60); }
  expect(new Set(ids.map((id) => c[id])).size).toBe(14);
  for (let i = 0; i < 14; i++) for (let j = i + 1; j < 14; j++) {
    const dh = Math.abs(parsed[i].h - parsed[j].h), dl = Math.abs(parsed[i].l - parsed[j].l);
    expect(dh >= 35 || dl >= 0.15 - 1e-9, `${i}/${j}`).toBe(true);
  }
});
it("placeTooltip: beside the pointer, flips left / above at the wrapper edge, clamps inside it", async () => {
  const { placeTooltip } = await import("./ChartTooltip");
  expect(placeTooltip(100, 50, 1000, 400, 200, 80)).toEqual({ x: 112, y: 62 });
  expect(placeTooltip(900, 50, 1000, 400, 200, 80)).toEqual({ x: 688, y: 62 }); // 912 + 200 > 1000 -> left of the pointer
  expect(placeTooltip(100, 380, 1000, 400, 200, 80)).toEqual({ x: 112, y: 288 }); // flips above
  expect(placeTooltip(150, 50, 300, 400, 290, 80)).toEqual({ x: 0, y: 62 }); // too wide either side -> clamped to the edge
  expect(placeTooltip(100, 50, 0, 0, 200, 80)).toEqual({ x: 112, y: 62 }); // no wrapper: no clamping
});
