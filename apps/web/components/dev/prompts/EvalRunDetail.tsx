"use client";
import { useEffect, useState } from "react";
import { formatUsd } from "@/lib/overview";
import {
  compareRows, fixtureFilter, formatDeltaPts, formatEvalDateTime, formatShare,
  type EvalMetrics, type EvalMetricType, type EvalRunDetail as Detail, type EvalRunRow,
} from "@/lib/prompts";
import { fetchEvalRun } from "@/lib/prompts-api";

const num = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(2) : "—");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TITLES: Record<EvalMetricType, string> = { selection: "Selection", stress: "Stress" };

function Metric({ type, m }: { type: EvalMetricType; m: EvalMetrics }) {
  const classes = [...new Set([...Object.keys(m.confusion), ...Object.values(m.confusion).flatMap((r) => Object.keys(r))])].sort();
  const threats = Object.keys(m.per_threat_recall).sort();
  return (
    <div className="prompts-metric">
      <h4>
        {TITLES[type]} · {m.n_fixtures ?? "—"} fixtures · {formatShare(m.accuracy)} accurate · {m.n_correct ?? "—"} correct · {m.n_wrong ?? "—"} wrong · {m.n_errored ?? "—"} errors
      </h4>
      <table className="prompts-confusion">
        <caption>Rows: predicted · columns: expected</caption>
        <thead><tr><th />{classes.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {classes.map((r) => (
            <tr key={r}>
              <th>{r}</th>
              {classes.map((c) => <td key={c} className={r === c ? "is-diag" : undefined}>{m.confusion[r]?.[c] ?? 0}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="dev-table prompts-classes">
        <thead><tr><th>Class</th><th>TP</th><th>FP</th><th>FN</th><th>Precision</th><th>Recall</th><th>F1</th></tr></thead>
        <tbody>
          {Object.entries(m.per_class).map(([k, c]) => (
            <tr key={k}>
              <td>{k}</td><td className="cell-mono">{c.tp ?? "—"}</td><td className="cell-mono">{c.fp ?? "—"}</td><td className="cell-mono">{c.fn ?? "—"}</td>
              <td className="cell-mono">{num(c.precision)}</td><td className="cell-mono">{num(c.recall)}</td><td className="cell-mono">{num(c.f1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {type === "stress" && threats.length > 0 && (
        <table className="dev-table prompts-threats">
          <thead><tr><th>Threat</th><th>Recall</th></tr></thead>
          <tbody>
            {threats.map((t) => (
              <tr key={t}>
                <td>{t}</td>
                <td className="cell-mono">{formatShare(m.per_threat_recall[t])}{m.per_threat_recall[t] < 0.5 && <> <span className="prompts-pill is-muted">low</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {m.cost_weighted_scalar !== null && m.cost_weighted_scalar !== undefined && (
        <p className="prompts-note">Cost-weighted score {m.cost_weighted_scalar}</p>
      )}
    </div>
  );
}

function Compare({ detail, others }: { detail: Detail; others: EvalRunRow[] }) {
  const [id, setId] = useState("");
  const [other, setOther] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetchEvalRun(id).then((d) => { if (live) setOther(d); }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [id]);
  return (
    <div className="prompts-compare-block">
      <label>Compare with{" "}
        <select value={id} onChange={(e) => { setOther(null); setError(null); setId(e.target.value); }}>
          <option value="">—</option>
          {others.map((r) => (
            <option key={r.run_id} value={r.run_id}>{r.prompt_version} · {formatEvalDateTime(r.timestamp)} · {r.fixture_set}</option>
          ))}
        </select>
      </label>
      {id && error && <p className="dev-empty" role="alert">Couldn&apos;t load run ({error}).</p>}
      {id && other && (
        <table className="dev-table prompts-compare">
          <thead><tr><th>Metric</th><th>This run</th><th>Other</th><th>Δ</th></tr></thead>
          <tbody>
            {compareRows(detail, other).map((r) => (
              <tr key={r.metric}>
                <td>{r.metric}</td><td className="cell-mono">{formatShare(r.a)}</td><td className="cell-mono">{formatShare(r.b)}</td><td className="cell-mono">{formatDeltaPts(r.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function EvalRunDetail({ run, runs }: { run: EvalRunRow; runs: EvalRunRow[] }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"all" | "misses">("all");
  useEffect(() => {
    let live = true;
    fetchEvalRun(run.run_id).then((d) => { if (live) setDetail(d); }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [run.run_id]);
  if (error) return <p className="dev-empty" role="alert">Couldn&apos;t load run ({error}).</p>;
  if (!detail) return <p className="dev-empty">Loading…</p>;

  const t = detail.totals;
  const hits = t.cache_hits;
  const lookups = hits !== null && t.cache_misses !== null ? hits + t.cache_misses : null;
  const parts = [
    detail.model && `model ${detail.model}`,
    detail.fixture_set && `set ${detail.fixture_set}${detail.fixture_version ? ` (${detail.fixture_version})` : ""}`,
    detail.git_sha && `git ${detail.git_sha.slice(0, 7)}`,
    t.cost_usd !== null && `cost ${formatUsd(t.cost_usd)}`,
    t.llm_calls !== null && `${t.llm_calls} calls`,
    hits !== null && lookups !== null && `cache ${hits}/${lookups}`,
  ].filter(Boolean);
  const others = runs
    .filter((r) => r.prompt_name === run.prompt_name && r.run_id !== run.run_id)
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  const fixtures = fixtureFilter(detail.fixtures, mode);
  const types = (["selection", "stress"] as const).filter((k) => detail.metrics[k]);

  return (
    <div className="prompts-detail">
      <p className="prompts-detail-meta">{parts.join(" · ")}</p>
      {types.map((k) => <Metric key={k} type={k} m={detail.metrics[k] as EvalMetrics} />)}
      <div className="prompts-chips">
        <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>All fixtures</button>
        <button type="button" aria-pressed={mode === "misses"} onClick={() => setMode("misses")}>Wrong and errors</button>
      </div>
      <div className="dev-table-wrap">
        <table className="dev-table prompts-fixtures">
          <thead><tr><th>Status</th><th>Type</th><th>Threat</th><th>Fixture</th><th>Expected</th><th>Actual</th><th /></tr></thead>
          <tbody>
            {fixtures.map((f, i) => (
              <tr key={`${f.fixture_id}-${i}`}>
                <td><span className={`prompts-pill is-${f.status}`}>{f.status}</span></td>
                <td>{f.type ?? "—"}</td>
                <td>{f.threat_category ?? "—"}</td>
                <td className="cell-mono">{f.fixture_id ?? "—"}</td>
                <td>{f.expected ?? "—"}</td>
                <td>{f.actual ?? "—"}</td>
                <td><details><summary>JSON</summary><pre className="config-prompt">{JSON.stringify(f.detail, null, 2)}</pre></details></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.fixtures_total > detail.fixtures.length && (
        <p className="prompts-note">Showing the first {detail.fixtures.length} of {detail.fixtures_total} fixtures.</p>
      )}
      {detail.notes && <p className="prompts-note">Notes: {detail.notes}</p>}
      {others.length > 0 && <Compare detail={detail} others={others} />}
    </div>
  );
}
