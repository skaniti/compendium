"use client";
import { useEffect, useState } from "react";
import SortIcon from "@/components/dev/SortIcon";
import { fetchPipelinePages } from "@/lib/api";
import { DASH, PERIOD_LABELS, flowColumns, formatVisited } from "@/lib/pipeline";
import type { PageSortColumn, PipelinePagesResponse, RangeKey, SortDir } from "@/lib/types";
const PAGE_SIZE = 50;
// "Skip" and "Skip reason" are derived columns with no backing sort key, so
// they render as plain <th>.
const COL_WIDTHS = ["24%", "13%", "10%", "8%", "9%", "19%", "17%"]; // fixed so columns never shift across sorts
const HEADERS: { label: string; sort?: PageSortColumn }[] = [
  { label: "Title", sort: "title" }, { label: "Domain", sort: "domain" }, { label: "Status", sort: "status" },
  { label: "Decision", sort: "processing_depth" }, { label: "Skip" }, { label: "Skip reason" }, { label: "Visited", sort: "visited_at" },
];
export default function PagesTable({ range, tz }: { range: RangeKey; tz: string }) {
  const [page, setPage] = useState(0);
  const [seenRange, setSeenRange] = useState(range);
  // a new period starts at page 1; adjusting during render means the effect below never fetches the old page for the new period
  if (seenRange !== range) { setSeenRange(range); setPage(0); }
  const [sort, setSort] = useState<PageSortColumn>("created_at");
  const [dir, setDir] = useState<SortDir>("desc");
  const [data, setData] = useState<PipelinePagesResponse | null>(null);
  const [dataRange, setDataRange] = useState<RangeKey>(range); // the period `data` was fetched for
  const [error, setError] = useState<string | null>(null);
  const requestKey = `${page}|${sort}|${dir}|${range}|${tz}`;
  const [settledKey, setSettledKey] = useState(requestKey); // the request whose response (or error) is on screen
  const busy = settledKey !== requestKey;
  useEffect(() => {
    let cancelled = false;
    fetchPipelinePages(PAGE_SIZE, page * PAGE_SIZE, sort, dir, range, tz).then((d) => { if (!cancelled) { setData(d); setDataRange(range); setError(null); setSettledKey(requestKey); } })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setSettledKey(requestKey); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey is derived from these same deps
  }, [page, sort, dir, range, tz]);
  function onSort(col: PageSortColumn) {
    if (col === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(col); setDir("asc"); }
    setPage(0);
  }
  const isDefault = sort === "created_at" && dir === "desc";
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  return (
    <section className={busy ? "dev-panel is-refreshing" : "dev-panel"} aria-busy={busy}>
      <div className="dev-panel-head">
        <h3 className="dev-section-title">All pages</h3>
        {data && <span className="dev-panel-meta">{data.total.toLocaleString("en-US")} · {PERIOD_LABELS[dataRange]}</span>}
      </div>
      {error ? <p className="dev-empty" role="alert">Couldn&apos;t load pages ({error}).</p>
       : !data ? <p className="dev-empty">Loading…</p>
       : data.rows.length === 0 ? <p className="dev-empty">No pages in this period.</p>
       : (
        <div className="dev-table-wrap">
          <table className="dev-table dev-table-fixed">
            <colgroup>{COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr>{HEADERS.map((h) => h.sort ? (
              <th key={h.label} aria-sort={h.sort === sort ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" className="dev-sort-btn" onClick={() => onSort(h.sort as PageSortColumn)}>
                  {h.label}<SortIcon state={h.sort === sort ? dir : "none"} />
                </button>
              </th>) : <th key={h.label}>{h.label}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r) => { const s = flowColumns(r); return (
                <tr key={r.id}>
                  <td className="cell-sans" title={r.title ?? undefined}>{r.title || DASH}</td><td>{r.domain || DASH}</td><td className="cell-pill"><span className={`status-pill status-${r.fate}`}>{r.fate}</span></td>
                  <td>{s.decision}</td><td className="cell-skip">{s.skip}</td>
                  <td className="cell-sans" title={s.skipReasonTitle}>{s.skipReason}</td><td className="cell-visited">{formatVisited(r.visited_at)}</td>
                </tr>); })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.rows.length > 0 && (
        <div className="dev-pager">
          <button type="button" disabled={isDefault} onClick={() => { setSort("created_at"); setDir("desc"); setPage(0); }}>Newest first</button>
          <span>{(data.offset + 1).toLocaleString("en-US")}–{Math.min(data.offset + PAGE_SIZE, data.total).toLocaleString("en-US")} of {data.total.toLocaleString("en-US")}</span>
          <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span>{page + 1} / {pageCount}</span>
          <button type="button" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>›</button>
        </div>
      )}
    </section>
  );
}
