import { MARGIN, frame, xBand, yLinear, countTicks, valueTicks, type BandCat, type Margin } from "./scales";
import { useContainerWidth } from "./useContainerWidth";
import { useChartTooltip } from "./ChartTooltip";
import BandAxis from "./BandAxis";
import { seriesFill } from "./palette";
/** share mode: values are percents of the bucket (columns sum to 100) and counts the raw numbers; count mode: values are the raw amounts. */
export interface StackSeries { name: string; values: number[]; counts?: number[]; color?: string }
export default function StackedBarChart({ cats, series, mode = "share", height = 240, yTitle, yFormat, margin = MARGIN, xAxis = true, legend = true, tip }:
  { cats: BandCat[]; series: StackSeries[]; mode?: "share" | "count"; height?: number; yTitle?: string; yFormat?: (v: number) => string; margin?: Margin; xAxis?: boolean; legend?: boolean; tip?: (i: number) => string[] }) {
  const [ref, width] = useContainerWidth(); const { tooltip, show, hide } = useChartTooltip(); const { innerW, innerH } = frame(width, height, margin);
  const share = mode === "share";
  const title = yTitle ?? (share ? "% of gate skips" : "");
  const colMax = cats.reduce((m, _, bi) => Math.max(m, series.reduce((a, s) => a + (s.values[bi] ?? 0), 0)), 0);
  const integral = series.every((s) => s.values.every(Number.isInteger));
  const scale = share ? { ticks: [0, 25, 50, 75, 100], top: 100 } : integral ? countTicks(colMax) : valueTicks(colMax);
  const fmt = yFormat ?? (share ? (v: number) => `${v}%` : String);
  const x = xBand(cats.length, innerW); const y = yLinear(scale.top, innerH);
  const fill = (si: number) => series[si].color ?? seriesFill(si, series.length);
  const showLabel = (v: number, h: number) => share && v >= 10 && h >= 12 && x.bandwidth() >= 26; // otherwise the tooltip carries it
  return (
    <div ref={ref} className="chart-wrap" style={{ width: "100%", position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={title || "stacked bars"}>
      <g transform={`translate(${margin.left},${margin.top})`}>
        {scale.ticks.map((t) => (<g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{fmt(t)}</text></g>))}
        {xAxis && <BandAxis cats={cats} x={x} innerW={innerW} innerH={innerH} />}
        {cats.map((c, bi) => { let acc = 0; return (
          <g key={bi} transform={`translate(${x(String(bi)) ?? 0},0)`}>
            {series.map((s, si) => { const v = s.values[bi] ?? 0; const n = s.counts?.[bi] ?? v; const y0 = acc; acc += v; const h = y(y0) - y(acc);
              const segTip = tip ? undefined : (e: React.MouseEvent) => show(e, [c.title, share ? `${s.name}: ${n} (${v.toFixed(1)}%)` : `${s.name}: ${fmt(v)}`]);
              return (
              <g key={s.name}>
                <rect className="chart-seg" y={y(acc)} width={x.bandwidth()} height={h} style={{ fill: fill(si) }} stroke="var(--bg)" strokeWidth={1} onMouseEnter={segTip} onMouseMove={segTip} onMouseLeave={segTip && hide} />
                {showLabel(v, h) && <text pointerEvents="none" x={x.bandwidth() / 2} y={y(acc) + h / 2} dy="0.35em" textAnchor="middle" className="chart-seg-label">{`${Math.round(v)}%`}</text>}
              </g>); })}
            {tip && <rect className="chart-hit" x={0} width={x.bandwidth()} y={0} height={innerH} fill="transparent"
              onMouseEnter={(e) => show(e, [c.title, ...tip(bi)])} onMouseMove={(e) => show(e, [c.title, ...tip(bi)])} onMouseLeave={hide} />}
          </g>); })}
        {title && <text transform={`rotate(-90) translate(${-innerH / 2},${-margin.left + 12})`} textAnchor="middle" className="chart-axis-title">{title}</text>}
      </g>
    </svg>
    {legend && <ul className="chart-legend-flow">
      {series.map((s, si) => (<li key={s.name}><span className="swatch" style={{ background: fill(si) }} />{s.name}</li>))}
    </ul>}
    {tooltip}
    </div>
  );
}
