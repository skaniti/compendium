import BarList from "@/components/dev/BarList";
import { percentOf } from "@/lib/pipeline";
import type { ReasonRow } from "@/lib/types";
/** Archive reasons and Skip gate categories: label, bar, `count pct%` of `base`, and the top domains as a muted second line. */
export default function ReasonList({ title, rows, base, emptyText }: { title: string; rows: ReasonRow[]; base: number; emptyText: string }) {
  return (
    <BarList title={title} emptyText={emptyText} labelWidth={170} countWidth={80}
      rows={rows.map((r) => ({
        label: r.label, title: r.label, count: r.count, pct: percentOf(r.count, base), fill: "var(--highlight)",
        sub: r.top_domains.length > 0 ? `top: ${r.top_domains.slice(0, 3).map((d) => `${d.domain} (${d.count})`).join(", ")}` : undefined,
      }))} />
  );
}
