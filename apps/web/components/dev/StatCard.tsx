export default function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="dev-stat-card">
      <div className="dev-stat-label">{label}</div>
      <div className="dev-stat-value">{value}</div>
    </div>
  );
}
