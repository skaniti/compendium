import BarList from "@/components/dev/BarList";
import { percentOf } from "@/lib/pipeline";
import type { PipelineSummary } from "@/lib/types";
const FILL = "var(--highlight)"; // one bar colour everywhere
export default function DecisionBars({ summary }: { summary: PipelineSummary }) {
  const total = summary.total_pages;
  const archived = summary.status_counts.archived; // mechanisms sum to it; gate reasons are a slice of it
  return (
    <div className="dev-two-col">
      <div>
        <BarList title="Page decisions" emptyText="No pages found." countWidth={80}
          rows={summary.decisions.map((d) => ({ label: d.label, count: d.count, pct: percentOf(d.count, total), fill: FILL }))} />
        <BarList title="Skip mechanisms" emptyText="No archived pages yet." countWidth={80}
          rows={summary.skip_methods.map((m) => ({ label: m.label, count: m.count, pct: percentOf(m.count, archived), fill: FILL }))} />
      </div>
      <div>
        <BarList title="Skip gate reasons" emptyText="No archived pages yet." labelWidth={160} countWidth={80}
          rows={summary.skip_gate_reasons.map((r) => ({ label: r.reason, count: r.count, pct: percentOf(r.count, archived), fill: FILL, title: r.reason }))} />
      </div>
    </div>
  );
}
