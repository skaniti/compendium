import { area, line, curveLinear } from "d3-shape";
import { MARGIN, frame, xTime, yLinear, fmtMonthDay } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
export interface LinePoint { x: Date; y: number; hover: string; labelTop?: string; labelBottom?: string }
export const ALWAYS_ON_LABEL_MAX = 10; // D5 ruling: labels on every point at <= 10 points, hover-only above
export default function LineAreaChart({ points, yMax, yTicks, ySuffix = "", height = 240, yTitle = "" }:
  { points: LinePoint[]; yMax: number; yTicks: number[]; ySuffix?: string; height?: number; yTitle?: string }) {
  const alwaysOn = points.length <= ALWAYS_ON_LABEL_MAX;
  const [ref, width] = useContainerWidth(); const { innerW, innerH } = frame(width, height);
  const x = xTime(points.map((p) => p.x), innerW); const y = yLinear(yMax, innerH);
  const ln = line<LinePoint>().x((p) => x(p.x)).y((p) => y(p.y)).curve(curveLinear);
  const ar = area<LinePoint>().x((p) => x(p.x)).y0(innerH).y1((p) => y(p.y));
  return (
    <div ref={ref} style={{ width: "100%" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle || "line chart"}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}{ySuffix}</text></g>))}
        {points.length > 0 && x.ticks(6).map((d, i) => (<text key={i} x={x(d)} y={innerH + 14} textAnchor="middle" className="chart-tick">{fmtMonthDay(d)}</text>))}
        <path className="chart-area" d={ar(points) ?? ""} fill="var(--highlight)" fillOpacity={0.15} />
        <path className="chart-line" d={ln(points) ?? ""} fill="none" stroke="var(--highlight)" strokeWidth={2} />
        {points.map((p, i) => (<circle key={i} className="chart-point" cx={x(p.x)} cy={y(p.y)} r={3} fill="var(--highlight)"><title>{`${fmtMonthDay(p.x)}\n${p.hover}`}</title></circle>))}
        {alwaysOn && points.map((p, i) => {
          const py = y(p.y); const flip = py > innerH - 16; // near the baseline: put both labels above the point
          return (
            <g key={`l${i}`} className="chart-point-label">
              {p.labelTop && <text x={x(p.x)} y={flip ? py - 32 : py - 8} textAnchor="middle" className="chart-tick chart-label-strong">{p.labelTop}</text>}
              {p.labelBottom && <text x={x(p.x)} y={flip ? py - 20 : py + 14} textAnchor="middle" className="chart-tick">{p.labelBottom}</text>}
            </g>);
        })}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    </div>
  );
}
