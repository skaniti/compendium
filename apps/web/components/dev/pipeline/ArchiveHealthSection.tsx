import StatCard from "@/components/dev/StatCard";
import BarChart from "@/components/charts/BarChart";
import { archiveRatio } from "@/lib/pipeline";
import type { ArchiveHealthSummary } from "@/lib/types";
const fmt = (n: number) => n.toLocaleString("en-US");
export default function ArchiveHealthSection({ data, error }: { data: ArchiveHealthSummary | null; error: string | null }) {
  const captures = data ? data.per_capture.filter((c) => c.started_at) : [];
  return (
    <section>
      <h3 className="dev-section-title">Archive health</h3>
      {error ? <p className="dev-empty" role="alert">Couldn&apos;t load archive health ({error}).</p>
       : !data ? <p className="dev-empty">Loading…</p> : (
        <>
          <div className="dev-stat-row">
            <StatCard label="Active" value={fmt(data.active_count)} />
            <StatCard label="Archived" value={fmt(data.archived_count)} />
            <StatCard label="Archive ratio" value={archiveRatio(data.active_count, data.archived_count)} />
          </div>
          <h3 className="dev-section-title">By archive reason</h3>
          {data.by_reason.length === 0 ? <p className="dev-empty dev-empty-inline">No archived pages in this window.</p> : (
            <div className="dev-table-wrap"><table className="dev-table">
              <thead><tr><th>Reason</th><th>Count</th><th>Top domains</th></tr></thead>
              <tbody>{data.by_reason.map((r) => (
                <tr key={r.reason}><td>{r.reason}</td><td>{r.count}</td><td>{r.top_domains.slice(0, 3).map((d) => `${d.domain} (${d.count})`).join(", ")}</td></tr>))}</tbody>
            </table></div>
          )}
          <h3 className="dev-section-title">Archive rate per capture</h3>
          {captures.length === 0 ? <p className="dev-empty dev-empty-inline">No captures in this window.</p> : (
            <BarChart yMax={105} yTicks={[0, 25, 50, 75, 100]} ySuffix="%" yTitle="Archive rate" xTitle="Capture start time"
              points={captures.map((c) => ({ x: new Date(c.started_at as string), y: c.rate * 100, label: c.capture_id }))} />
          )}
        </>
      )}
    </section>
  );
}
