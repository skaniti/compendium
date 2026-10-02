import { MARGIN, frame, xBand, yLinear, countTicks, type BandCat } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
import BandAxis from "./BandAxis";
export interface ArchiveBar { kept: number; archived: number; rate: number }
const KEPT_FILL = "color-mix(in oklch, var(--highlight) 35%, transparent)";
const ARCHIVED_FILL = "var(--highlight)";
/** Stacked kept (bottom) + archived (top) page counts per bucket on a band scale. */
export default function TimelineBars({ cats, bars, height = 240, yTitle = "Pages" }: { cats: BandCat[]; bars: ArchiveBar[]; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height);
  const { ticks, top } = countTicks(bars.reduce((m, b) => Math.max(m, b.kept + b.archived), 0));
  const x = xBand(bars.length, innerW); const y = yLinear(top, innerH);
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Archive over time">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {ticks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}</text></g>))}
        <BandAxis cats={cats} x={x} innerW={innerW} innerH={innerH} />
        {bars.map((b, i) => {
          const x0 = x(String(i)) ?? 0; const w = x.bandwidth();
          const tip = (e: React.MouseEvent) => show(e, [cats[i]?.title ?? "", `kept: ${b.kept}`, `archived: ${b.archived}`, `archive rate: ${b.rate.toFixed(1)}%`]);
          return (
            <g key={i}>
              <rect className="bar-kept" x={x0} width={w} y={y(b.kept)} height={y(0) - y(b.kept)} fill={KEPT_FILL} />
              <rect className="bar-archived" x={x0} width={w} y={y(b.kept + b.archived)} height={y(b.kept) - y(b.kept + b.archived)} fill={ARCHIVED_FILL} />
              <rect className="bar-hit" x={x0} width={w} y={0} height={innerH} fill="transparent" onMouseEnter={tip} onMouseMove={tip} onMouseLeave={hide} />
            </g>);
        })}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    <ul className="chart-legend-flow">
      <li><span className="swatch" style={{ background: KEPT_FILL }} />Kept</li>
      <li><span className="swatch" style={{ background: ARCHIVED_FILL }} />Archived</li>
    </ul>
    {tooltip}
    </div>
  );
}
