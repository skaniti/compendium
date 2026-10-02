"use client";
import { Fragment, useMemo, useState } from "react";
import SortIcon from "@/components/dev/SortIcon";
import { percent, sortClusters, type ClusterRow, type ClusterSortKey } from "@/lib/clusters";
import { formatCount } from "@/lib/overview";
import ClusterMembers from "./ClusterMembers";

const PREVIEW = 25;
const DASH = "—";
const HEADERS: { label: string; key?: ClusterSortKey }[] = [
  { label: "Cluster", key: "name" }, { label: "Pages", key: "size" }, { label: "Confidence", key: "confidence" }, { label: "Supercluster" }, { label: "Group" },
];
const COL_WIDTHS = ["34%", "18%", "12%", "16%", "20%"];
export const CLUSTERS_CAPTION = "Confidence is HDBSCAN's mean membership probability for the cluster's pages. Expand a cluster to see its pages.";

export default function ClusterTable({ clusters, runId }: { clusters: ClusterRow[]; runId: number }) {
  const [sort, setSort] = useState<{ key: ClusterSortKey; dir: "asc" | "desc" }>({ key: "size", dir: "desc" });
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const sorted = useMemo(() => sortClusters(clusters, sort.key, sort.dir), [clusters, sort]);
  const rows = all ? sorted : sorted.slice(0, PREVIEW);
  const largest = Math.max(1, ...clusters.map((c) => c.size));
  const onSort = (key: ClusterSortKey) => setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" });
  const toggle = (id: number) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <section className="dev-panel clusters-table-panel">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Clusters</h3>
        <span className="dev-panel-meta">{formatCount(clusters.length)} in run #{runId}</span>
      </div>
      <p className="clusters-caption">{CLUSTERS_CAPTION}</p>
      {clusters.length === 0 ? <p className="dev-empty dev-empty-inline">No clusters in this run.</p> : (
        <div className="dev-table-wrap">
          <table className="dev-table dev-table-fixed clusters-table">
            <colgroup>{COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr>{HEADERS.map((h) => h.key ? (
              <th key={h.label} aria-sort={h.key === sort.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" className="dev-sort-btn" onClick={() => onSort(h.key as ClusterSortKey)}>
                  {h.label}<SortIcon state={h.key === sort.key ? sort.dir : "none"} />
                </button>
              </th>) : <th key={h.label}>{h.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((c) => { const isOpen = open.has(c.id); return (
                <Fragment key={c.id}>
                  <tr className={isOpen ? "is-open" : undefined}>
                    <td className="clusters-sans" title={c.slug}>
                      <button type="button" className="clusters-expand" aria-expanded={isOpen} aria-controls={`cluster-members-${c.id}`} onClick={() => toggle(c.id)}>
                        <span className="clusters-caret" aria-hidden="true">›</span><span className="clusters-name">{c.name}</span>
                      </button>
                      {c.name_carried && <span className="clusters-muted"> · carried</span>}
                    </td>
                    <td>
                      <span className="clusters-size">
                        <span className="clusters-size-num">{formatCount(c.size)}</span>
                        <span className="clusters-size-track"><span className="clusters-size-bar" style={{ width: `${(c.size / largest) * 100}%` }} /></span>
                      </span>
                    </td>
                    <td>{percent(c.confidence)}</td>
                    <td className="clusters-sans">{c.super_cluster ?? DASH}</td>
                    <td className="clusters-sans">{c.group ? <>{c.group.label} <span className="clusters-muted">{c.group.source}</span></> : DASH}</td>
                  </tr>
                  {isOpen && (
                    <tr className="clusters-members-row">
                      <td colSpan={5} id={`cluster-members-${c.id}`}><ClusterMembers clusterId={c.id} /></td>
                    </tr>
                  )}
                </Fragment>); })}
            </tbody>
          </table>
        </div>
      )}
      {clusters.length > PREVIEW && (
        <button type="button" className="clusters-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${formatCount(clusters.length)} clusters`}
        </button>
      )}
    </section>
  );
}
