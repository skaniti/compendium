"use client";
import { line } from "d3-shape";
import type { ReactNode } from "react";
import BandAxis from "@/components/charts/BandAxis";
import { useChartTooltip } from "@/components/charts/ChartTooltip";
import { UNCATEGORIZED_FILL } from "@/components/charts/palette";
import { countTicks, frame, xBand, yLinear, type BandCat } from "@/components/charts/scales";
import { useContainerWidth } from "@/components/charts/useContainerWidth";
import { fetchPipelineTimeline } from "@/lib/api";
import { OUTCOME_COLOR } from "@/lib/pipeline";
import { axisLabels, bucketTitle, gateNotLiveRun, hasFlowActivity, mixSeries, rateDomain, rateSeries, VOLUME_ORDER } from "@/lib/pipeline-timeline";
import type { FlowOutcomeKey, RangeKey } from "@/lib/types";
import { usePeriodFetch } from "./usePeriodFetch";

const EMPTY_ACTIVITY = "No activity in this period.";
const EMPTY_GATE = "No gate skips in this period.";
const LABEL_W = 180, ML = 44, MR = 48, MT = 8;
const H_VOL = 120, H_RATE = 90, H_MIX = 70, AXIS_H = 22;
const OUTCOME_LABEL: Record<FlowOutcomeKey, string> = {
  processed: "Processed · kept", gate: "Skipped by LLM gate", rule_filter: "Rule filter · no LLM", before_gate: "Archived before gate", pending: "Pending",
};
const ARCHIVE_COLOR = "var(--panel-caption)", GATE_COLOR = "var(--highlight)";

