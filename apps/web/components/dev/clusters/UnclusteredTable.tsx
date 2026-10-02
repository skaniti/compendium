"use client";
import { useState } from "react";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { safeHref, type ClusterPages } from "@/lib/clusters";
import { fetchUnclustered } from "@/lib/clusters-api";
import { formatCount, plural } from "@/lib/overview";

const PAGE_SIZE = 50;
const DASH = "—";
export const UNCLUSTERED_CAPTION = "Pages in your graph that the latest run did not place in a cluster: pages clustering could not place (noise), pages the pre-clustering filter set aside (boilerplate, URL-only, duplicate or non-learning pages), and pages captured since the run. Featured ones appear as labelled singletons on the graph.";

export default function UnclusteredTable({ pages }: { pages: ClusterPages }) {
  const [page, setPage] = useState(0);
  const { data, error, busy } = usePeriodFetch(`unclustered|${page}`, () => fetchUnclustered(PAGE_SIZE, page * PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  return (
    <section id="clusters-unclustered" className={busy ? "dev-panel clusters-unclustered is-refreshing" : "dev-panel clusters-unclustered"} aria-busy={busy}>
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Not in a cluster</h3>
        <span className="dev-panel-meta">{plural(pages.not_clustered, "page")} · {formatCount(pages.featured)} featured · {formatCount(pages.since_run)} new since the run</span>
      </div>
      <p className="clusters-caption">{UNCLUSTERED_CAPTION}</p>
      {error ? <p className="dev-empty" role="alert">Couldn&apos;t load pages ({error}).</p>
       : !data ? <p className="dev-empty">Loading…</p>
       : data.total === 0 ? <p className="dev-empty dev-empty-inline">Every page in your graph is in a cluster.</p>
       : (
        <div className="dev-table-wrap">
          <table className="dev-table dev-table-fixed">
            <colgroup><col style={{ width: "58%" }} /><col style={{ width: "24%" }} /><col style={{ width: "18%" }} /></colgroup>
            <thead><tr><th>Title</th><th>Domain</th><th>Note</th></tr></thead>
            <tbody>
              {data.pages.map((p) => { const href = safeHref(p.url); const title = p.title || "Untitled"; return (
                <tr key={p.id}>
                  <td className="clusters-sans" title={p.title ?? undefined}>{href ? <a className="clusters-link" href={href} target="_blank" rel="noreferrer">{title}</a> : title}</td>
                  <td>{p.domain || DASH}</td>
                  <td className="clusters-nowrap">
                    {p.featured && <span className="clusters-note is-featured">featured</span>}
                    {p.since_run && <span className="clusters-note">new since run</span>}
                  </td>
                </tr>); })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <div className="dev-pager">
          <span>{formatCount(data.offset + 1)}–{formatCount(Math.min(data.offset + PAGE_SIZE, data.total))} of {formatCount(data.total)}</span>
          <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>‹</button>
          <span>{page + 1} / {pageCount}</span>
          <button type="button" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPage((n) => n + 1)}>›</button>
        </div>
      )}
    </section>
  );
}
