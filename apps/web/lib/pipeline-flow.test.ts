import { describe, it, expect } from "vitest";
import { BAR_W, FLOW_HEIGHT, FLOW_MIN_WIDTH, LABEL_PITCH, buildFlowModel, declutter, layoutFlow, ribbonPath } from "./pipeline-flow";
import type { FateKey, FlowDetail, FlowOutcomeKey, PipelineFlow } from "./types";

const fates = (archived: number, active = 0, pending = 0): Record<FateKey, number> => ({ archived, active, pending });
const d = (outcome: FlowOutcomeKey, key: string, count: number, f: Record<FateKey, number>, label = key): FlowDetail =>
  ({ outcome, key, label, count, top_domains: [], fates: f });

const flow = (over: Partial<PipelineFlow> = {}): PipelineFlow => ({
  total: 100,
  outcomes: [
    { key: "before_gate", label: "Archived before gate", count: 20, top_domains: [] },
    { key: "rule_filter", label: "Rule filter · no LLM", count: 15, top_domains: [] },
    { key: "gate", label: "Skipped by LLM gate", count: 40, top_domains: [] },
    { key: "processed", label: "Processed · kept", count: 25, top_domains: [] },
    { key: "pending", label: "Pending", count: 0, top_domains: [] },
  ],
  details: [
    d("before_gate", "placeholder", 12, fates(12)), d("before_gate", "manual", 8, fates(8)),
    d("rule_filter", "domain", 10, fates(10)), d("rule_filter", "url_pattern", 5, fates(5)),
    d("gate", "a", 15, fates(15)), d("gate", "b", 10, fates(10)), d("gate", "c", 6, fates(6)),
    d("gate", "d", 4, fates(4)), d("gate", "e", 2, fates(2)), d("gate", "uncategorized", 3, fates(3)),
    d("processed", "later_manual", 3, fates(3)), d("processed", "later_duplicate", 2, fates(2)), d("processed", "active", 20, fates(0, 20)),
  ],
  fates: [{ key: "archived", label: "Archived", count: 80 }, { key: "active", label: "Active", count: 20 }, { key: "pending", label: "Pending", count: 0 }],
  ...over,
});
const cats = { a: "#a", b: "#b", c: "#c", d: "#d", e: "#e", uncategorized: "#u" };

describe("buildFlowModel", () => {
  it("bundles gate categories past the top three when two or more remain", () => {
    const m = buildFlowModel(flow(), cats);
    const n = m.nodes.find((x) => x.id === "gate:smaller")!;
    expect(n.count).toBe(6);
    expect(n.label).toBe("2 smaller categories (legend ↓)");
    expect(n.strands).toHaveLength(2);
    const into = m.links.filter((l) => l.target === "gate:smaller");
    expect(into.map((l) => l.color)).toEqual(["#d", "#e"]);
    expect(m.nodes.find((x) => x.id === "gate:d")).toBeUndefined();
    expect(m.nodes.find((x) => x.id === "gate:uncategorized")).toBeDefined();
  });
  it("a single leftover category is shown individually", () => {
    const f = flow();
    f.details = f.details.filter((x) => x.key !== "e");
    const m = buildFlowModel(f, cats);
    expect(m.nodes.find((x) => x.id === "gate:smaller")).toBeUndefined();
    expect(m.nodes.find((x) => x.id === "gate:d")).toBeDefined();
  });
  it("archived-later parts merge with a sub-line omitting zeros", () => {
    const m = buildFlowModel(flow(), cats);
    const n = m.nodes.find((x) => x.id === "processed:later")!;
    expect(n.sub).toBe("3 manual · 2 duplicate");
    expect(n.count).toBe(5);
    expect(n.label).toBe("Archived later");
    expect(m.nodes.find((x) => x.id === "processed:later_manual")).toBeUndefined();
  });
  it("pending node and dashed band appear only when pending > 0", () => {
    const none = buildFlowModel(flow(), cats);
    expect(none.nodes.some((n) => n.id === "pending" || n.id === "fate:pending")).toBe(false);
    const f = flow({
      total: 105,
      outcomes: [...flow().outcomes.slice(0, 4), { key: "pending", label: "Pending", count: 5, top_domains: [] }],
      details: [...flow().details, d("pending", "waiting", 5, fates(0, 0, 5))],
      fates: [{ key: "archived", label: "Archived", count: 80 }, { key: "active", label: "Active", count: 20 }, { key: "pending", label: "Pending", count: 5 }],
    });
    const m = buildFlowModel(f, cats);
    expect(m.nodes.find((n) => n.id === "pending")?.dashed).toBe(true);
    expect(m.nodes.find((n) => n.id === "fate:pending")?.dashed).toBe(true);
    expect(m.links.find((l) => l.target === "fate:pending")?.dashed).toBe(true);
  });
  it("reconciles: link counts into and out of each node match its count", () => {
    const m = buildFlowModel(flow(), cats);
    for (const n of m.nodes.filter((x) => x.column > 0)) expect(m.links.filter((l) => l.target === n.id).reduce((a, l) => a + l.count, 0)).toBe(n.count);
  });
  it("zero total yields no nodes", () => {
    expect(buildFlowModel(flow({ total: 0 }), cats)).toEqual({ nodes: [], links: [] });
  });
});

