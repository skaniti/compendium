// Pure layout model for the Pipeline flow (Captured -> Outcome -> Breakdown -> Fate). No React, no DOM.
import { OUTCOME_COLOR } from "./pipeline";
import type { FateKey, FlowDetail, FlowOutcomeKey, PipelineFlow, TopDomain } from "./types";

export type FlowColumn = 0 | 1 | 2 | 3;
export interface FlowStrand { id: string; label: string; count: number; color: string }
export interface FlowNode {
  id: string; column: FlowColumn; label: string; count: number; color: string; dashed?: boolean; sub?: string;
  strands?: FlowStrand[]; topDomains: TopDomain[]; x: number; y: number; h: number;
}
/** Ribbon top-left at (x0,y0) on the source's right edge and (x1,y1) on the target's left edge, thickness h. */
export interface FlowLink { id: string; source: string; target: string; count: number; color: string; dashed?: boolean; x0: number; y0: number; x1: number; y1: number; h: number }
export interface FlowLabel { nodeId: string; x: number; y: number; anchor: "start" | "end" }
export interface FlowLayout { width: number; height: number; columnX: [number, number, number, number]; nodes: FlowNode[]; links: FlowLink[]; labels: FlowLabel[] }

export const FLOW_MIN_WIDTH = 1100, FLOW_HEIGHT = 380, BAR_W = 8, LABEL_PITCH = 14;
/** Reserved label heights: outcome labels are two lines (label + count); a breakdown label with a `sub` is two lines, others one. */
export const OUTCOME_LABEL_H = 30, SUB_LABEL_H = 2 * LABEL_PITCH;
const OUTCOME_GAP = 10, GROUP_GAP = 10, IN_GROUP_GAP = 3, FATE_GAP = 10, MIN_H = 2, MAX_NAMED_GATE = 3;

type ModelNode = Omit<FlowNode, "x" | "y" | "h"> & { group: string };
type ModelLink = Omit<FlowLink, "x0" | "y0" | "x1" | "y1" | "h">;

const FATES: FateKey[] = ["archived", "active", "pending"];
const FATE_COLOR: Record<FateKey, string> = { archived: "var(--flow-archived)", active: "var(--flow-processed)", pending: "var(--flow-pending)" };
const LATER_PARTS: [string, string][] = [["later_manual", "manual"], ["later_duplicate", "duplicate"], ["later_chrome", "chrome"], ["later_other", "other"]];
const CAPTURED_COLOR = "var(--flow-captured)";

function mergeDomains(lists: TopDomain[][]): TopDomain[] {
  const m = new Map<string, number>();
  for (const l of lists) for (const d of l) m.set(d.domain, (m.get(d.domain) ?? 0) + d.count);
  return [...m].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count).slice(0, 3); // a merged bundle ranks from the members' top-3 lists, so it is approximate
}
const sumFates = (ds: FlowDetail[]): Record<FateKey, number> => {
  const out: Record<FateKey, number> = { archived: 0, active: 0, pending: 0 };
  for (const d of ds) for (const f of FATES) out[f] += d.fates?.[f] ?? 0;
  return out;
};

