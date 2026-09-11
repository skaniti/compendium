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
