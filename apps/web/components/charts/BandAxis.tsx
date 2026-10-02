import { MIN_LABEL_SPACING, thinBandLabels, type BandCat } from "./scales";
import type { ScaleBand } from "d3-scale";
/** Thinned x tick labels for a band scale; none when the plot is too narrow for two. */
export default function BandAxis({ cats, x, innerW, innerH }: { cats: BandCat[]; x: ScaleBand<string>; innerW: number; innerH: number }) {
  if (cats.length === 0 || innerW < 2 * MIN_LABEL_SPACING.band) return null;
  const keep = thinBandLabels(cats.map((c) => c.axis), x.step(), MIN_LABEL_SPACING.band);
  return <>{keep.map((i) => (
    <text key={i} className="chart-tick chart-xlabel" x={(x(String(i)) ?? 0) + x.bandwidth() / 2} y={innerH + 14} textAnchor="middle">{cats[i].axis}</text>
  ))}</>;
}