export function buildFlowModel(flow: PipelineFlow, catColors: Record<string, string>): { nodes: Omit<FlowNode, "x" | "y" | "h">[]; links: Omit<FlowLink, "x0" | "y0" | "x1" | "y1" | "h">[] } {
  if (!(flow.total > 0)) return { nodes: [], links: [] };
  const nodes: ModelNode[] = [];
  const links: ModelLink[] = [];
  const dashedOf = (o: FlowOutcomeKey) => (o === "pending" ? true : undefined);
  nodes.push({ id: "captured", column: 0, label: "Captured", count: flow.total, color: CAPTURED_COLOR, topDomains: [], group: "captured" });

  // Breakdown nodes carry the fates of the details they stand for, for the fate links below.
  const fatesOf = new Map<string, Record<FateKey, number>>();
  const outcomes = flow.outcomes.filter((o) => o.count > 0);
  for (const o of outcomes) {
    nodes.push({ id: o.key, column: 1, label: o.label, count: o.count, color: OUTCOME_COLOR[o.key], dashed: dashedOf(o.key), topDomains: o.top_domains, group: "outcomes" });
    links.push({ id: `captured>${o.key}`, source: "captured", target: o.key, count: o.count, color: OUTCOME_COLOR[o.key], dashed: dashedOf(o.key) });
  }
  for (const o of outcomes) {
    const ds = flow.details.filter((d) => d.outcome === o.key && d.count > 0);
    const colorOf = (d: FlowDetail) => (o.key === "gate" ? catColors[d.key] ?? OUTCOME_COLOR.gate : OUTCOME_COLOR[o.key]);
    const add = (n: Omit<ModelNode, "column" | "group" | "topDomains"> & { topDomains: TopDomain[] }, fates: Record<FateKey, number>, strands?: FlowStrand[]) => {
      nodes.push({ ...n, column: 2, group: o.key });
      fatesOf.set(n.id, fates);
      if (strands) for (const s of strands) links.push({ id: `${o.key}>${n.id}:${s.id}`, source: o.key, target: n.id, count: s.count, color: s.color });
      else links.push({ id: `${o.key}>${n.id}`, source: o.key, target: n.id, count: n.count, color: n.color, dashed: n.dashed });
    };
    let bundled = new Set<string>();
    if (o.key === "gate") {
      const named = ds.filter((d) => d.key !== "uncategorized");
      const rest = [...named].sort((a, b) => b.count - a.count).slice(MAX_NAMED_GATE);
      if (rest.length >= 2) bundled = new Set(rest.map((d) => d.key));
    }
    const laterParts = o.key === "processed" ? ds.filter((d) => d.key.startsWith("later_")) : [];
    let laterDone = false, bundleDone = false;
    for (const d of ds) {
      if (bundled.has(d.key)) {
        if (bundleDone) continue;
        bundleDone = true;
        const members = ds.filter((x) => bundled.has(x.key));
        add({
          id: "gate:smaller", label: `${members.length} smaller categories (legend ↓)`, count: members.reduce((a, x) => a + x.count, 0),
          color: OUTCOME_COLOR.gate, topDomains: mergeDomains(members.map((x) => x.top_domains)),
          strands: members.map((x) => ({ id: x.key, label: x.label, count: x.count, color: catColors[x.key] ?? OUTCOME_COLOR.gate })),
        }, sumFates(members), members.map((x) => ({ id: x.key, label: x.label, count: x.count, color: catColors[x.key] ?? OUTCOME_COLOR.gate })));
        continue;
      }
      if (laterParts.includes(d)) {
        if (laterDone) continue;
        laterDone = true;
        const sub = LATER_PARTS.map(([k, name]) => [name, laterParts.find((x) => x.key === k)?.count ?? 0] as const).filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`).join(" · ");
        add({ id: "processed:later", label: "Archived later", count: laterParts.reduce((a, x) => a + x.count, 0), color: OUTCOME_COLOR.processed, sub, topDomains: mergeDomains(laterParts.map((x) => x.top_domains)) }, sumFates(laterParts));
        continue;
      }
      add({ id: `${o.key}:${d.key}`, label: d.label, count: d.count, color: colorOf(d), dashed: dashedOf(o.key), topDomains: d.top_domains }, sumFates([d]));
    }
  }
  for (const f of flow.fates.filter((x) => x.count > 0)) {
    nodes.push({ id: `fate:${f.key}`, column: 3, label: f.label, count: f.count, color: FATE_COLOR[f.key], dashed: f.key === "pending" ? true : undefined, topDomains: [], group: "fates" });
  }
  const fateIds = new Set(nodes.filter((n) => n.column === 3).map((n) => n.id));
  for (const n of nodes.filter((x) => x.column === 2)) {
    for (const f of FATES) {
      const c = fatesOf.get(n.id)?.[f] ?? 0;
      if (c > 0 && fateIds.has(`fate:${f}`)) links.push({ id: `${n.id}>fate:${f}`, source: n.id, target: `fate:${f}`, count: c, color: n.color, dashed: f === "pending" ? true : undefined });
    }
  }
  return { nodes: nodes.map(({ group: _g, ...n }) => { void _g; return n; }), links };
}

/**
 * Label centres, monotone, with each label's reserved box (height `heights[i]`, default `pitch`, centred on its y) kept clear of its neighbours.
 * The first box starts at or below `top - pitch/2` and the last ends at or above `bottom + pitch/2` (for default heights: first y >= top, last y <= bottom).
 * When the run does not fit, the back-sweep pushes earlier values up, possibly above `top`.
 */
export function declutter(ys: number[], pitch: number, top: number, bottom: number, heights?: number[]): number[] {
  const h = (i: number) => heights?.[i] ?? pitch;
  const out = ys.map((y, i) => (i === 0 ? Math.max(y, top + (h(0) - pitch) / 2) : y));
  const gap = (i: number) => (h(i) + h(i + 1)) / 2;
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap(i - 1));
  const last = out.length - 1;
  if (last >= 0 && out[last] > bottom - (h(last) - pitch) / 2) out[last] = bottom - (h(last) - pitch) / 2;
  for (let i = last - 1; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap(i));
  return out;
}

export function ribbonPath(l: FlowLink): string {
  const r = (n: number) => +n.toFixed(2);
  const mx = (l.x0 + l.x1) / 2;
  const { x0, y0, x1, y1, h } = l;
  return `M${r(x0)},${r(y0)} C${r(mx)},${r(y0)} ${r(mx)},${r(y1)} ${r(x1)},${r(y1)} L${r(x1)},${r(y1 + h)} C${r(mx)},${r(y1 + h)} ${r(mx)},${r(y0 + h)} ${r(x0)},${r(y0 + h)} Z`;
}

type Port = { count: number };
const linkThickness = (c: number, k: number) => Math.max(1, c * k);
/** A node is at least MIN_H and tall enough to hold both its stacked incoming and its stacked outgoing ribbons. */
function nodeHeight(count: number, ins: Port[], outs: Port[], k: number): number {
  const sum = (ps: Port[]) => ps.reduce((a, p) => a + linkThickness(p.count, k), 0);
  return Math.max(MIN_H, count * k, sum(ins), sum(outs));
}

/** Largest scale (px per page) at which the column, with ribbon-sized nodes and gaps, still fits FLOW_HEIGHT. */
function fitScale(heightAt: ((k: number) => number)[], total: number, gaps: number): number {
  if (total <= 0) return Infinity;
  const fits = (k: number) => heightAt.reduce((a, f) => a + f(k), 0) + gaps <= FLOW_HEIGHT;
  let lo = 0, hi = Math.max(0, FLOW_HEIGHT - gaps) / total;
  if (fits(hi)) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  return lo;
}

export function layoutFlow(flow: PipelineFlow, catColors: Record<string, string>, width: number): FlowLayout {
  const W = Math.max(Number.isFinite(width) ? width : 0, FLOW_MIN_WIDTH);
  const columnX: [number, number, number, number] = [0.115 * W, 0.29 * W, 0.55 * W, W - 230];
  const model = buildFlowModel(flow, catColors);
  if (model.nodes.length === 0) return { width: W, height: FLOW_HEIGHT, columnX, nodes: [], links: [], labels: [] };

  // Gap before each node: 10 between outcome nodes / fates, 10 between detail groups, 3 inside a group.
  const outcomeOf = new Map(model.links.map((l) => [l.target, l.source]));
  const gapBefore = (col: FlowNode["column"], prev: Omit<FlowNode, "x" | "y" | "h"> | undefined, n: Omit<FlowNode, "x" | "y" | "h">) => {
    if (!prev) return 0;
    if (col === 1) return OUTCOME_GAP;
    if (col === 3) return FATE_GAP;
    if (col === 2) return outcomeOf.get(prev.id) === outcomeOf.get(n.id) ? IN_GROUP_GAP : GROUP_GAP;
    return 0;
  };
  const cols: Omit<FlowNode, "x" | "y" | "h">[][] = [[], [], [], []];
  for (const n of model.nodes) cols[n.column].push(n);
  const gaps = cols.map((c) => c.reduce((a, n, i) => a + gapBefore(n.column, c[i - 1], n), 0));
  const insOf = (id: string) => model.links.filter((l) => l.target === id);
  const outsOf = (id: string) => model.links.filter((l) => l.source === id);
  const heightFns = (c: typeof cols[number]) => c.map((n) => { const i = insOf(n.id), o = outsOf(n.id); return (k: number) => nodeHeight(n.count, i, o, k); });
  const k = Math.min(...cols.map((c, i) => fitScale(heightFns(c), c.reduce((a, n) => a + n.count, 0), gaps[i])));

  const nodes: FlowNode[] = [];
  cols.forEach((c, ci) => {
    let y = 0;
    c.forEach((n, i) => {
      y += gapBefore(n.column, c[i - 1], n);
      const h = nodeHeight(n.count, insOf(n.id), outsOf(n.id), k);
      nodes.push({ ...n, x: columnX[ci], y, h });
      y += h;
    });
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, i]));

  // Ribbon ports: stacked in target order at each source, in source order at each target.
  const linkH = (l: { count: number }) => linkThickness(l.count, k);
  const bySource = new Map<string, typeof model.links>();
  const byTarget = new Map<string, typeof model.links>();
  for (const l of model.links) {
    (bySource.get(l.source) ?? bySource.set(l.source, []).get(l.source)!).push(l);
    (byTarget.get(l.target) ?? byTarget.set(l.target, []).get(l.target)!).push(l);
  }
  const ports = (list: typeof model.links, key: "source" | "target") => [...list].sort((a, b) => order.get(a[key === "source" ? "target" : "source"])! - order.get(b[key === "source" ? "target" : "source"])!);
  const y0s = new Map<string, number>(), y1s = new Map<string, number>();
  for (const [id, list] of bySource) {
    let y = byId.get(id)!.y;
    for (const l of ports(list, "source")) { y0s.set(l.id, y); y += linkH(l); }
  }
  for (const [id, list] of byTarget) {
    let y = byId.get(id)!.y;
    for (const l of ports(list, "target")) { y1s.set(l.id, y); y += linkH(l); }
  }
  const links: FlowLink[] = model.links.map((l) => {
    const s = byId.get(l.source)!, t = byId.get(l.target)!;
    return { ...l, x0: s.x + BAR_W, y0: y0s.get(l.id) ?? s.y, x1: t.x, y1: y1s.get(l.id) ?? t.y, h: linkH(l) };
  });

  const labels: FlowLabel[] = [];
  const centre = (n: FlowNode) => n.y + n.h / 2;
  for (const n of nodes.filter((x) => x.column === 0)) labels.push({ nodeId: n.id, x: n.x - 8, y: centre(n), anchor: "end" });
  const outc = nodes.filter((x) => x.column === 1);
  const oys = declutter(outc.map(centre), LABEL_PITCH, OUTCOME_LABEL_H / 2, FLOW_HEIGHT - OUTCOME_LABEL_H / 2, outc.map(() => OUTCOME_LABEL_H));
  outc.forEach((n, i) => labels.push({ nodeId: n.id, x: n.x - 8, y: oys[i], anchor: "end" }));
  // A breakdown label with a sub-line reserves two lines; its box is centred 7px below the label's own y.
  const mid = nodes.filter((x) => x.column === 2);
  const shift = (n: FlowNode) => (n.sub ? (SUB_LABEL_H - LABEL_PITCH) / 2 : 0);
  const ys = declutter(mid.map((n) => centre(n) + shift(n)), LABEL_PITCH, LABEL_PITCH / 2, FLOW_HEIGHT - LABEL_PITCH / 2, mid.map((n) => (n.sub ? SUB_LABEL_H : LABEL_PITCH)));
  mid.forEach((n, i) => labels.push({ nodeId: n.id, x: n.x + BAR_W + 8, y: ys[i] - shift(n), anchor: "start" }));
  for (const n of nodes.filter((x) => x.column === 3)) labels.push({ nodeId: n.id, x: n.x + BAR_W + 8, y: centre(n), anchor: "start" });
  return { width: W, height: FLOW_HEIGHT, columnX, nodes, links, labels };
}
