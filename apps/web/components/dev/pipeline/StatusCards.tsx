import StatCard from "@/components/dev/StatCard";
import { formatRatio } from "@/lib/pipeline";
const fmt = (n: number) => n.toLocaleString("en-US");
export default function StatusCards({ counts, ratio }: { counts: { active: number; pending: number; archived: number }; ratio: number }) {
  return (
    <div className="dev-stat-row">
      <StatCard label="Active" value={fmt(counts.active)} />
      <StatCard label="Pending" value={fmt(counts.pending)} />
      <StatCard label="Archived" value={fmt(counts.archived)} />
      <StatCard label="Archive Ratio" value={formatRatio(ratio)} />
    </div>
  );
}
