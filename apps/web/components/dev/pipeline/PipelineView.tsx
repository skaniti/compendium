"use client";
import { useMemo, useState } from "react";
import RangePills from "@/components/dev/RangePills";
import { useTimeWindow } from "@/components/TimeWindowProvider";
import { fetchPipelineSummary } from "@/lib/api";
import { categoryColors } from "@/components/charts/palette";
import { browserTimeZone, rangeKeyFor } from "@/lib/pipeline";
import type { PipelineSummary } from "@/lib/types";
import PipelineFlow from "./PipelineFlow";
import FlowTimeline from "./FlowTimeline";
import CategoryLegend from "./CategoryLegend";
import RuleFilterPanel from "./RuleFilterPanel";
import SkipGateConfigPanel from "./SkipGateConfigPanel";
import PagesTable from "./PagesTable";
import { usePeriodFetch } from "./usePeriodFetch";

export const PIPELINE_SUBTITLE = "Where every page captured in the selected period went: archived before the gate, filtered by rules with no LLM, skipped by the LLM gate, or processed into your graph; how that changed over time; and every page in the period.";

function gateDetails(s: PipelineSummary | null) {
  return s?.flow ? s.flow.details.filter((d) => d.outcome === "gate") : [];
}
function labelsOf(s: PipelineSummary | null): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const c of s.skip_gate_config.categories) out[c.id] = c.label;
  for (const d of gateDetails(s)) out[d.key] = d.label;
  return out;
}

export default function PipelineView() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  const range = rangeKeyFor(timeWindow);
  const [tz] = useState(browserTimeZone);
  const { data: summary, error, busy } = usePeriodFetch(`${range}|${tz}`, () => fetchPipelineSummary(range, tz));
  const labels = useMemo(() => labelsOf(summary), [summary]);
  const gate = useMemo(() => gateDetails(summary), [summary]);
  const order = useMemo(() => gate.map((d) => d.key), [gate]);
  const catColors = useMemo(() => categoryColors(order), [order]);
  const legend = gate.map((d) => ({ id: d.key, label: d.label, count: d.count, color: catColors[d.key] }));
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
        <div data-section="summary" className={busy ? "is-refreshing" : undefined} aria-busy={busy}>
          <section className="dev-panel pipeline-flow-panel">
            {error ? <p className="dev-empty" role="alert">Couldn&apos;t load pipeline summary ({error}).</p>
             : !summary ? <p className="dev-empty">Loading…</p>
             : !summary.flow ? <p className="dev-empty" role="alert">The API is older than this view; restart it to load the flow.</p>
             : <PipelineFlow flow={summary.flow} catColors={catColors} ratio={summary.archive_ratio} />}
            {!(summary && (!summary.flow || summary.flow.total === 0)) && (
              <FlowTimeline range={range} tz={tz} order={order} labels={labels} catColors={catColors} />
            )}
            {summary?.flow && legend.length > 0 && <CategoryLegend items={legend} />}
          </section>
          {summary && (
            <div className="pipeline-filters-row">
              {summary.flow && summary.rule_filter_config && <RuleFilterPanel flow={summary.flow} config={summary.rule_filter_config} />}
              <SkipGateConfigPanel config={summary.skip_gate_config} />
            </div>
          )}
        </div>
        <PagesTable range={range} tz={tz} />
      </div>
    </>
  );
}
