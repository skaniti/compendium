import { scaleLinear, scaleTime, scaleBand } from "d3-scale";
export const MARGIN = { top: 12, right: 16, bottom: 36, left: 44 };
export const DEFAULT_WIDTH = 640; // SSR/jsdom fallback width; live width comes from useContainerWidth (1 viewBox unit = 1px)
/** Minimum horizontal px per x-axis label, so labels thin out (then vanish) instead of overlapping; the tooltip carries the date. */
export const MIN_LABEL_SPACING = {
  rotatedDate: 56, // a 10-char ISO date rotated -45deg needs ~56px of horizontal room
  monthDay: 64, // horizontal "Mon DD"
  band: 44, // "MM-DD" under a stacked-bar band
};
export type Margin = typeof MARGIN;
export function frame(width: number, height: number, margin: Margin = MARGIN) {
  return { innerW: Math.max(1, width - margin.left - margin.right), innerH: Math.max(1, height - margin.top - margin.bottom) };
}
export function xTime(dates: Date[], innerW: number) {
  if (dates.length === 0) return scaleTime().domain([new Date(0), new Date(1)]).range([0, innerW]); // empty: axes only
  const min = dates.reduce((a, b) => (b < a ? b : a), dates[0]);
  const max = dates.reduce((a, b) => (b > a ? b : a), dates[0]);
  let pad = 12 * 3600 * 1000; // single point: pad ±12h
  if (dates.length >= 2 && min.getTime() !== max.getTime()) {
    // >= 2 points: pad by half the median spacing so first/last points (and their labels) sit inside the plot
    const ts = dates.map((d) => d.getTime()).sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((g) => g > 0).sort((a, b) => a - b);
    pad = gaps[Math.floor(gaps.length / 2)] / 2;
  }
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
