import { area, line, curveLinear } from "d3-shape";
import { MARGIN, frame, xBand, yLinear, type BandCat, type Margin } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
import BandAxis from "./BandAxis";
/** values[i] = null breaks the line (no data in that bucket); `area` fills under the line at 15%. */
export interface LineSeries { name: string; color: string; values: (number | null)[]; area?: boolean }
export default function LineAreaChart({ cats, series, yMax, yTicks, yFormat = String, height = 240, margin = MARGIN, xAxis = true, dots = true, tip, ariaLabel, yTitle = "" }:
  { cats: BandCat[]; series: LineSeries[]; yMax: number; yTicks: number[]; yFormat?: (v: number) => string; height?: number; margin?: Margin; xAxis?: boolean; dots?: boolean; tip?: (i: number) => string[]; ariaLabel?: string; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height, margin);
  const x = xBand(cats.length, innerW); const y = yLinear(yMax, innerH);
  const cx = (i: number) => (x(String(i)) ?? 0) + x.bandwidth() / 2;
  const idx = cats.map((_, i) => i);
  const lines = (i: number) => tip ? tip(i) : series.map((s) => `${s.name}: ${s.values[i] ?? "—"}`);
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={ariaLabel || yTitle || "line chart"}>
      <g transform={`translate(${margin.left},${margin.top})`}>
        {yTicks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{yFormat(t)}</text></g>))}
        {xAxis && <BandAxis cats={cats} x={x} innerW={innerW} innerH={innerH} />}
        {series.map((s) => {
          const def = (i: number) => s.values[i] !== null && s.values[i] !== undefined;
          const ln = line<number>().defined(def).x(cx).y((i) => y(s.values[i] ?? 0)).curve(curveLinear);
          const ar = area<number>().defined(def).x(cx).y0(innerH).y1((i) => y(s.values[i] ?? 0));
          return (
            <g key={s.name} data-series={s.name}>
              {s.area && <path className="chart-area" d={ar(idx) ?? ""} fill={s.color} fillOpacity={0.15} />}
              <path className="chart-line" d={ln(idx) ?? ""} fill="none" stroke={s.color} strokeWidth={2} />
              {dots && idx.map((i) => def(i) && (<circle key={i} className="chart-point" cx={cx(i)} cy={y(s.values[i] ?? 0)} r={3} fill={s.color} />))}
            </g>);
        })}
        {idx.map((i) => {
          const onTip = (e: React.MouseEvent) => show(e, [cats[i]?.title ?? "", ...lines(i)]);
          return <rect key={`h${i}`} className="chart-hit" x={x(String(i)) ?? 0} width={x.bandwidth()} y={0} height={innerH} fill="transparent" onMouseEnter={onTip} onMouseMove={onTip} onMouseLeave={hide} />;
        })}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-margin.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    {tooltip}
    </div>
  );
}
