"use client";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useChartTooltip } from "@/components/charts/ChartTooltip";
import { useContainerWidth } from "@/components/charts/useContainerWidth";
import { BAR_W, FLOW_MIN_WIDTH, OUTCOME_LABEL_H, layoutFlow, mergeDomains, ribbonOpacity, ribbonPath, type FlowNode } from "@/lib/pipeline-flow";
import { formatRatio, percentOf } from "@/lib/pipeline";
import type { PipelineFlow as Flow } from "@/lib/types";

const TOP = 36; // room for the column headers above the bars
const BOTTOM = 26; // room for the "Pending 0" markers under the last nodes
const HEADERS = ["CAPTURED", "OUTCOME", "BREAKDOWN", "FATE"];
const num = (n: number) => n.toLocaleString("en-US");

/** True while the scroller has more content to its right. */
export function canScrollRight(el: { scrollWidth: number; clientWidth: number; scrollLeft: number }): boolean {
  return el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
}

export default function PipelineFlow({ flow, catColors, ratio }: { flow: Flow; catColors: Record<string, string>; ratio: number }) {
  const [widthRef, measured] = useContainerWidth();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState(false);
  const ref = useCallback((el: HTMLDivElement | null) => { scroller.current = el; return widthRef(el); }, [widthRef]);
  useEffect(() => { // right-edge fade while the flow overflows its panel and is not scrolled to the end
    const el = scroller.current;
    if (!el) return;
    const check = () => setFade(canScrollRight(el));
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", check); ro?.disconnect(); };
  }, [measured, flow.total]);
  const { tooltip, show, hide } = useChartTooltip();
  if (!(flow.total > 0)) return <p className="dev-empty dev-empty-inline">No pages in this period.</p>;
  const layout = layoutFlow(flow, catColors, measured);
  const { width, height, columnX } = layout;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const hasNode = (id: string) => byId.has(id);
  const lastOf = (col: number) => [...layout.nodes].reverse().find((n) => n.column === col);
  const captured = flow.total;

  const nodeTip = (n: FlowNode) => (e: MouseEvent) => {
    const domains = n.id === "captured" ? mergeDomains(flow.outcomes.map((o) => o.top_domains)) : n.topDomains;
    const lines = [n.label, `${num(n.count)} · ${percentOf(n.count, captured).toFixed(1)}% of captured`];
    if (domains.length > 0) lines.push(n.id === "captured" ? "TOP DOMAINS (approx.)" : "TOP DOMAINS", ...domains.slice(0, 3).map((d) => `${d.domain}  ${num(d.count)}`));
    show(e, lines);
  };
  const strandTip = (nodeId: string, linkId: string) => (e: MouseEvent) => {
    const node = byId.get(nodeId);
    const strand = node?.strands?.find((s) => linkId.endsWith(`:${s.id}`));
    if (strand) show(e, [strand.label, num(strand.count)]);
  };
  const summary = `Pipeline flow: ${num(captured)} pages captured, ${flow.outcomes.map((o) => `${num(o.count)} ${o.label}`).join(", ")}; ${flow.fates.map((f) => `${num(f.count)} ${f.label}`).join(", ")}.`;
  const lblOf = new Map(layout.labels.map((l) => [l.nodeId, l]));

  return (
    <div className={`pipeline-flow-fade${fade ? " is-overflowing" : ""}`}>
    <div className="pipeline-flow-scroll" ref={ref}>
      <div className="chart-wrap" style={{ position: "relative", width, minWidth: FLOW_MIN_WIDTH }}>
        <svg className="pipeline-flow-svg" viewBox={`0 0 ${width} ${height + TOP + BOTTOM}`} width={width} height={height + TOP + BOTTOM} role="img" aria-label={summary}>
          {HEADERS.map((h, i) => (
            <text key={h} className="flow-colhead" x={i === 0 ? columnX[0] - 8 : columnX[i]} y={14} textAnchor={i === 0 ? "end" : "start"}>{h}</text>
          ))}
          <g transform={`translate(0,${TOP})`}>
            {layout.links.map((l) => (
              <path key={l.id} data-link={l.id} d={ribbonPath(l)} className="flow-ribbon" style={{ fill: l.color }} fillOpacity={ribbonOpacity(l.color)}
                stroke={l.dashed ? l.color : undefined} strokeDasharray={l.dashed ? "4 3" : undefined} strokeOpacity={l.dashed ? 0.6 : undefined}
                onMouseEnter={l.id.includes(":smaller:") ? strandTip(l.target, l.id) : undefined}
                onMouseMove={l.id.includes(":smaller:") ? strandTip(l.target, l.id) : undefined}
                onMouseLeave={l.id.includes(":smaller:") ? hide : undefined} />
            ))}
            {layout.nodes.map((n) => (
              <rect key={n.id} data-node={n.id} className="flow-node" x={n.x} y={n.y} width={BAR_W} height={n.h} rx={1} style={{ fill: n.color }}
                fillOpacity={n.dashed ? 0.5 : 1} stroke={n.dashed ? n.color : undefined} strokeDasharray={n.dashed ? "3 2" : undefined}
                onMouseEnter={nodeTip(n)} onMouseMove={nodeTip(n)} onMouseLeave={hide} />
            ))}
            {layout.nodes.map((n) => {
              const l = lblOf.get(n.id);
              if (!l) return null;
              if (n.column === 0) return (
                <g key={n.id} pointerEvents="none">
                  <text className="flow-cap" x={l.x} y={l.y - 22} textAnchor="end">CAPTURED PAGES</text>
                  <text className="flow-headline" x={l.x} y={l.y + 10} textAnchor="end">{num(n.count)}</text>
                </g>
              );
              if (n.column === 1) return (
                <g key={n.id} pointerEvents="none">
                  <text className="flow-label" x={l.x} y={l.y - 4} textAnchor="end">{n.label}</text>
                  <text className="flow-num flow-num-lg" x={l.x} y={l.y + 15} textAnchor="end">{num(n.count)}</text>
                </g>
              );
              if (n.column === 2) return (
                <g key={n.id} pointerEvents="none">
                  <text className="flow-label" x={l.x} y={l.y} dy="0.32em">{n.label} <tspan className="flow-num">{num(n.count)}</tspan></text>
                  {n.sub && <text className="flow-sub" x={l.x} y={l.y + 13} dy="0.32em">{n.sub}</text>}
                </g>
              );
              const key = n.id.slice("fate:".length);
              if (key === "pending") return (
                <text key={n.id} className="flow-cap flow-cap-pending" x={l.x} y={l.y} dy="0.32em" pointerEvents="none">{`PENDING ${num(n.count)}`}</text>
              );
              return (
                <g key={n.id} pointerEvents="none">
                  {key === "archived"
                    ? <text className="flow-cap" x={l.x} y={l.y - 12}>ARCHIVED</text>
                    : <text className="flow-cap flow-cap-active" x={l.x} y={l.y - 12}>ACTIVE · in your graph</text>}
                  {/* Same size for both fates: the band widths carry the proportion, the figures just state it. */}
                  <text className={key === "active" ? "flow-headline flow-headline-active" : "flow-headline"} x={l.x} y={l.y + 14}>{num(n.count)}</text>
                  {key === "archived" && <text className="flow-ratio" x={l.x} y={l.y + 32}><tspan className="flow-ratio-pct">{formatRatio(ratio)}</tspan><tspan>{" archive ratio"}</tspan></text>}
                </g>
              );
            })}
            {!hasNode("pending") && lastOf(1) && (
              <text className="flow-pending-marker" x={lastOf(1)!.x - 8} y={Math.max(lastOf(1)!.y + lastOf(1)!.h + 18, (lblOf.get(lastOf(1)!.id)?.y ?? 0) + OUTCOME_LABEL_H / 2 + 12)} textAnchor="end" pointerEvents="none">Pending 0 ····</text>
            )}
            {!hasNode("fate:pending") && lastOf(3) && (
              <text className="flow-pending-marker" x={lastOf(3)!.x} y={lastOf(3)!.y + lastOf(3)!.h + 18} pointerEvents="none">···· PENDING 0</text>
            )}
          </g>
        </svg>
        {tooltip}
      </div>
    </div>
    </div>
  );
}
