import Link from "next/link";
import StatCard from "@/components/dev/StatCard";
import { formatCount, formatRunDate, formatUsd, plural, shareOf } from "@/lib/overview";
import type { OverviewSummary, RangeKey } from "@/lib/types";

export default function HeadlineCards({ summary, range }: { summary: OverviewSummary; range: RangeKey }) {
  const { pages, captures, spend, clusters } = summary;
  const all = range === "all";
  return (
    <div className="overview-cards">
      <StatCard label="Captured" value={formatCount(pages.captured)}
        lines={[`pages from ${plural(captures.total, "capture")}`, ...(all ? [] : [`${formatCount(pages.all_time_captured)} all time`])]} />
      <StatCard label="In your graph" accent value={formatCount(pages.in_graph)}
        lines={[`${shareOf(pages.in_graph, pages.captured)} of captured`, <Link key="pipeline" href="/dev/pipeline" className="overview-card-link">Where the rest went → Pipeline</Link>]} />
      <StatCard label="Clusters" value={clusters ? formatCount(clusters.clusters) : "—"}
        lines={clusters ? [`${plural(clusters.superclusters, "supercluster")} · ${plural(clusters.topics, "topic")}`, `latest run · ${formatRunDate(clusters.run_completed_at)}`] : ["No clustering run yet"]} />
      <StatCard label="LLM spend" value={formatUsd(spend.usd)}
        lines={[spend.calls > 0 ? plural(spend.calls, "call") : "No LLM calls in this period", ...(all ? [] : [`${formatUsd(spend.all_time_usd)} all time`])]} />
    </div>
  );
}
