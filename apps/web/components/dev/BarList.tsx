export interface BarRow { label: string; count: number; pct?: number; fill: string; title?: string; sub?: string }
export default function BarList({ title, rows, emptyText, labelWidth = 100, countWidth = 50 }:
  { title: string; rows: BarRow[]; emptyText: string; labelWidth?: number; countWidth?: number }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <div className="dev-bars">
      <div className="dev-bars-title">{title}</div>
      {rows.length === 0 ? <p className="dev-empty dev-empty-inline">{emptyText}</p> : rows.map((r) => (
        <div className="dev-bar-item" key={r.label}>
        <div className="dev-bar-row">
          <span className="dev-bar-label" style={{ width: labelWidth }} title={r.title ?? r.label}>{r.label}</span>
          <div className="dev-bar-track"><div className="dev-bar-fill" style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%`, background: r.fill }} /></div>
          <span className="dev-bar-count" style={{ width: countWidth }}>
            {r.count}{r.pct !== undefined && <span className="dev-bar-pct"> {Math.round(r.pct)}%</span>}
          </span>
        </div>
        {r.sub && <div className="dev-bar-sub" style={{ marginLeft: labelWidth + 10 }}>{r.sub}</div>}
        </div>
      ))}
    </div>
  );
}
