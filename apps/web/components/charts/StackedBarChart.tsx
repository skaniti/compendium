import { MARGIN, frame, xBand, yLinear } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
export interface StackSeries { name: string; values: number[] }
const LEGEND_W = 230; // fits a 35-char 10px monospace label (~210px) plus swatch
export default function StackedBarChart({ days, series, height = 240, yTitle = "% of skips" }:
  { days: string[]; series: StackSeries[]; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { innerW: fullW, innerH } = frame(width, height); const innerW = Math.max(1, fullW - LEGEND_W);
  const x = xBand(days, innerW); const y = yLinear(100, innerH);
  const n = Math.max(series.length - 1, 1);
  // Dash gradient: i-th of n reasons -> lighter/desaturated variant of --highlight via opacity steps
  const opacity = (i: number) => 0.65 - 0.35 * (i / n) + 0.1;
  const labelStep = Math.max(1, Math.ceil(days.length / 6));
  return (
    <div ref={ref} style={{ width: "100%" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {[0, 25, 50, 75, 100].map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}%</text></g>))}
        {days.map((d, di) => { let acc = 0; return (
          <g key={d} transform={`translate(${x(d) ?? 0},0)`}>
            {series.map((s, si) => { const v = s.values[di] ?? 0; const y0 = acc; acc += v; const h = y(y0) - y(acc); return (
              <g key={s.name}>
                <rect className="chart-seg" y={y(acc)} width={x.bandwidth()} height={h} fill="var(--highlight)" fillOpacity={opacity(si)} stroke="var(--highlight)" strokeWidth={1}><title>{`${d}\n${s.name}: ${v.toFixed(1)}%`}</title></rect>
                {v >= 10 && h > 10 && <text x={x.bandwidth() / 2} y={y(acc) + h / 2} dy="0.35em" textAnchor="middle" className="chart-seg-label">{`${Math.round(v)}%`}</text>}
              </g>); })}
            {di % labelStep === 0 && <text x={x.bandwidth() / 2} y={innerH + 14} textAnchor="middle" className="chart-tick">{d.slice(5)}</text>}
          </g>); })}
        <g transform={`translate(${innerW + 12},0)`}>
          {series.map((s, si) => (<g key={s.name} transform={`translate(0,${si * 16})`}><rect width={10} height={10} fill="var(--highlight)" fillOpacity={opacity(si)} /><text x={14} y={9} className="chart-legend">{s.name.length > 35 ? `${s.name.slice(0, 35)}…` : s.name}</text></g>))}
        </g>
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    </div>
  );
}
