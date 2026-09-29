import StatCard from "@/components/dev/StatCard";
const fmt = (n: number) => n.toLocaleString("en-US");
export default function StatusCards({ counts }: { counts: { active: number; pending: number; archived: number } }) {
  return (
    <>
      <h3 className="dev-section-title">Page status</h3>
      <div className="dev-stat-row">
        <StatCard label="Active" value={fmt(counts.active)} />
        <StatCard label="Pending" value={fmt(counts.pending)} />
        <StatCard label="Archived" value={fmt(counts.archived)} />
      </div>
    </>
  );
}
