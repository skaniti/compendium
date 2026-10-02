import { scaleLinear, scaleBand } from "d3-scale";
export const MARGIN = { top: 12, right: 16, bottom: 36, left: 44 };
export const DEFAULT_WIDTH = 640; // SSR/jsdom fallback width; live width comes from useContainerWidth (1 viewBox unit = 1px)
/** Minimum horizontal px per x-axis label ("wk of Sep 22" is the widest), so labels thin out (then vanish) instead of overlapping; the tooltip carries the date. */
export const MIN_LABEL_SPACING = { band: 76 };
export type Margin = typeof MARGIN;
/** One x-axis category per bucket: `title` heads the tooltip, `axis` is the tick label (null = none for this bucket). */
export interface BandCat { title: string; axis: string | null }
export function frame(width: number, height: number, margin: Margin = MARGIN) {
  return { innerW: Math.max(1, width - margin.left - margin.right), innerH: Math.max(1, height - margin.top - margin.bottom) };
}
export function yLinear(max: number, innerH: number) {
  return scaleLinear().domain([0, max]).range([innerH, 0]);
}
/** Band scale over bucket indexes (as strings), so empty buckets keep their slot. */
export function xBand(count: number, innerW: number) {
  return scaleBand<string>().domain(Array.from({ length: count }, (_, i) => String(i))).range([0, innerW]).paddingInner(0.15);
}
/** Indexes of the labels to draw: labelled bands only, each at least minSpacing px (band pitch * index gap) after the last kept one, never repeating its text. */
export function thinBandLabels(labels: (string | null)[], pitch: number, minSpacing: number): number[] {
  const out: number[] = []; let lastIdx = -Infinity; let lastLabel = "";
  labels.forEach((l, i) => {
    if (l === null || l === lastLabel || (i - lastIdx) * pitch < minSpacing) return;
    out.push(i); lastIdx = i; lastLabel = l;
  });
  return out;
}
/** Y axis for counts: nice ticks (about 4) and the matching top. */
export function countTicks(max: number): { ticks: number[]; top: number } {
  const ticks = scaleLinear().domain([0, Math.max(1, max)]).nice(4).ticks(4);
  return { ticks, top: ticks[ticks.length - 1] };
}
