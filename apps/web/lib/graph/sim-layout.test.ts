import { describe, it, expect } from "vitest";
import { createSimEngine, hashId, mulberry32, PHASE2_TICKS } from "./sim-layout";
import type { SimStartPayload } from "./sim-protocol";

// Batch 03 (graph canvas port) Task group W -- sanity/determinism coverage
// for the pure force-layout engine sim.worker.ts drives (not required by
// task-W-brief.md's step list, which only names sim-protocol.test.ts, but
// cheap insurance ahead of the expensive W4 CDP determinism check: a bug
// here is far cheaper to catch against a synthetic dataset in vitest than
// against a real dataset in a browser trace).

function payload(overrides: Partial<SimStartPayload> = {}): SimStartPayload {
  return {
    nodes: [
      { id: "p1", parent_id: "c1" },
      { id: "p2", parent_id: "c1" },
      { id: "p3", parent_id: "c2" },
      { id: "p4", parent_id: "c2" },
      { id: "p5", parent_id: "c2" },
      { id: "orphan", parent_id: "does-not-exist" },
    ],
    links: [{ source: "c1", target: "c2", weight: 0.5 }],
    clusters: [
      { id: "c1", name: "Cluster One", page_ids: ["p1", "p2"] },
      { id: "c2", name: "Cluster Two", page_ids: ["p3", "p4", "p5"] },
    ],
    params: { charge: -80, linkDistance: 30, collideRadius: 13, alphaMin: 0.001 },
    width: 800,
    height: 600,
    nodeRadius: 3,
    pageSpreadMult: 2.6,
    nebulaRadiusMult: 9,
    nebulaMinRadius: 200,
    scLabelTopPad: 10,
    scNameLineBudget: 12,
    scNameCharWidth: 25,
    labelDims: {},
    expandedGroups: {},
    ...overrides,
  };
}

function runToEnd(p: SimStartPayload): Float64Array {
  const engine = createSimEngine(p);
  let done = engine.done;
  while (!done) done = engine.step();
  return engine.snapshot();
}

