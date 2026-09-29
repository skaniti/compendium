import { it, expect } from "vitest";
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
