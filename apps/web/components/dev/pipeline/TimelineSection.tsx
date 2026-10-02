"use client";
import TimelineBars from "@/components/charts/TimelineBars";
import LineAreaChart from "@/components/charts/LineAreaChart";
import StackedBarChart from "@/components/charts/StackedBarChart";
import type { BandCat } from "@/components/charts/scales";
import { fetchPipelineTimeline } from "@/lib/api";
import { archiveBars, axisLabels, bucketTitle, categoryMix, hasActivity, skipRateSeries } from "@/lib/pipeline-timeline";
import type { RangeKey } from "@/lib/types";
import { usePeriodFetch } from "./usePeriodFetch";

const EMPTY_ACTIVITY = "No activity in this period.";
const EMPTY_EVALUATED = "Nothing evaluated in this period.";
const EMPTY_GATE = "No gate skips in this period.";

/** Three timelines for the shared period, each on its own full-width row. */
export default function TimelineSection({ range, tz, categoryLabels }: { range: RangeKey; tz: string; categoryLabels: Record<string, string> }) {
  const { data, error, busy } = usePeriodFetch(`${range}|${tz}`, () => fetchPipelineTimeline(range, tz));
  const cell = (title: string, body: React.ReactNode) => (
    <div className="trends-chart-cell"><div className="dev-bars-title">{title}</div>{body}</div>
  );
  if (error) return <div className="trends-grid">{cell("Archive over time", <p className="dev-empty" role="alert">Couldn&apos;t load the timeline ({error}).</p>)}</div>;
  if (!data) return <div className="trends-grid">{cell("Archive over time", <p className="dev-empty">Loading…</p>)}</div>;
  const { buckets, granularity } = data;
  const labels = axisLabels(buckets, granularity);
  const cats: BandCat[] = buckets.map((b, i) => ({ title: bucketTitle(b, granularity), axis: labels[i] }));
  const active = hasActivity(buckets);
  const mix = categoryMix(buckets, categoryLabels);
  const rate = skipRateSeries(buckets);
  return (
    <div className={`trends-grid${busy ? " is-refreshing" : ""}`} aria-busy={busy}>
      {cell("Archive over time", !active ? <p className="dev-empty dev-empty-inline">{EMPTY_ACTIVITY}</p> : <TimelineBars cats={cats} bars={archiveBars(buckets)} />)}
      {cell("Skip rate", !active || rate.every((p) => p.y === null) ? <p className="dev-empty dev-empty-inline">{active ? EMPTY_EVALUATED : EMPTY_ACTIVITY}</p>
        : <LineAreaChart cats={cats} yMax={100} yTicks={[0, 25, 50, 75, 100]} ySuffix="%" yTitle="Skip rate"
            points={rate.map((p) => ({ y: p.y, tip: p.y === null ? ["nothing evaluated"] : [`skipped: ${p.skipped} of ${p.evaluated} evaluated`, `skip rate: ${p.y.toFixed(1)}%`] }))} />)}
      {cell("Skip category mix", mix.series.length === 0 ? <p className="dev-empty dev-empty-inline">{EMPTY_GATE}</p> : <StackedBarChart cats={cats} series={mix.series} />)}
    </div>
  );
}
