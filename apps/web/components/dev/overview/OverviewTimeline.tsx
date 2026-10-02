"use client";
import type { ReactNode } from "react";
import LineAreaChart from "@/components/charts/LineAreaChart";
import StackedBarChart from "@/components/charts/StackedBarChart";
import { countTicks, type BandCat, type Margin } from "@/components/charts/scales";
import { DEVICE_COLORS, SPEND_COLORS } from "./colors";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { fetchOverviewTimeline } from "@/lib/api";
import { bucketSpend, formatCount, formatUsd, formatUsdTick, hasOverviewActivity, periodDeltas, plural, runningTotals, SPEND_LABELS, SPEND_ORDER, STALE_API_MESSAGE } from "@/lib/overview";
import { axisLabels, bucketTitle } from "@/lib/pipeline-timeline";
import type { RangeKey } from "@/lib/types";

export const GROWTH_FOOTNOTE = "Running totals by visit time. In your graph counts pages that are in your graph today.";
const PLOT = { growth: 130, captures: 80, spend: 80 };
// Same left/right margins on every row so the three band scales line up.
const margin = (xAxis: boolean): Margin => ({ top: 6, right: 16, bottom: xAxis ? 22 : 4, left: 56 });
const CAPTURED_COLOR = "var(--panel-caption)", IN_GRAPH_COLOR = "var(--highlight)";

function Row({ title, figure, sub, legend, children }: { title: string; figure: string; sub?: string; legend?: { name: string; color: string }[]; children: ReactNode }) {
  return (
    <div className="overview-tl-row">
      <div className="overview-tl-label">
        <div className="overview-tl-title">{title}</div>
        <div className="overview-tl-figure">{figure}</div>
        {sub && <div className="overview-tl-sub">{sub}</div>}
        {legend && <ul className="overview-tl-legend">{legend.map((l) => <li key={l.name}><span className="swatch" style={{ background: l.color }} />{l.name}</li>)}</ul>}
      </div>
      <div className="overview-tl-chart">{children}</div>
    </div>
  );
}

export default function OverviewTimeline({ range, tz }: { range: RangeKey; tz: string }) {
  const { data, error, busy } = usePeriodFetch(`${range}|${tz}`, () => fetchOverviewTimeline(range, tz));
  if (error === STALE_API_MESSAGE) return null;
  const panel = (body: ReactNode) => (
    <section className={`dev-panel overview-timeline${busy ? " is-refreshing" : ""}`} aria-busy={busy}>
      <div className="dev-panel-head"><h3 className="dev-section-title">Over time</h3></div>
      {body}
    </section>
  );
  if (error) return panel(<p className="dev-empty" role="alert">Couldn&apos;t load the timeline ({error}).</p>);
  if (!data) return panel(<p className="dev-empty">Loading…</p>);
  const { buckets, granularity, baseline } = data;
  if (!hasOverviewActivity(buckets)) return panel(<p className="dev-empty dev-empty-inline">No activity in this period.</p>);

  const axis = axisLabels(buckets, granularity);
  const cats: BandCat[] = buckets.map((b, i) => ({ title: bucketTitle(b, granularity), axis: axis[i] }));
  const totals = runningTotals(baseline, buckets);
  const deltas = periodDeltas(buckets);
  const growthTicks = countTicks(Math.max(0, ...totals.captured));
  const desktop = buckets.map((b) => b.captures.desktop), phone = buckets.map((b) => b.captures.phone);
  const dTotal = desktop.reduce((a, n) => a + n, 0), pTotal = phone.reduce((a, n) => a + n, 0);
  const spendTotal = buckets.reduce((a, b) => a + bucketSpend(b), 0);
  const calls = buckets.reduce((a, b) => a + b.calls, 0);
  const hasSpend = spendTotal > 0;
  const purposeColors = SPEND_COLORS;
  const hasCaptures = dTotal + pTotal > 0;
  const growthAxis = !hasCaptures && !hasSpend, capturesAxis = hasCaptures && !hasSpend;
  const purposes = SPEND_ORDER.filter((k) => buckets.some((b) => b.spend[k] > 0));
  return panel(<>
    <Row title="Corpus growth" figure={`+${formatCount(deltas.captured)} captured`} sub={`+${formatCount(deltas.inGraph)} in your graph`}
      legend={[{ name: "Captured", color: CAPTURED_COLOR }, { name: "In your graph", color: IN_GRAPH_COLOR }]}>
      <LineAreaChart cats={cats} ariaLabel="Corpus growth" height={PLOT.growth + (growthAxis ? 28 : 10)} margin={margin(growthAxis)} xAxis={growthAxis}
        yMax={growthTicks.top} yTicks={growthTicks.ticks} yFormat={formatCount}
        series={[{ name: "Captured", color: CAPTURED_COLOR, values: totals.captured }, { name: "In your graph", color: IN_GRAPH_COLOR, values: totals.inGraph, area: true }]}
        tip={(i) => [`captured: ${formatCount(totals.captured[i])} (+${formatCount(buckets[i].captured)})`, `in your graph: ${formatCount(totals.inGraph[i])} (+${formatCount(buckets[i].in_graph)})`]} />
    </Row>
    <Row title="Captures" figure={plural(dTotal + pTotal, "capture")} sub={`desktop ${formatCount(dTotal)} · phone ${formatCount(pTotal)}`}
      legend={[{ name: "Desktop", color: DEVICE_COLORS.desktop }, { name: "Phone", color: DEVICE_COLORS.phone }]}>
      {hasCaptures ? (
        <StackedBarChart mode="count" cats={cats} legend={false} height={PLOT.captures + (capturesAxis ? 28 : 10)} margin={margin(capturesAxis)} xAxis={capturesAxis} yFormat={formatCount}
          series={[{ name: "Desktop", color: DEVICE_COLORS.desktop, values: desktop }, { name: "Phone", color: DEVICE_COLORS.phone, values: phone }]}
          tip={(i) => [`desktop: ${formatCount(desktop[i])}`, `phone: ${formatCount(phone[i])}`, `total: ${formatCount(desktop[i] + phone[i])}`]} />
      ) : <p className="dev-empty dev-empty-inline">No captures in this period.</p>}
    </Row>
    <Row title="LLM spend" figure={formatUsd(spendTotal)} sub={plural(calls, "call")}
      legend={hasSpend ? purposes.map((k) => ({ name: SPEND_LABELS[k], color: purposeColors[k] })) : undefined}>
      {hasSpend ? (
        <StackedBarChart mode="count" cats={cats} legend={false} height={PLOT.spend + 28} margin={margin(true)} yFormat={formatUsdTick}
          series={purposes.map((k) => ({ name: SPEND_LABELS[k], color: purposeColors[k], values: buckets.map((b) => b.spend[k]) }))}
          tip={(i) => [...purposes.filter((k) => buckets[i].spend[k] > 0).map((k) => `${SPEND_LABELS[k]}: ${formatUsd(buckets[i].spend[k])}`), `total: ${formatUsd(bucketSpend(buckets[i]))}`, plural(buckets[i].calls, "call")]} />
      ) : <p className="dev-empty dev-empty-inline">No LLM spend in this period.</p>}
    </Row>
    <p className="overview-footnote">{GROWTH_FOOTNOTE}</p>
  </>);
}
