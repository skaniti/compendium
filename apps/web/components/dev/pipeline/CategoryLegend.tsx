export default function CategoryLegend({ items }: { items: { id: string; label: string; count: number; color: string }[] }) {
  return (
    <ul className="chart-legend-flow chart-legend-flat">
      {items.map((it) => (
        <li key={it.id}>
          <span className="swatch" style={{ background: it.color }} />
          <span>{it.label}</span>
          <span className="flow-count">{it.count.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ul>
  );
}
