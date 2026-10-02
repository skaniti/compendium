import { labelSpacing, thinBandLabels, type BandCat } from "./scales";
import type { ScaleBand } from "d3-scale";
/** Thinned x tick labels for a band scale; none when the plot is too narrow for two. */
export default function BandAxis({ cats, x, innerW, innerH }: { cats: BandCat[]; x: ScaleBand<string>; innerW: number; innerH: number }) {
  const labels = cats.map((c) => c.axis);
  const spacing = labelSpacing(labels);
  if (cats.length === 0 || innerW < 2 * spacing) return null;
  const keep = thinBandLabels(labels, x.step(), spacing);
  return <>{keep.map((i) => (
    <text key={i} className="chart-tick chart-xlabel" x={(x(String(i)) ?? 0) + x.bandwidth() / 2} y={innerH + 14} textAnchor="middle">{cats[i].axis}</text>
  ))}</>;
}
