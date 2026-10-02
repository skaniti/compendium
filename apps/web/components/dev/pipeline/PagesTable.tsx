"use client";
import { useEffect, useState } from "react";
import SortIcon from "@/components/dev/SortIcon";
import { fetchPipelinePages } from "@/lib/api";
import { DASH, deriveSkipColumns, formatVisited } from "@/lib/pipeline";
import type { PageSortColumn, PipelinePagesResponse, RangeKey, SortDir } from "@/lib/types";
const PAGE_SIZE = 50;
// Header order matches the Dash table; "Skip" and "Skip reason" are derived
// columns with no backing sort key, so they render as plain <th>.
const COL_WIDTHS = ["26%", "14%", "8%", "9%", "7%", "24%", "12%"]; // fixed so columns never shift across sorts
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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPipelinePages(PAGE_SIZE, page * PAGE_SIZE, sort, dir, range, tz).then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [page, sort, dir, range, tz]);
  function onSort(col: PageSortColumn) {
    if (col === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(col); setDir("asc"); }
    setPage(0);
  }
  const isDefault = sort === "created_at" && dir === "desc";
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  return (
    <section>
      <h3 className="dev-section-title">All pages</h3>
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
              {data.rows.map((r) => { const s = deriveSkipColumns(r); return (
                <tr key={r.id}>
                  <td title={r.title ?? undefined}>{r.title || DASH}</td><td>{r.domain || DASH}</td><td>{r.status || DASH}</td>
                  <td>{r.processing_depth || DASH}</td><td>{s.skip}</td>
                  <td title={r.skip_reasoning ?? undefined}>{s.skipReason}</td><td>{formatVisited(r.visited_at)}</td>
                </tr>); })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.rows.length > 0 && (
        <div className="dev-pager">
          <button type="button" disabled={isDefault} onClick={() => { setSort("created_at"); setDir("desc"); setPage(0); }}>Newest first</button>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>page {page + 1} of {pageCount}</span>
          <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
