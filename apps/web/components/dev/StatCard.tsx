import type { ReactNode } from "react";
export default function StatCard({ label, value, lines = [], accent = false }: { label: string; value: string; lines?: ReactNode[]; accent?: boolean }) {
  return (
    <div className={`dev-stat-card${accent ? " is-accent" : ""}`}>
      <div className="dev-stat-label">{label}</div>
      <div className="dev-stat-value">{value}</div>
      {lines.map((l, i) => <div key={i} className="dev-stat-line">{l}</div>)}
    </div>
  );
}
