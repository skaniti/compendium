import LineAreaChart from "@/components/charts/LineAreaChart";
import StackedBarChart from "@/components/charts/StackedBarChart";
import { skipRatePoints, skipReasonMix } from "@/lib/pipeline";
import type { SkipTrends } from "@/lib/types";
export default function SkipTrendsSection({ data, error }: { data: SkipTrends | null; error: string | null }) {
  if (error) return <section><h3 className="dev-section-title">Skip trends</h3><p className="dev-empty" role="alert">Couldn&apos;t load skip trends ({error}).</p></section>;
  if (!data) return <section><h3 className="dev-section-title">Skip trends</h3><p className="dev-empty">Loading…</p></section>;
  const rate = skipRatePoints(data.skip_rate); const mix = skipReasonMix(data.skip_reasons);
  return (
    <section>
      <h3 className="dev-section-title">Skip trends</h3>
      <div className="trends-grid">
        <div className="trends-chart-cell">
          <div className="dev-bars-title">Skip rate</div>
          {rate.length === 0 ? <p className="dev-empty dev-empty-inline">No evaluated pages in this window.</p>
            : <LineAreaChart yMax={110} yTicks={[0, 25, 50, 75, 100]} ySuffix="%" yTitle="Skip rate" points={rate.map((p) => ({ x: p.day, y: p.rate, hover: `${p.rate}% (${p.skipped}/${p.total})`, labelTop: `${p.rate}%`, labelBottom: `${p.skipped}/${p.total}` }))} />}
        </div>
        <div className="trends-chart-cell">
          <div className="dev-bars-title">Skip reason mix</div>
          {mix.days.length === 0 ? <p className="dev-empty dev-empty-inline">No skipped pages in this window.</p>
            : <StackedBarChart days={mix.days} series={mix.series} />}
        </div>
      </div>
    </section>
  );
}