describe("sim-layout SimEngine", () => {
  it("hashId/mulberry32 are pure and deterministic (same input -> same output, every call)", () => {
    expect(hashId("c1")).toBe(hashId("c1"));
    expect(hashId("c1")).not.toBe(hashId("c2"));
    const rngA = mulberry32(42);
    const rngB = mulberry32(42);
    expect([rngA(), rngA(), rngA()]).toEqual([rngB(), rngB(), rngB()]);
  });

  it("produces the seed as the first snapshot, before any step()", () => {
    const engine = createSimEngine(payload());
    const seed = engine.snapshot();
    expect(seed.length).toBe(12); // 6 nodes * 2
    // Not all zero -- Phase 1 + phyllotaxis seeding actually placed nodes.
    expect(Array.from(seed).some((v) => v !== 0)).toBe(true);
  });

  it("an orphaned parent_id freezes that node at width/2, height/2 for the whole run (vendor parity)", () => {
    const p = payload();
    const orphanIndex = p.nodes.findIndex((n) => n.id === "orphan");
    const engine = createSimEngine(p);
    const seed = engine.snapshot();
    expect(seed[orphanIndex * 2]).toBe(p.width / 2);
    expect(seed[orphanIndex * 2 + 1]).toBe(p.height / 2);

    let done = false;
    while (!done) done = engine.step();
    const final = engine.snapshot();
    expect(final[orphanIndex * 2]).toBe(p.width / 2);
    expect(final[orphanIndex * 2 + 1]).toBe(p.height / 2);
  });

  it("settles after exactly PHASE2_TICKS steps when at least one cluster has members", () => {
    const engine = createSimEngine(payload());
    expect(engine.done).toBe(false);
    let steps = 0;
    let done = false;
    while (!done) {
      done = engine.step();
      steps += 1;
    }
    expect(steps).toBe(PHASE2_TICKS);
  });

  it("settles immediately (done after construction) when no node resolves to a real cluster centroid", () => {
    const p = payload({
      nodes: [{ id: "solo", parent_id: "missing" }],
      clusters: [],
      links: [],
    });
    const engine = createSimEngine(p);
    expect(engine.done).toBe(true);
  });

  it("is deterministic: two engines built from the identical payload settle to identical positions", () => {
    const p = payload();
    const a = runToEnd(p);
    const b = runToEnd(structuredClone(p));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("every settled coordinate is finite (no NaN/Infinity leaking out of the force math)", () => {
    const final = runToEnd(payload());
    for (const v of final) expect(Number.isFinite(v)).toBe(true);
  });
});

// Delta #32 (sc-layout-separation) Task 4 -- three single-cluster super-
// clusters so Phase 1.5b's inter-SC repulsion loop actually engages
// (scKeys.length > 1), each with a realistic-length two-word SC name so
// plateFootprintAtRatio's wrap estimate exercises more than one line.
function threeScPayload(overrides: Partial<SimStartPayload> = {}): SimStartPayload {
  return {
    nodes: [
      { id: "p1", parent_id: "c1" },
      { id: "p2", parent_id: "c1" },
      { id: "p3", parent_id: "c2" },
      { id: "p4", parent_id: "c2" },
      { id: "p5", parent_id: "c3" },
      { id: "p6", parent_id: "c3" },
    ],
    links: [
      { source: "c1", target: "c2", weight: 0.5 },
      { source: "c2", target: "c3", weight: 0.5 },
    ],
    clusters: [
      { id: "c1", name: "Cluster One", page_ids: ["p1", "p2"], super_cluster: "Andromeda Megastructures" },
      { id: "c2", name: "Cluster Two", page_ids: ["p3", "p4"], super_cluster: "Cassiopeia Megastructures" },
      { id: "c3", name: "Cluster Three", page_ids: ["p5", "p6"], super_cluster: "Betelgeuse Megastructures" },
    ],
    params: { charge: -80, linkDistance: 30, collideRadius: 13, alphaMin: 0.001 },
    width: 600,
    height: 400,
    nodeRadius: 3,
    pageSpreadMult: 2.6,
    nebulaRadiusMult: 9,
    nebulaMinRadius: 200,
    scLabelTopPad: 10,
    scNameLineBudget: 12,
    scNameCharWidth: 25,
    labelDims: {},
    expandedGroups: {},
    ...overrides,
  };
}

describe("Phase 1.5b footprint-aware seeding (delta #32)", () => {
  const fp = {
    baseIconSize: 100, baseNameFontPx: 22, labelTopPad: 10, lineBudget: 12, charAdvanceEm: 25 / 30,
    scIcon: { k_min: 0.5, k_max: 1.15 }, scName: { k_min: 0.75, k_max: 2.0 }, pad: 2,
  };
  function settle(payload: SimStartPayload): Float64Array {
    const e = createSimEngine(payload);
    while (!e.step()) { /* run to end */ }
    return e.snapshot();
  }
  function scCentroids(payload: SimStartPayload, pos: Float64Array): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number; n: number }> = {};
    payload.clusters.forEach((c) => {
      if (!c.super_cluster) return;
      c.page_ids.forEach((pid) => {
        const i = payload.nodes.findIndex((n) => n.id === pid);
        const o = (out[c.super_cluster!] ??= { x: 0, y: 0, n: 0 });
        o.x += pos[i * 2]; o.y += pos[i * 2 + 1]; o.n++;
      });
    });
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { x: v.x / v.n, y: v.y / v.n }]));
  }
  it("spreads SC centroids at least as far apart as halo-only seeding, and stays deterministic", () => {
    const base = threeScPayload();
    const seeded = { ...base, scSeparation: { footprint: fp, minZoomRatio: 0.5, fitWorldPad: 155, hullPadding: 20, interGapPx: 8 } };
    const a = scCentroids(base, settle(base));
    const b = scCentroids(seeded, settle(seeded));
    const keys = Object.keys(a);
    let minA = Infinity, minB = Infinity;
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      minA = Math.min(minA, Math.hypot(a[keys[i]].x - a[keys[j]].x, a[keys[i]].y - a[keys[j]].y));
      minB = Math.min(minB, Math.hypot(b[keys[i]].x - b[keys[j]].x, b[keys[i]].y - b[keys[j]].y));
    }
    // Strict, not >=: observed margin for this fixture is ~82 world units
    // (base 447.29 vs seeded 529.88), so 1 unit of slack still fails if the
    // footprint term stops binding (e.g. scSeparation gets disconnected from
    // the repulsion loop) instead of passing vacuously on minB === minA.
    expect(minB).toBeGreaterThan(minA + 1);
    expect(settle(seeded)).toEqual(settle(seeded));
  });
});
