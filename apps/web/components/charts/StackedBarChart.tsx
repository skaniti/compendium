import { MARGIN, frame, xBand, yLinear, MIN_LABEL_SPACING } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
export interface StackSeries { name: string; values: number[] }
/** Series i of n: hue rotated around --highlight; odd series also get lighter so neighbours differ in hue and lightness. */
export function seriesFill(i: number, n: number): string {
  const dh = Math.round((i * 360) / Math.max(n, 2));
  return `oklch(from var(--highlight) ${i % 2 ? "calc(l + 0.08)" : "l"} c calc(h + ${dh}))`;
}
export default function StackedBarChart({ days, series, height = 240, yTitle = "% of skips" }:
  { days: string[]; series: StackSeries[]; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height);
  const x = xBand(days, innerW); const y = yLinear(100, innerH);
  const fill = (i: number) => seriesFill(i, series.length);
  const showLabel = (v: number, h: number) => v >= 10 && h >= 12 && x.bandwidth() >= 26; // otherwise the tooltip carries it
  const labelStep = Math.max(1, Math.ceil(MIN_LABEL_SPACING.band / x.bandwidth())); // every k-th band
  const showTicks = innerW >= 120; // narrower: the tooltip carries the date
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {[0, 25, 50, 75, 100].map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}%</text></g>))}
        {days.map((d, di) => { let acc = 0; return (
          <g key={d} transform={`translate(${x(d) ?? 0},0)`}>
            {series.map((s, si) => { const v = s.values[di] ?? 0; const y0 = acc; acc += v; const h = y(y0) - y(acc); return (
              <g key={s.name}>
                <rect className="chart-seg" y={y(acc)} width={x.bandwidth()} height={h} style={{ fill: fill(si) }} stroke="var(--bg)" strokeWidth={1} onMouseEnter={(e) => show(e, [d, `${s.name}: ${v.toFixed(1)}%`])} onMouseMove={(e) => show(e, [d, `${s.name}: ${v.toFixed(1)}%`])} onMouseLeave={hide} />
                {showLabel(v, h) && <text pointerEvents="none" x={x.bandwidth() / 2} y={y(acc) + h / 2} dy="0.35em" textAnchor="middle" className="chart-seg-label">{`${Math.round(v)}%`}</text>}
              </g>); })}
            {showTicks && di % labelStep === 0 && <text x={x.bandwidth() / 2} y={innerH + 14} textAnchor="middle" className="chart-tick">{d.slice(5)}</text>}
          </g>); })}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    <ul className="chart-legend-flow">
      {series.map((s, si) => (<li key={s.name}><span className="swatch" style={{ background: fill(si) }} />{s.name}</li>))}
    </ul>
    {tooltip}
    </div>
  );
}
