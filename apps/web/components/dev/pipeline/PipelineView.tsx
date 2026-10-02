"use client";
import { useMemo, useState } from "react";
import RangePills from "@/components/dev/RangePills";
import { useTimeWindow } from "@/components/TimeWindowProvider";
import { fetchPipelineSummary } from "@/lib/api";
import { browserTimeZone, rangeKeyFor } from "@/lib/pipeline";
import type { PipelineSummary } from "@/lib/types";
import StatusCards from "./StatusCards";
import SkipGateConfigPanel from "./SkipGateConfigPanel";
import PageDecisions from "./PageDecisions";
import ReasonList from "./ReasonList";
import TimelineSection from "./TimelineSection";
import PagesTable from "./PagesTable";
import { usePeriodFetch } from "./usePeriodFetch";

export const PIPELINE_SUBTITLE = "Current state of the page processing pipeline for the selected period: how many pages are active, pending, or archived; what archive reasons and skip gate categories are filtering pages out; archive and skip trends over time; and the pages captured in the period.";

function labelsOf(s: PipelineSummary | null): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const c of s.skip_gate_config.categories) out[c.id] = c.label;
  for (const c of s.skip_categories) out[c.key] ??= c.label;
  return out;
}

export default function PipelineView() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  const range = rangeKeyFor(timeWindow);
  const [tz] = useState(browserTimeZone);
  const { data: summary, error } = usePeriodFetch(`${range}|${tz}`, () => fetchPipelineSummary(range, tz));
  const categoryLabels = useMemo(() => labelsOf(summary), [summary]);
  const gateTotal = summary ? summary.skip_categories.reduce((a, r) => a + r.count, 0) : 0;
  return (
    <>
      <div className="trends-sticky-header">
        <div className="dev-view-header-band">
          <h2 className="dev-view-title">Pipeline</h2>
          <p className="dev-view-subtitle">{PIPELINE_SUBTITLE}</p>
        </div>
        <RangePills value={timeWindow} onChange={setTimeWindow} />
      </div>
      <div className="dev-view-body">
        {error ? <p className="dev-empty" role="alert">Couldn&apos;t load pipeline summary ({error}).</p>
         : !summary ? <p className="dev-empty">Loading…</p>
         : (
          <>
            <StatusCards counts={summary.status_counts} ratio={summary.archive_ratio} />
            <SkipGateConfigPanel config={summary.skip_gate_config} />
            <div className="dev-two-col">
              <PageDecisions decisions={summary.decisions} total={summary.total_pages} />
              <ReasonList title="Archive reasons" rows={summary.archive_reasons} base={summary.status_counts.archived}
                emptyText={summary.total_pages === 0 ? "No pages in this period." : "No archived pages in this period."} />
            </div>
            <ReasonList title="Skip gate categories" rows={summary.skip_categories} base={gateTotal} emptyText="No gate skips in this period." />
          </>
        )}
        <TimelineSection range={range} tz={tz} categoryLabels={categoryLabels} />
        <PagesTable range={range} tz={tz} />
      </div>
    </>
  );
}
