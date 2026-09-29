import { it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import BarChart from "./BarChart";
import LineAreaChart from "./LineAreaChart";
import StackedBarChart from "./StackedBarChart";
const d = (s: string) => new Date(`${s}T00:00:00`);
it("BarChart draws one rect per point and y ticks with suffix", () => {
  const { container, getByText } = render(<BarChart points={[{ x: d("2026-08-01"), y: 50, label: "cap_1" }, { x: d("2026-08-02"), y: 100, label: "cap_2" }]} yMax={105} yTicks={[0, 25, 50, 75, 100]} ySuffix="%" />);
  expect(container.querySelectorAll("rect.chart-bar")).toHaveLength(2);
  expect(getByText("100%")).toBeInTheDocument();
  expect(container.querySelector("rect.chart-bar title")?.textContent).toContain("cap_1");
});
it("LineAreaChart draws a path and an area and hover titles", () => {
  const { container } = render(<LineAreaChart points={[{ x: d("2026-08-01"), y: 33.3, hover: "33.3% 1/3" }, { x: d("2026-08-02"), y: 0, hover: "0% 0/2" }]} yMax={110} yTicks={[0, 25, 50, 75, 100]} ySuffix="%" />);
  expect(container.querySelector("path.chart-line")).toBeTruthy();
  expect(container.querySelector("path.chart-area")).toBeTruthy();
  expect(container.querySelectorAll("circle.chart-point")).toHaveLength(2);
  expect(container.querySelector("circle.chart-point title")?.textContent).toContain("33.3% 1/3");
});
it("LineAreaChart keeps first and last points inside the plot", () => {
  const { container } = render(<LineAreaChart points={[1, 2, 3].map((n) => ({ x: d(`2026-08-0${n}`), y: 10, hover: "h" }))} yMax={110} yTicks={[0, 100]} />);
  const innerW = 640 - 44 - 16;
  const cx = Array.from(container.querySelectorAll("circle.chart-point")).map((c) => Number(c.getAttribute("cx")));
  expect(cx[0]).toBeGreaterThan(0);
  expect(cx[2]).toBeLessThan(innerW);
});
it("LineAreaChart shows always-on labels at <= 10 points and none above", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ x: d(`2026-08-${String(i + 1).padStart(2, "0")}`), y: 10 * i, hover: "h", labelTop: `${10 * i}%`, labelBottom: `${i}/10` }));
  const small = render(<LineAreaChart points={mk(10)} yMax={110} yTicks={[0, 100]} ySuffix="%" />);
  expect(small.container.querySelectorAll(".chart-point-label")).toHaveLength(10);
  const big = render(<LineAreaChart points={mk(11)} yMax={110} yTicks={[0, 100]} ySuffix="%" />);
  expect(big.container.querySelectorAll(".chart-point-label")).toHaveLength(0);
});
it("StackedBarChart stacks to 100 and labels segments >= 10", () => {
  const { container, getByText, queryByText } = render(<StackedBarChart days={["2026-08-01"]} series={[{ name: "login wall", values: [92] }, { name: "stub", values: [8] }]} />);
  expect(container.querySelectorAll("rect.chart-seg")).toHaveLength(2);
  expect(getByText("92%")).toBeInTheDocument();
  expect(queryByText("8%")).toBeNull();
  expect(getByText("login wall")).toBeInTheDocument(); // legend
});
it("charts render nothing harmful on a single point", () => {
  const { container } = render(<BarChart points={[{ x: d("2026-08-01"), y: 10, label: "one" }]} yMax={105} yTicks={[0, 100]} ySuffix="%" />);
  expect(container.querySelectorAll("rect.chart-bar")).toHaveLength(1);
});
it("BarChart and LineAreaChart render axes only for empty points", () => {
  const bar = render(<BarChart points={[]} yMax={105} yTicks={[0, 100]} ySuffix="%" />);
  expect(bar.container.querySelector("svg")).toBeTruthy();
  expect(bar.container.querySelectorAll("rect.chart-bar")).toHaveLength(0);
  const line = render(<LineAreaChart points={[]} yMax={110} yTicks={[0, 100]} ySuffix="%" />);
  expect(line.container.querySelector("svg")).toBeTruthy();
  expect(line.container.querySelectorAll("circle.chart-point")).toHaveLength(0);
});
it("LineAreaChart moves both labels above a point on the baseline", () => {
  const { container } = render(<LineAreaChart height={240} points={[{ x: d("2026-08-01"), y: 0, hover: "h", labelTop: "0%", labelBottom: "0/2" }, { x: d("2026-08-02"), y: 50, hover: "h", labelTop: "50%", labelBottom: "1/2" }]} yMax={110} yTicks={[0, 100]} ySuffix="%" />);
  const innerH = 240 - 12 - 36;
  const labels = container.querySelectorAll(".chart-point-label");
  const base = Array.from(labels[0].querySelectorAll("text")).map((t) => Number(t.getAttribute("y")));
  expect(base.every((yy) => yy < innerH - 16)).toBe(true);
  const mid = Array.from(labels[1].querySelectorAll("text")).map((t) => Number(t.getAttribute("y")));
  expect(mid[1]).toBeGreaterThan(mid[0]); // unflipped: bottom label sits below the top label
});
it("charts size their viewBox to the measured container width", () => {
  let cb: ResizeObserverCallback = () => {};
  class RO { constructor(c: ResizeObserverCallback) { cb = c; } observe() { cb([{ contentRect: { width: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} }
  vi.stubGlobal("ResizeObserver", RO);
  try {
    const { container } = render(<><BarChart points={[{ x: d("2026-08-01"), y: 1, label: "a" }]} yMax={105} yTicks={[0]} /><LineAreaChart points={[{ x: d("2026-08-01"), y: 1, hover: "h" }]} yMax={110} yTicks={[0]} /><StackedBarChart days={["2026-08-01"]} series={[{ name: "a", values: [100] }]} /></>);
    const boxes = Array.from(container.querySelectorAll("svg")).map((s) => s.getAttribute("viewBox"));
    expect(boxes).toEqual(["0 0 900 240", "0 0 900 240", "0 0 900 240"]);
  } finally { vi.unstubAllGlobals(); }
});