describe("layoutFlow", () => {
  it("every column's node heights sum to ≤ FLOW_HEIGHT and each non-zero node ≥ 2px", () => {
    for (const f of [flow(), flow({ total: 3, outcomes: [{ key: "gate", label: "g", count: 1, top_domains: [] }, { key: "processed", label: "p", count: 2, top_domains: [] }], details: [d("gate", "a", 1, fates(1)), d("processed", "active", 2, fates(0, 2))], fates: [{ key: "archived", label: "A", count: 1 }, { key: "active", label: "B", count: 2 }, { key: "pending", label: "P", count: 0 }] })]) {
      const L = layoutFlow(f, cats, 1400);
      for (const c of [0, 1, 2, 3]) {
        const ns = L.nodes.filter((n) => n.column === c);
        expect(ns.reduce((a, n) => a + n.h, 0)).toBeLessThanOrEqual(FLOW_HEIGHT);
        for (const n of ns) { expect(n.h).toBeGreaterThanOrEqual(2); expect(n.y + n.h).toBeLessThanOrEqual(FLOW_HEIGHT + 0.001); }
      }
    }
  });
  it("many tiny nodes still fit and stay ≥ 2px", () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const f = flow({ total: 10000, outcomes: [{ key: "rule_filter", label: "r", count: 10000, top_domains: [] }], details: keys.map((k, i) => d("rule_filter", k, i === 0 ? 9971 : 1, fates(i === 0 ? 9971 : 1))), fates: [{ key: "archived", label: "A", count: 10000 }, { key: "active", label: "B", count: 0 }, { key: "pending", label: "P", count: 0 }] });
    const L = layoutFlow(f, {}, 1200);
    const ns = L.nodes.filter((n) => n.column === 2);
    expect(ns.every((n) => n.h >= 2)).toBe(true);
    expect(ns[ns.length - 1].y + ns[ns.length - 1].h).toBeLessThanOrEqual(FLOW_HEIGHT + 0.001);
  });
  it("breakdown labels are ≥ 14px apart after declutter", () => {
    const L = layoutFlow(flow(), cats, 1400);
    const ys = L.labels.filter((l) => L.nodes.find((n) => n.id === l.nodeId)!.column === 2).map((l) => l.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(LABEL_PITCH - 1e-9);
    expect(ys.every((y) => y <= FLOW_HEIGHT)).toBe(true);
  });
  it("zero total yields no nodes and no NaN", () => {
    const L = layoutFlow(flow({ total: 0, outcomes: [], details: [] }), cats, 1400);
    expect(L.nodes).toEqual([]);
    expect(L.links).toEqual([]);
    expect(JSON.stringify(L)).not.toContain("NaN");
  });
  it("width below FLOW_MIN_WIDTH lays out at FLOW_MIN_WIDTH", () => {
    const L = layoutFlow(flow(), cats, 400);
    expect(L.width).toBe(FLOW_MIN_WIDTH);
    expect(L.columnX[3]).toBe(FLOW_MIN_WIDTH - 230);
    expect(L.columnX[1]).toBeCloseTo(0.29 * FLOW_MIN_WIDTH);
    expect(layoutFlow(flow(), cats, 1500).width).toBe(1500);
  });
  it("ribbons attach to node edges and carry no NaN or negative heights", () => {
    const L = layoutFlow(flow(), cats, 1300);
    const by = new Map(L.nodes.map((n) => [n.id, n]));
    for (const l of L.links) {
      expect(l.x0).toBe(by.get(l.source)!.x + BAR_W);
      expect(l.x1).toBe(by.get(l.target)!.x);
      expect(l.h).toBeGreaterThanOrEqual(1);
    }
    expect(JSON.stringify(L)).not.toContain("NaN");
  });
  it("ribbonPath is a closed path with no NaN", () => {
    const p = ribbonPath(layoutFlow(flow(), cats, 1300).links[0]);
    expect(p.startsWith("M")).toBe(true);
    expect(p.endsWith("Z")).toBe(true);
    expect(p).not.toContain("NaN");
  });
});

describe("declutter", () => {
  it("keeps order, enforces pitch, and pushes up from the bottom", () => {
    expect(declutter([10, 12, 14], 14, 7, 300)).toEqual([10, 24, 38]);
    const out = declutter([290, 295, 299], 14, 7, 300);
    expect(out[2]).toBe(300);
    expect(out[1]).toBe(286);
    expect(out[0]).toBe(272);
  });
  it("is the identity when already spaced", () => {
    expect(declutter([20, 60, 100], 14, 7, 300)).toEqual([20, 60, 100]);
  });
});
