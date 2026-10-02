import { MARGIN, frame, xBand, yLinear, type BandCat } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
import BandAxis from "./BandAxis";
import { seriesFill } from "./palette";
/** values = share of the bucket in percent (columns sum to 100); counts = the raw numbers behind them. */
export interface StackSeries { name: string; values: number[]; counts: number[] }
export default function StackedBarChart({ cats, series, height = 240, yTitle = "% of gate skips" }:
  { cats: BandCat[]; series: StackSeries[]; height?: number; yTitle?: string }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height);
  const x = xBand(cats.length, innerW); const y = yLinear(100, innerH);
  const fill = (i: number) => seriesFill(i, series.length);
  const showLabel = (v: number, h: number) => v >= 10 && h >= 12 && x.bandwidth() >= 26; // otherwise the tooltip carries it
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={yTitle}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {[0, 25, 50, 75, 100].map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{t}%</text></g>))}
        <BandAxis cats={cats} x={x} innerW={innerW} innerH={innerH} />
        {cats.map((c, bi) => { let acc = 0; return (
          <g key={bi} transform={`translate(${x(String(bi)) ?? 0},0)`}>
            {series.map((s, si) => { const v = s.values[bi] ?? 0; const n = s.counts[bi] ?? 0; const y0 = acc; acc += v; const h = y(y0) - y(acc);
              const tip = (e: React.MouseEvent) => show(e, [c.title, `${s.name}: ${n} (${v.toFixed(1)}%)`]);
              return (
              <g key={s.name}>
                <rect className="chart-seg" y={y(acc)} width={x.bandwidth()} height={h} style={{ fill: fill(si) }} stroke="var(--bg)" strokeWidth={1} onMouseEnter={tip} onMouseMove={tip} onMouseLeave={hide} />
                {showLabel(v, h) && <text pointerEvents="none" x={x.bandwidth() / 2} y={y(acc) + h / 2} dy="0.35em" textAnchor="middle" className="chart-seg-label">{`${Math.round(v)}%`}</text>}
              </g>); })}
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