export default function FlowTimeline({ range, tz, order, labels, catColors }: { range: RangeKey; tz: string; order: string[]; labels: Record<string, string>; catColors: Record<string, string> }) {
  const { data, error, busy } = usePeriodFetch(`${range}|${tz}`, () => fetchPipelineTimeline(range, tz));
  const [ref, width] = useContainerWidth();
  const { tooltip, show, hide } = useChartTooltip();
  const wrap = (body: ReactNode) => <div ref={ref} className={`chart-wrap flow-timeline${busy ? " is-refreshing" : ""}`} aria-busy={busy} style={{ position: "relative", width: "100%" }}>{body}{tooltip}</div>;
  if (error) return wrap(<p className="dev-empty" role="alert">Couldn&apos;t load the timeline ({error}).</p>);
  if (!data) return wrap(<p className="dev-empty">Loading…</p>);
  const { buckets, granularity } = data;
  if (!hasFlowActivity(buckets)) return wrap(<p className="dev-empty dev-empty-inline">{EMPTY_ACTIVITY}</p>);

  const axis = axisLabels(buckets, granularity);
  const cats: BandCat[] = buckets.map((b, i) => ({ title: bucketTitle(b, granularity), axis: axis[i] }));
  const plotW = Math.max(1, width - LABEL_W);
  const { innerW } = frame(plotW, 1, { top: 0, right: MR, bottom: 0, left: ML });
  const x = xBand(buckets.length, innerW);
  const bx = (i: number) => x(String(i)) ?? 0;
  const cx = (i: number) => bx(i) + x.bandwidth() / 2;
  const grid = (t: number, y: (v: number) => number, text: string) => (
    <g key={t} transform={`translate(0,${y(t)})`}><line x2={innerW} className="chart-grid" /><text x={-6} dy="0.32em" textAnchor="end" className="chart-tick">{text}</text></g>
  );
  const row = (h: number, label: string, head: ReactNode, body: ReactNode, extra = 0) => (
    <div className="flow-tl-row">
      <div className="flow-tl-label">{head}</div>
      {body === null ? null : <svg className="chart" viewBox={`0 0 ${plotW} ${h + MT + extra}`} width={plotW} height={h + MT + extra} role="img" aria-label={label}>{body}</svg>}
    </div>
  );
  const hits = (cls: string, lines: (i: number) => string[]) => buckets.map((_, i) => (
    <rect key={i} className={`flow-tl-hit ${cls}`} x={bx(i) - 2} y={0} width={x.bandwidth() + 4} height={cls === "flow-tl-hit-volume" ? H_VOL : cls === "flow-tl-hit-rates" ? H_RATE : H_MIX}
      fill="transparent" onMouseEnter={(e) => show(e, lines(i))} onMouseMove={(e) => show(e, lines(i))} onMouseLeave={hide} />
  ));

  // Volume
  const maxTotal = Math.max(0, ...buckets.map((b) => VOLUME_ORDER.reduce((a, k) => a + b.outcomes[k], 0)));
  const { ticks, top } = countTicks(maxTotal);
  const yv = yLinear(top, H_VOL);
  const volume = (
    <g transform={`translate(${ML},${MT})`}>
      {ticks.map((t) => grid(t, yv, t.toLocaleString("en-US")))}
      {buckets.map((b, i) => { let acc = 0; return (
        <g key={i} pointerEvents="none">{VOLUME_ORDER.map((k) => {
          const n = b.outcomes[k]; const y0 = acc; acc += n;
          return <rect key={k} className="flow-tl-seg" x={bx(i)} y={yv(acc)} width={x.bandwidth()} height={Math.max(0, yv(y0) - yv(acc))}
            style={{ fill: OUTCOME_COLOR[k] }} fillOpacity={k === "pending" ? 0.5 : 1} stroke={k === "pending" ? OUTCOME_COLOR[k] : undefined} strokeDasharray={k === "pending" ? "3 2" : undefined} />;
        })}</g>); })}
      {hits("flow-tl-hit-volume", (i) => [cats[i].title, ...VOLUME_ORDER.filter((k) => buckets[i].outcomes[k] > 0).map((k) => `${OUTCOME_LABEL[k]}  ${buckets[i].outcomes[k].toLocaleString("en-US")}`), `total ${VOLUME_ORDER.reduce((a, k) => a + buckets[i].outcomes[k], 0).toLocaleString("en-US")}`])}
    </g>
  );

  // Rates
  const rs = rateSeries(buckets);
  const [rmin, rmax] = rateDomain(rs);
  const yr = (v: number) => H_RATE - ((v - rmin) / (rmax - rmin)) * H_RATE;
  const rateTicks: number[] = []; for (let t = rmin; t <= rmax; t += 20) rateTicks.push(t);
  const path = (pts: typeof rs.archive) => line<{ y: number | null }>().defined((p) => p.y !== null).x((_, i) => cx(i)).y((p) => yr(p.y as number))(pts) ?? "";
  const endOf = (pts: typeof rs.archive) => { let i = pts.length - 1; while (i >= 0 && pts[i].y === null) i--; return i < 0 ? null : { i, y: yr(pts[i].y as number), v: pts[i].y as number }; };
  const ends = [endOf(rs.archive), endOf(rs.gate)];
  const endYs = ends.map((e) => e?.y ?? 0);
  if (ends[0] && ends[1] && Math.abs(endYs[0] - endYs[1]) < 12) { // keep the higher line's label above, push apart symmetrically
    const mid = (endYs[0] + endYs[1]) / 2, up = endYs[0] <= endYs[1] ? 0 : 1;
    endYs[up] = mid - 6; endYs[1 - up] = mid + 6;
  }
  const endLabel = (k: number, color: string) => { const e = ends[k]; return e ? <text className="flow-rate-end" x={cx(e.i) + 8} y={endYs[k]} dy="0.32em" style={{ fill: color }}>{`${e.v.toFixed(1)}%`}</text> : null; };
  const fmt = (p: { y: number | null; n: number; d: number }) => (p.y === null ? "—" : `${p.y.toFixed(1)}% (${p.n}/${p.d})`);
  const rates = (
    <g transform={`translate(${ML},${MT})`}>
      {rateTicks.map((t) => grid(t, yr, `${t}%`))}
      {([[rs.archive, ARCHIVE_COLOR], [rs.gate, GATE_COLOR]] as const).map(([pts, color], k) => (
        <g key={k} pointerEvents="none">
          <path className="flow-rate-line" d={path(pts)} fill="none" style={{ stroke: color }} strokeWidth={1.5} />
          {pts.map((p, i) => p.y === null ? null : <circle key={i} className="flow-rate-dot" cx={cx(i)} cy={yr(p.y)} r={2.5} style={{ fill: color }} />)}
          {endLabel(k, color)}
        </g>
      ))}
      {hits("flow-tl-hit-rates", (i) => [cats[i].title, `archive rate: ${fmt(rs.archive[i])}`, `skip rate (gate): ${fmt(rs.gate[i])}`])}
    </g>
  );

  // Skip mix
  const mix = mixSeries(buckets, order, labels);
  const ym = yLinear(100, H_MIX);
  const notLive = gateNotLiveRun(buckets);
  const notLiveW = notLive > 0 ? bx(notLive - 1) + x.bandwidth() - bx(0) : 0;
  const mixBody = (
    <g transform={`translate(${ML},${MT})`}>
      {mix.length === 0 && <text className="flow-tl-empty-svg" x={innerW / 2} y={H_MIX / 2} dy="0.32em" textAnchor="middle" pointerEvents="none">{EMPTY_GATE}</text>}
      {buckets.map((b, bi) => { let acc = 0; return (
        <g key={bi}>{mix.map((s) => {
          const v = s.values[bi]; const y0 = acc; acc += v;
          if (!(s.counts[bi] > 0)) return null;
          const tip = (e: React.MouseEvent) => show(e, [cats[bi].title, `${s.name} ${s.counts[bi].toLocaleString("en-US")} (${v.toFixed(1)}%)`]);
          return <rect key={s.id} className="flow-tl-seg" x={bx(bi)} y={ym(acc)} width={x.bandwidth()} height={Math.max(0, ym(y0) - ym(acc))}
            style={{ fill: catColors[s.id] ?? UNCATEGORIZED_FILL }} stroke="var(--bg)" strokeWidth={0.5} onMouseEnter={tip} onMouseMove={tip} onMouseLeave={hide} />;
        })}</g>); })}
      {notLiveW >= 80 && <text className="flow-not-live" x={bx(0) + notLiveW / 2} y={H_MIX / 2} dy="0.32em" textAnchor="middle" pointerEvents="none">gate not live</text>}
    </g>
  );
  const axisG = <g transform={`translate(${ML},${MT})`}><BandAxis cats={cats} x={x} innerW={innerW} innerH={H_MIX} /></g>;
  const swatch = (color: string) => <span className="flow-tl-swatch" style={{ background: color }} />;

  return wrap(<>
    {row(H_VOL, "Volume by outcome", <><div className="flow-tl-title">Volume</div><div className="flow-tl-sub">captured, by outcome</div><div className="flow-tl-sub flow-tl-faint">colours = flow above</div></>, volume)}
    {row(H_RATE, "Archive and gate skip rates", <><div className="flow-tl-title">Rates</div><div className="flow-tl-sub">{swatch(ARCHIVE_COLOR)}archive rate</div><div className="flow-tl-sub">{swatch(GATE_COLOR)}skip rate (gate)</div></>, rates)}
    <div className="flow-tl-row">
      <div className="flow-tl-label"><div className="flow-tl-title">Skip mix</div><div className="flow-tl-sub">share of gate skips</div></div>
      <svg className="chart" viewBox={`0 0 ${plotW} ${H_MIX + MT + AXIS_H}`} width={plotW} height={H_MIX + MT + AXIS_H} role="img" aria-label="Skip category mix">{mixBody}{axisG}</svg>
    </div>
  </>);
}
