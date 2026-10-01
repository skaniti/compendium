import { MARGIN, frame, xBand, yLinear } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
export interface StackSeries { name: string; values: number[] }
// 8-step categorical palette built from theme tokens (CSS vars cannot rotate hue, so mix toward --primary / --panel-caption).
export const PALETTE = [
  "var(--highlight)",
  "color-mix(in oklch, var(--highlight) 70%, var(--primary))",
  "color-mix(in oklch, var(--highlight) 45%, var(--primary))",
  "color-mix(in oklch, var(--highlight) 70%, var(--panel-caption))",
  "color-mix(in oklch, var(--highlight) 45%, var(--panel-caption))",
  "color-mix(in oklch, var(--highlight) 25%, var(--primary))",
  "color-mix(in oklch, var(--highlight) 25%, var(--panel-caption))",
  "var(--accent)",
];
const LEGEND_MAX = 35;
/** Legend labels truncated to LEGEND_MAX chars; labels that collide once truncated fall back to head...tail, then to the full name. */
export function legendLabels(names: string[]): string[] {
  const clip = (n: string) => (n.length > LEGEND_MAX ? `${n.slice(0, LEGEND_MAX)}…` : n);
  const tail = (n: string) => (n.length > LEGEND_MAX ? `${n.slice(0, 10)}…${n.slice(-(LEGEND_MAX - 11))}` : n);
  const dup = (labels: string[], i: number) => labels.some((l, j) => j !== i && l === labels[i] && names[j] !== names[i]);
  const first = names.map(clip);
  const second = names.map((n, i) => (dup(first, i) ? tail(n) : first[i]));
  return second.map((l, i) => (dup(second, i) ? names[i] : l));
}
const LEGEND_W = 230; // fits a 35-char 10px monospace label (~210px) plus swatch
export default function StackedBarChart({ days, series, height = 240, yTitle = "% of skips" }:
  { days: string[]; series: StackSeries[]; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW: fullW, innerH } = frame(width, height); const innerW = Math.max(1, fullW - LEGEND_W);
  const x = xBand(days, innerW); const y = yLinear(100, innerH);
  const labels = legendLabels(series.map((s) => s.name));
  const fill = (i: number) => PALETTE[i % PALETTE.length]; // series order -> categorical fill
  const showLabel = (v: number, h: number) => v >= 10 && h >= 12 && x.bandwidth() >= 26; // otherwise the tooltip carries it
  const labelStep = Math.max(1, Math.ceil(days.length / 6));
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {[0, 25, 50, 75, 100].map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}%</text></g>))}
        {days.map((d, di) => { let acc = 0; return (
          <g key={d} transform={`translate(${x(d) ?? 0},0)`}>
            {series.map((s, si) => { const v = s.values[di] ?? 0; const y0 = acc; acc += v; const h = y(y0) - y(acc); return (
              <g key={s.name}>
                <rect className="chart-seg" y={y(acc)} width={x.bandwidth()} height={h} fill={fill(si)} stroke="var(--bg)" strokeWidth={1} onMouseEnter={(e) => show(e, [d, `${s.name}: ${v.toFixed(1)}%`])} onMouseMove={(e) => show(e, [d, `${s.name}: ${v.toFixed(1)}%`])} onMouseLeave={hide} />
                {showLabel(v, h) && <text pointerEvents="none" x={x.bandwidth() / 2} y={y(acc) + h / 2} dy="0.35em" textAnchor="middle" className="chart-seg-label">{`${Math.round(v)}%`}</text>}
              </g>); })}
            {di % labelStep === 0 && <text x={x.bandwidth() / 2} y={innerH + 14} textAnchor="middle" className="chart-tick">{d.slice(5)}</text>}
          </g>); })}
        <g transform={`translate(${innerW + 12},0)`}>
          {series.map((s, si) => (<g key={s.name} transform={`translate(0,${si * 16})`} onMouseEnter={(e) => show(e, [s.name])} onMouseMove={(e) => show(e, [s.name])} onMouseLeave={hide}><rect width={10} height={10} fill={fill(si)} /><text x={14} y={9} className="chart-legend">{labels[si]}</text></g>))}
        </g>
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    {tooltip}
    </div>
  );
}
