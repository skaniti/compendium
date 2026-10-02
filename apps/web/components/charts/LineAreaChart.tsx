import { area, line, curveLinear } from "d3-shape";
import { MARGIN, frame, xBand, yLinear, type BandCat } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
import BandAxis from "./BandAxis";
/** y = null breaks the line (no data in that bucket); `tip` lines follow the bucket title in the tooltip. */
export interface LinePoint { y: number | null; tip: string[] }
export default function LineAreaChart({ cats, points, yMax, yTicks, ySuffix = "", height = 240, yTitle = "" }:
  { cats: BandCat[]; points: LinePoint[]; yMax: number; yTicks: number[]; ySuffix?: string; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height);
  const x = xBand(points.length, innerW); const y = yLinear(yMax, innerH);
  const cx = (i: number) => (x(String(i)) ?? 0) + x.bandwidth() / 2;
  const idx = points.map((_, i) => i);
  const ln = line<number>().defined((i) => points[i].y !== null).x(cx).y((i) => y(points[i].y ?? 0)).curve(curveLinear);
  const ar = area<number>().defined((i) => points[i].y !== null).x(cx).y0(innerH).y1((i) => y(points[i].y ?? 0));
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle || "line chart"}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}{ySuffix}</text></g>))}
        <BandAxis cats={cats} x={x} innerW={innerW} innerH={innerH} />
        <path className="chart-area" d={ar(idx) ?? ""} fill="var(--highlight)" fillOpacity={0.15} />
        <path className="chart-line" d={ln(idx) ?? ""} fill="none" stroke="var(--highlight)" strokeWidth={2} />
        {idx.map((i) => points[i].y !== null && (<circle key={i} className="chart-point" cx={cx(i)} cy={y(points[i].y ?? 0)} r={3} fill="var(--highlight)" />))}
        {idx.map((i) => {
          const tip = (e: React.MouseEvent) => show(e, [cats[i]?.title ?? "", ...points[i].tip]);
          return <rect key={`h${i}`} className="chart-hit" x={x(String(i)) ?? 0} width={x.bandwidth()} y={0} height={innerH} fill="transparent" onMouseEnter={tip} onMouseMove={tip} onMouseLeave={hide} />;
        })}
        {yTitle && <text transform={`rotate(-90) translate(${-innerH / 2},${-MARGIN.left + 12})`} textAnchor="middle" className="chart-axis-title">{yTitle}</text>}
      </g>
    </svg>
    {tooltip}
    </div>
  );
}
