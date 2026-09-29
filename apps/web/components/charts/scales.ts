import { scaleLinear, scaleTime, scaleBand } from "d3-scale";
export const MARGIN = { top: 12, right: 16, bottom: 36, left: 44 };
export const DEFAULT_WIDTH = 640; // viewBox units; the svg is width:100% so it scales with .trends-chart-cell
export function frame(width: number, height: number) {
  return { innerW: width - MARGIN.left - MARGIN.right, innerH: height - MARGIN.top - MARGIN.bottom };
}
export function xTime(dates: Date[], innerW: number) {
  const min = dates.reduce((a, b) => (b < a ? b : a), dates[0]);
  const max = dates.reduce((a, b) => (b > a ? b : a), dates[0]);
  const pad = min.getTime() === max.getTime() ? 12 * 3600 * 1000 : 0; // single point: pad ±12h
  return scaleTime().domain([new Date(min.getTime() - pad), new Date(max.getTime() + pad)]).range([0, innerW]);
}
export function yLinear(max: number, innerH: number) {
  return scaleLinear().domain([0, max]).range([innerH, 0]);
}
export function xBand(keys: string[], innerW: number) {
  return scaleBand<string>().domain(keys).range([0, innerW]).paddingInner(0.15);
}
export const fmtMonthDay = (d: Date) => `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
export const fmtISODate = (d: Date) => d.toISOString().slice(0, 10);
