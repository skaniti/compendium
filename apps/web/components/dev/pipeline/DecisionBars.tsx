import BarList from "@/components/dev/BarList";
import { percentOf } from "@/lib/pipeline";
import type { PipelineSummary } from "@/lib/types";
const NOT_EVALUATED = "#2b2e34"; // Dash pipeline_monitor.py:175 literal
export default function DecisionBars({ summary }: { summary: PipelineSummary }) {
  const total = summary.total_pages;
  return (
    <div className="dev-two-col">
      <div>
        <BarList title="Page decisions" emptyText="No pages found." countWidth={80}
          rows={summary.decisions.map((d) => ({ label: d.label, count: d.count, pct: percentOf(d.count, total), fill: d.evaluated ? "var(--primary)" : NOT_EVALUATED }))} />
        <BarList title="Skip mechanisms" emptyText="No archived pages yet."
          rows={summary.skip_methods.map((m) => ({ label: m.label, count: m.count, fill: m.label.toLowerCase().includes("domain") ? "var(--panel-caption)" : "var(--highlight)" }))} />
      </div>
      <div>
        <BarList title="Skip gate reasons" emptyText="No archived pages yet." labelWidth={160}
          rows={summary.skip_gate_reasons.map((r) => ({ label: r.reason, count: r.count, fill: "var(--highlight)", title: r.reason }))} />
      </div>
    </div>
  );
}
