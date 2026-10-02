import BarList from "@/components/dev/BarList";
import { percentOf } from "@/lib/pipeline";
import type { DecisionRow } from "@/lib/types";
export default function PageDecisions({ decisions, total }: { decisions: DecisionRow[]; total: number }) {
  return (
    <BarList title="Page decisions" emptyText="No pages in this period." countWidth={80}
      rows={decisions.map((d) => ({ label: d.label, count: d.count, pct: percentOf(d.count, total), fill: "var(--highlight)" }))} />
  );
}
