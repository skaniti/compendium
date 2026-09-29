import { DEFAULT_WIDTH, MARGIN, frame, xTime, yLinear, fmtISODate } from "./scales";
export interface BarPoint { x: Date; y: number; label: string }
export default function BarChart({ points, yMax, yTicks, ySuffix = "", height = 240, yTitle = "", xTitle = "" }:
  { points: BarPoint[]; yMax: number; yTicks: number[]; ySuffix?: string; height?: number; yTitle?: string; xTitle?: string }) {
  const width = DEFAULT_WIDTH; const { innerW, innerH } = frame(width, height);
  const x = xTime(points.map((p) => p.x), innerW); const y = yLinear(yMax, innerH);
  const span = x.domain()[1].getTime() - x.domain()[0].getTime();
  const barMs = Math.min((span / Math.max(points.length, 1)) * 0.85, 12 * 3600 * 1000); // Dash _bar_width_ms
  const barW = Math.max(1, (barMs / span) * innerW);
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle || "bar chart"}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}{ySuffix}</text></g>))}
        {x.ticks(6).map((d, i) => (<text key={i} x={x(d)} y={innerH + 14} textAnchor="end" transform={`rotate(-45 ${x(d)} ${innerH + 14})`} className="chart-tick">{fmtISODate(d)}</text>))}
        {points.map((p, i) => (<rect key={i} className="chart-bar" x={x(p.x) - barW / 2} y={y(p.y)} width={barW} height={innerH - y(p.y)} fill="var(--primary)"><title>{`${p.label}\n${fmtISODate(p.x)}\n${p.y.toFixed(1)}${ySuffix}`}</title></rect>))}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
        {xTitle && <text x={innerW / 2} y={innerH + MARGIN.bottom - 2} textAnchor="middle" className="chart-axis-title">{xTitle}</text>}
      </g>
    </svg>
  );
}
