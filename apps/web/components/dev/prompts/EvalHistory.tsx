"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import SortIcon from "@/components/dev/SortIcon";
import { formatUsd } from "@/lib/overview";
import {
  evalFamilies, evalSortFirstDir, formatAccuracy, formatDeltaPts, formatEvalDateTime, formatSeconds, sortEvalRuns,
  type EvalRunRow, type EvalRunsResponse, type EvalSortDir, type EvalSortKey,
} from "@/lib/prompts";
import { fetchEvalRuns } from "@/lib/prompts-api";
import EvalRunDetail from "./EvalRunDetail";

const LIMIT = 15;
// Header order matches the colgroup; `className` hides Model, Cost and Time on narrow windows.
const HEADERS: { label: string; key?: EvalSortKey; className?: string }[] = [
  { label: "Run", key: "run" }, { label: "Prompt", key: "prompt" }, { label: "Set", key: "set" },
  { label: "Model", key: "model", className: "col-model" }, { label: "Selection", key: "selection" }, { label: "Stress", key: "stress" },
  { label: "Cost", key: "cost", className: "col-cost" }, { label: "Time", key: "time", className: "col-time" },
  { label: "vs previous" }, { label: "" },
];
const cls = (v: number | null) => (v === null ? "is-flat" : v > 0.0005 ? "is-up" : v < -0.0005 ? "is-down" : "is-flat");

function Delta({ v }: { v: number | null }) {
  return <span className={`prompts-delta ${cls(v)}`}>{formatDeltaPts(v)}</span>;
}

function VsPrevious({ delta }: { delta: NonNullable<EvalRunRow["delta"]> }) {
  const parts = [
    delta.selection !== null && <span className="prompts-chunk">sel <Delta v={delta.selection} /></span>,
    delta.stress !== null && <span className="prompts-chunk">str <Delta v={delta.stress} /></span>,
  ].filter(Boolean);
  return (
    <>
      vs {delta.vs_version}: {parts.length === 0 ? "—" : parts.map((p, i) => <Fragment key={i}>{i > 0 && " · "}{p}</Fragment>)}
    </>
  );
}

export default function EvalHistory() {
  const [data, setData] = useState<EvalRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [family, setFamily] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: EvalSortKey; dir: EvalSortDir }>({ key: "run", dir: "desc" });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = await fetchEvalRuns();
        if (live) setData(d);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, []);

  const runs: EvalRunRow[] = useMemo(() => data?.runs ?? [], [data]);
  const filtered = useMemo(
    () => sortEvalRuns(family ? runs.filter((r) => r.prompt_name === family) : runs, sort.key, sort.dir),
    [runs, family, sort],
  );
  const shown = all ? filtered : filtered.slice(0, LIMIT);
  const onSort = (key: EvalSortKey) => setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: evalSortFirstDir(key) });

  let body;
  if (error) body = <p className="dev-empty" role="alert">Couldn&apos;t load runs ({error}).</p>;
  else if (!data) body = <p className="dev-empty">Loading…</p>;
  else if (!data.configured) body = <p className="dev-empty">No evaluation runs here: this API has no EVAL_RUNS_DIR. Runs come from the evaluation harness and stay outside the repo.</p>;
  else if (!data.readable) body = <p className="dev-empty">EVAL_RUNS_DIR is set, but the directory can&apos;t be read.</p>;
  else if (runs.length === 0) body = <p className="dev-empty">No runs in EVAL_RUNS_DIR yet.</p>;
  else body = (
    <>
      <div className="prompts-chips">
        {[null, ...evalFamilies(runs)].map((f) => (
          <button key={f ?? "all"} type="button" aria-pressed={family === f} onClick={() => { setFamily(f); setOpen(null); }}>{f ?? "All"}</button>
        ))}
      </div>
      {filtered.length === 0 ? <p className="dev-empty">No runs for {family}.</p> : (
        <div className="dev-table-wrap">
          <table className="dev-table dev-table-fixed prompts-evals-table">
            <colgroup>
              <col className="col-run" /><col className="col-prompt" /><col className="col-set" /><col className="col-model" />
              <col className="col-selection" /><col className="col-stress" /><col className="col-cost" /><col className="col-time" />
              <col className="col-vs" /><col className="col-action" />
            </colgroup>
            <thead>
              <tr>{HEADERS.map((h, i) => h.key ? (
                <th key={h.key} className={h.className} aria-sort={h.key === sort.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="dev-sort-btn" onClick={() => onSort(h.key as EvalSortKey)}>
                    {h.label}<SortIcon state={h.key === sort.key ? sort.dir : "none"} />
                  </button>
                </th>) : <th key={i}>{h.label}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.run_id}>
                  <tr>
                    <td className="cell-mono" title={r.run_id}>{formatEvalDateTime(r.timestamp)}</td>
                    <td><span className="prompts-pill">{r.prompt_name} {r.prompt_version}</span></td>
                    <td>{r.fixture_set ?? "—"}</td>
                    <td className="cell-mono col-model">{r.model ?? "—"}</td>
                    <td className="cell-mono">{formatAccuracy(r.selection)}</td>
                    <td className="cell-mono">{formatAccuracy(r.stress)}</td>
                    <td className="cell-mono col-cost">{r.cost_usd === null ? "—" : formatUsd(r.cost_usd)}</td>
                    <td className="cell-mono col-time">{formatSeconds(r.wall_time_s)}</td>
                    <td className="cell-mono">
                      {r.delta ? <VsPrevious delta={r.delta} /> : "—"}
                    </td>
                    <td>
                      <button type="button" className="prompts-link" aria-expanded={open === r.run_id} onClick={() => setOpen(open === r.run_id ? null : r.run_id)}>
                        {open === r.run_id ? "Hide" : "View"}
                      </button>
                    </td>
                  </tr>
                  {open === r.run_id && (
                    <tr className="prompts-detail-row"><td colSpan={10}><EvalRunDetail run={r} runs={runs} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > LIMIT && (
        <button type="button" className="prompts-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${filtered.length} runs`}</button>
      )}
    </>
  );

  return (
    <section className="dev-panel prompts-evals">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Evaluation history</h3>
        {data?.configured && data.readable && (
          <span className="dev-panel-meta">{runs.length} runs{data.skipped > 0 ? ` · ${data.skipped} unreadable` : ""}</span>
        )}
      </div>
      <p className="prompts-caption">Runs of the evaluation harness, read from this API&apos;s EVAL_RUNS_DIR. Accuracy is the share of fixtures whose verdict matched the expected one; vs previous compares with the latest run of the previous version on the same fixture set and model.</p>
      {body}
    </section>
  );
}
