import { MARGIN as BASE, frame, xTime, yLinear, fmtISODate } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
const MARGIN = { ...BASE, bottom: 80 }; // room for 10-char labels rotated -45 degrees plus the x title
export interface BarPoint { x: Date; y: number; label: string }
export default function BarChart({ points, yMax, yTicks, ySuffix = "", height = 240, yTitle = "", xTitle = "" }:
  { points: BarPoint[]; yMax: number; yTicks: number[]; ySuffix?: string; height?: number; yTitle?: string; xTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height, MARGIN);
  const x = xTime(points.map((p) => p.x), innerW); const y = yLinear(yMax, innerH);
  const span = Math.max(1, x.domain()[1].getTime() - x.domain()[0].getTime());
  const barMs = Math.min((span / Math.max(points.length, 1)) * 0.85, 12 * 3600 * 1000); // Dash _bar_width_ms
  const barW = Math.max(1, (barMs / span) * innerW);
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle || "bar chart"}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}{ySuffix}</text></g>))}
        {points.length > 0 && x.ticks(6).map((d, i) => (<text key={i} x={x(d)} y={innerH + 14} textAnchor="end" transform={`rotate(-45 ${x(d)} ${innerH + 14})`} className="chart-tick">{fmtISODate(d)}</text>))}
        {points.map((p, i) => (<rect key={i} className="chart-bar" x={x(p.x) - barW / 2} y={y(p.y)} width={barW} height={innerH - y(p.y)} fill="var(--primary)" onMouseEnter={(e) => show(e, [p.label, fmtISODate(p.x), `${p.y.toFixed(1)}${ySuffix}`])} onMouseMove={(e) => show(e, [p.label, fmtISODate(p.x), `${p.y.toFixed(1)}${ySuffix}`])} onMouseLeave={hide} />))}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
        {xTitle && <text x={innerW / 2} y={innerH + MARGIN.bottom - 6} textAnchor="middle" className="chart-axis-title">{xTitle}</text>}
      </g>
    </svg>
    {tooltip}
    </div>
  );
}
