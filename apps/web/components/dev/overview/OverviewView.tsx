"use client";
import { useState } from "react";
import RangePills from "@/components/dev/RangePills";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { useTimeWindow } from "@/components/TimeWindowProvider";
import { fetchOverviewSummary } from "@/lib/api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import { browserTimeZone, rangeKeyFor } from "@/lib/pipeline";
import HeadlineCards from "./HeadlineCards";
import OverviewTimeline from "./OverviewTimeline";
import SpendByPurpose from "./SpendByPurpose";

export const OVERVIEW_SUBTITLE = "Your compendium at a glance for the selected period: what was captured, what reached your graph, how the corpus grew, and what the LLM calls cost. Pipeline shows where everything else went.";

export default function OverviewView() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  const range = rangeKeyFor(timeWindow);
  const [tz] = useState(browserTimeZone);
  const { data, error, busy } = usePeriodFetch(`${range}|${tz}`, () => fetchOverviewSummary(range, tz));
  const stale = error === STALE_API_MESSAGE;
  return (
    <>
      <div className="trends-sticky-header">
        <div className="dev-view-header-band">
          <h2 className="dev-view-title">Overview</h2>
          <p className="dev-view-subtitle">{OVERVIEW_SUBTITLE}</p>
        </div>
        <RangePills value={timeWindow} onChange={setTimeWindow} />
      </div>
      <div className="dev-view-body overview-body">
        {stale ? <section className="dev-panel"><p className="dev-empty" role="alert">The API is older than this view; restart it to load the overview.</p></section>
         : error ? <p className="dev-empty" role="alert">Couldn&apos;t load the overview ({error}).</p>
         : !data ? <p className="dev-empty">Loading…</p>
         : <div className={busy ? "overview-summary is-refreshing" : "overview-summary"} aria-busy={busy}><HeadlineCards summary={data} range={data.range} /></div>}
        {!stale && <OverviewTimeline range={range} tz={tz} />}
        {!error && data && <SpendByPurpose spend={data.spend} />}
      </div>
    </>
  );
}
