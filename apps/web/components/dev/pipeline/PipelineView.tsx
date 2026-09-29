"use client";
import { useEffect, useState } from "react";
import { fetchPipelineSummary } from "@/lib/api";
import type { PipelineSummary } from "@/lib/types";
import StatusCards from "./StatusCards";
import SkipGateConfigPanel from "./SkipGateConfigPanel";
import DecisionBars from "./DecisionBars";
import PagesTable from "./PagesTable";

export const PIPELINE_SUBTITLE = "Current state of the page processing pipeline: how many pages are active, pending, or archived; what skip mechanisms and reasons are filtering pages out; archive health and skip trends over a window; and the most recently captured pages.";

export default function PipelineView() {
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPipelineSummary().then((s) => { if (!cancelled) setSummary(s); }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  return (
    <>
      <div className="dev-view-header-band">
        <h2 className="dev-view-title">Pipeline</h2>
        <p className="dev-view-subtitle">{PIPELINE_SUBTITLE}</p>
      </div>
      <div className="dev-view-body">
        {error ? <p className="dev-empty" role="alert">Couldn&apos;t load pipeline summary ({error}).</p>
         : !summary ? <p className="dev-empty">Loading…</p>
         : summary.total_pages === 0 ? <p className="dev-empty">No pages found.</p>
         : (
          <>
            <StatusCards counts={summary.status_counts} />
            <SkipGateConfigPanel config={summary.skip_gate_config} />
            <DecisionBars summary={summary} />
          </>
        )}
        {/* Task 6: <WindowedSections /> mounts here (archive health + skip trends) */}
        <PagesTable />
      </div>
    </>
  );
}
