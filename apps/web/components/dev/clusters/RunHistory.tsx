"use client";
import { useState } from "react";
import LineAreaChart from "@/components/charts/LineAreaChart";
import { categoryFill } from "@/components/charts/palette";
import { countTicks, type BandCat } from "@/components/charts/scales";
import { finishedRuns, formatDuration, formatRunDateTime, runStatusLabel, type ClustersSummary } from "@/lib/clusters";
import { formatCount, formatRunDate, formatUsd, plural } from "@/lib/overview";

const CLUSTERS_COLOR = "var(--highlight)";
const NOISE_COLOR = "color-mix(in oklch, var(--text) 70%, var(--surface))";
const FAILED_COLOR = categoryFill(0);
const PREVIEW = 10;
const PLOT = 110;
const count = (v: number | null) => (v === null ? "—" : formatCount(v));

export default function RunHistory({ runs, currentId }: { runs: ClustersSummary["runs"]; currentId: number | null }) {
  const [all, setAll] = useState(false);
  const finished = finishedRuns(runs.items);
  const failed = runs.items.filter((r) => r.status === "failed").length;
  const cats: BandCat[] = finished.map((r) => ({ title: `Run #${r.id} · ${formatRunDateTime(r.started_at)}`, axis: formatRunDate(r.started_at) }));
  const clusters = finished.map((r) => r.cluster_count);
  const noise = finished.map((r) => r.noise_count);
  const tickOf = (vs: (number | null)[]) => countTicks(Math.max(0, ...vs.map((v) => v ?? 0)));
  const rowsDef = [
    { title: "Clusters", aria: "Clusters per run", color: CLUSTERS_COLOR, values: clusters, ticks: tickOf(clusters), axis: false, area: true },
    { title: "Noise pages", aria: "Noise pages per run", color: NOISE_COLOR, values: noise, ticks: tickOf(noise), axis: true, area: false },
  ];
  const tip = (i: number) => { const r = finished[i]; return [
    `clusters: ${count(r.cluster_count)}`, `noise pages: ${count(r.noise_count)}`, runStatusLabel(r, currentId),
    `took ${formatDuration(r.elapsed_seconds)}`, `naming ${r.naming_cost === null ? "—" : formatUsd(r.naming_cost)}`,
  ]; };
  const rows = all ? runs.items : runs.items.slice(0, PREVIEW);
  return (
    <section className="dev-panel clusters-runs">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Run history</h3>
        <span className="dev-panel-meta">{plural(runs.total, "run")} · {formatCount(failed)} failed{runs.total > runs.items.length ? ` · showing the latest ${formatCount(runs.items.length)}` : ""}</span>
      </div>
      {finished.length > 0 ? (
        <div className="clusters-runs-chart">
          {rowsDef.map((d) => (
            <div key={d.title} className="clusters-runs-row">
              <div className="clusters-runs-label">
                <span className="clusters-runs-title"><span className="swatch" style={{ background: d.color }} />{d.title}</span>
                <span className="clusters-runs-figure">{count(d.values[d.values.length - 1])}</span>
                <span className="clusters-runs-caption">latest run</span>
              </div>
              <LineAreaChart cats={cats} ariaLabel={d.aria} height={d.axis ? PLOT + 6 + 22 : PLOT + 6 + 4} margin={{ top: 6, right: 16, bottom: d.axis ? 22 : 4, left: 48 }}
                xAxis={d.axis} dots={finished.length <= 16} yMax={d.ticks.top} yTicks={d.ticks.ticks} yFormat={formatCount}
                series={[{ name: d.title, color: d.color, values: d.values, area: d.area }]} tip={tip} />
            </div>
          ))}
        </div>
      ) : <p className="dev-empty dev-empty-inline">No finished runs yet.</p>}
      <div className="dev-table-wrap">
        <table className="dev-table clusters-runs-table">
          <thead><tr><th>Run</th><th>Status</th><th>Clusters</th><th>Noise pages</th><th>Naming cost</th><th>Duration</th><th>Started</th></tr></thead>
          <tbody>
            {rows.map((r) => { const s = runStatusLabel(r, currentId); return (
              <tr key={r.id}>
                <td>#{r.id}</td>
                <td><span className={`clusters-run-status is-${s}`} style={s === "failed" ? { color: FAILED_COLOR } : undefined}>{s}</span></td>
                <td>{count(r.cluster_count)}</td>
                <td>{count(r.noise_count)}</td>
                <td>{r.naming_cost === null ? "—" : formatUsd(r.naming_cost)}</td>
                <td>{formatDuration(r.elapsed_seconds)}</td>
                <td>{formatRunDateTime(r.started_at)}</td>
              </tr>); })}
          </tbody>
        </table>
      </div>
      {runs.items.length > PREVIEW && (
        <button type="button" className="clusters-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${formatCount(runs.items.length)} runs`}
        </button>
      )}
    </section>
  );
}
