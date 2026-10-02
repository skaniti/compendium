"use client";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { safeHref } from "@/lib/clusters";
import { fetchClusterMembers } from "@/lib/clusters-api";
import { formatCount } from "@/lib/overview";

export default function ClusterMembers({ clusterId }: { clusterId: number }) {
  const { data, error } = usePeriodFetch(`members|${clusterId}`, () => fetchClusterMembers(clusterId));
  if (error) return <p className="dev-empty dev-empty-inline" role="alert">Couldn&apos;t load pages ({error}).</p>;
  if (!data) return <p className="dev-empty dev-empty-inline">Loading…</p>;
  if (data.pages.length === 0) return <p className="dev-empty dev-empty-inline">No pages in this cluster.</p>;
  const more = data.total - data.pages.length;
  return (
    <ul className="clusters-members">
      {data.pages.map((p) => { const href = safeHref(p.url); const title = p.title || "Untitled"; return (
        <li key={p.id}>
          {href ? <a href={href} target="_blank" rel="noreferrer">{title}</a> : <span>{title}</span>}
          {p.domain && <span className="clusters-muted"> {p.domain}</span>}
        </li>); })}
      {more > 0 && <li className="clusters-muted">and {formatCount(more)} more</li>}
    </ul>
  );
}
