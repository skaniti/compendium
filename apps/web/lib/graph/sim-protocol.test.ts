import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkerSim, type WorkerLike } from "./useWorkerSim";
import type { MainToWorkerMessage, SimStartPayload, WorkerToMainMessage } from "./sim-protocol";

// Batch 03 (graph canvas port) Task group W, step W1 -- TDD-first protocol
// tests for lib/graph/useWorkerSim.ts's CLIENT contract (task-W-brief.md's
// locked message shapes), against a MOCKED Worker. This intentionally does
// NOT exercise the real lib/graph/sim.worker.ts pipeline (a real dedicated
// worker isn't available in jsdom, and the actual force-layout math is
// pure/independently portable -- see sim-layout.ts) -- it proves
// useWorkerSim.ts correctly implements start->ticks->end ordering,
// transferable/ordered positions pass-through, stop/reheat gating, inert
// handling of malformed messages, and StrictMode-safe lifecycle, all as
// black-box behavior driven by a fake worker the test fully controls.

/** Minimal fake satisfying WorkerLike -- records every message the client
 *  posts to it, and exposes `emit` for the test to simulate a message
 *  arriving FROM the worker (drives the client's `onmessage` handler
 *  directly, the same shape a real `MessageEvent` would have). */
class MockWorker implements WorkerLike {
  posted: MainToWorkerMessage[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(message: MainToWorkerMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test-only: simulate the worker sending `message` back to main. Also
   *  accepts arbitrary malformed payloads (not typed WorkerToMainMessage)
   *  to exercise the inertness contract. */
  emit(message: WorkerToMainMessage | Record<string, unknown> | null | undefined): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

function workerFactory(): { createWorker: () => WorkerLike; instances: MockWorker[] } {
  const instances: MockWorker[] = [];
  return {
    createWorker: () => {
      const w = new MockWorker();
      instances.push(w);
      return w;
    },
    instances,
  };
}

function fixturePayload(nodeIds: string[] = ["a", "b", "c"]): SimStartPayload {
  return {
    nodes: nodeIds.map((id) => ({ id, parent_id: null })),
    links: [],
    clusters: [],
    params: { charge: -80, linkDistance: 30, collideRadius: 12, alphaMin: 0.001 },
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
  };
}

function positionsFor(nodeIds: string[], fn: (i: number) => [number, number]): Float64Array {
  const arr = new Float64Array(nodeIds.length * 2);
  nodeIds.forEach((_, i) => {
    const [x, y] = fn(i);
    arr[i * 2] = x;
    arr[i * 2 + 1] = y;
  });
  return arr;
}

describe("useWorkerSim protocol contract (mocked Worker)", () => {
  let onTick: ReturnType<typeof vi.fn<(positions: Float64Array) => void>>;
  let onEnd: ReturnType<typeof vi.fn<(positions: Float64Array) => void>>;

  beforeEach(() => {
    onTick = vi.fn<(positions: Float64Array) => void>();
    onEnd = vi.fn<(positions: Float64Array) => void>();
  });

  it("delivers start -> ticks -> end in order, and posts the start message with the given payload", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    const payload = fixturePayload();

    controller.start(payload);
    expect(instances).toHaveLength(1);
    expect(instances[0].posted).toEqual([{ type: "start", ...payload }]);

    const seed = positionsFor(payload.nodes.map((n) => n.id), (i) => [i, i]);
    const mid = positionsFor(payload.nodes.map((n) => n.id), (i) => [i + 1, i + 1]);
    const final = positionsFor(payload.nodes.map((n) => n.id), (i) => [i + 2, i + 2]);

    instances[0].emit({ type: "tick", positions: seed });
    instances[0].emit({ type: "tick", positions: mid });
    instances[0].emit({ type: "end", positions: final });

    expect(onTick.mock.calls.map((c) => c[0])).toEqual([seed, mid]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(final);
    // Order: both ticks strictly before the end call.
    expect(onTick.mock.invocationCallOrder[0]).toBeLessThan(onEnd.mock.invocationCallOrder[0]);
    expect(onTick.mock.invocationCallOrder[1]).toBeLessThan(onEnd.mock.invocationCallOrder[0]);
  });

  it("passes positions through as a Float64Array in input-node order, untouched", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    const payload = fixturePayload(["node-1", "node-2", "node-3", "node-4"]);
    controller.start(payload);

    const positions = positionsFor(payload.nodes.map((n) => n.id), (i) => [i * 10, i * 10 + 1]);
    instances[0].emit({ type: "tick", positions });

    expect(onTick).toHaveBeenCalledTimes(1);
    const received = onTick.mock.calls[0][0] as Float64Array;
    expect(received).toBeInstanceOf(Float64Array);
    // Same order as payload.nodes: node-i's [x,y] lives at [2i, 2i+1].
    expect(Array.from(received)).toEqual([0, 1, 10, 11, 20, 21, 30, 31]);
    // The exact same typed array the "worker" sent -- proves nothing in
    // the client copies/reallocates it (the whole point of using a
    // transferable Float64Array over the wire in the real worker).
    expect(received).toBe(positions);
  });

  it("stop mid-flight produces no further ticks, even for a message already in flight", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    controller.start(fixturePayload());

    instances[0].emit({ type: "tick", positions: new Float64Array([1, 1, 2, 2, 3, 3]) });
    expect(onTick).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(instances[0].posted.at(-1)).toEqual({ type: "stop" });

    // A tick that was already "in flight" when stop() was requested (the
    // mock simulates the race directly, since the worker's own stop
    // handling is best-effort async) must not reach the callback.
    instances[0].emit({ type: "tick", positions: new Float64Array([4, 4, 5, 5, 6, 6]) });
    instances[0].emit({ type: "end", positions: new Float64Array([9, 9, 9, 9, 9, 9]) });

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("reheat restarts ticking after a stop() had suppressed delivery", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    controller.start(fixturePayload());
    controller.stop();

    instances[0].emit({ type: "tick", positions: new Float64Array([1, 1]) });
    expect(onTick).not.toHaveBeenCalled();

    controller.reheat();
    expect(instances[0].posted.at(-1)).toEqual({ type: "reheat", params: undefined });

    const positions = new Float64Array([7, 7, 8, 8]);
    instances[0].emit({ type: "tick", positions });
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(positions);
  });

  it("reheat forwards partial params overrides to the worker", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    controller.start(fixturePayload());

    controller.reheat({ alphaMin: 0.01 });
    expect(instances[0].posted.at(-1)).toEqual({ type: "reheat", params: { alphaMin: 0.01 } });
  });

  it("reheat before any start() is a no-op (no worker to message)", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });

    expect(() => controller.reheat()).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("ignores malformed or unknown message types without throwing", () => {
    const { createWorker, instances } = workerFactory();
    const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
    controller.start(fixturePayload());

    expect(() => {
      instances[0].emit(null);
      instances[0].emit(undefined);
      instances[0].emit("not-an-object" as unknown as Record<string, unknown>);
      instances[0].emit({});
      instances[0].emit({ type: 42 });
      instances[0].emit({ type: "settle" }); // unknown type
    }).not.toThrow();

    expect(onTick).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();

    // The channel still works afterward -- inertness doesn't wedge it.
    instances[0].emit({ type: "tick", positions: new Float64Array([1, 2]) });
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  describe("StrictMode-safe lifecycle", () => {
    it("start() supersedes a prior run on the SAME controller: old worker terminated, no overlapping sims", () => {
      const { createWorker, instances } = workerFactory();
      const controller = createWorkerSim({ onTick, onEnd }, { createWorker });

      controller.start(fixturePayload(["a"]));
      const first = instances[0];
      controller.start(fixturePayload(["b"])); // re-layout trigger
      const second = instances[1];

      expect(first.terminated).toBe(true);
      expect(second.terminated).toBe(false);

      // A late tick from the SUPERSEDED worker must not reach the caller.
      first.emit({ type: "tick", positions: new Float64Array([99, 99]) });
      expect(onTick).not.toHaveBeenCalled();

      second.emit({ type: "tick", positions: new Float64Array([1, 1]) });
      expect(onTick).toHaveBeenCalledTimes(1);
    });

    it("dispose() terminates the worker and drops any later message (simulated effect cleanup)", () => {
      const { createWorker, instances } = workerFactory();
      const controller = createWorkerSim({ onTick, onEnd }, { createWorker });
      controller.start(fixturePayload());
      const worker = instances[0];

      controller.dispose();
      expect(worker.terminated).toBe(true);

      worker.emit({ type: "tick", positions: new Float64Array([1, 1]) });
      worker.emit({ type: "end", positions: new Float64Array([2, 2]) });
      expect(onTick).not.toHaveBeenCalled();
      expect(onEnd).not.toHaveBeenCalled();

      // Every method is inert post-dispose -- no new worker, no throw.
      expect(() => {
        controller.start(fixturePayload());
        controller.stop();
        controller.reheat();
      }).not.toThrow();
      expect(instances).toHaveLength(1);
    });

    it("a double-mount (create -> dispose -> create again) never leaves two live workers", () => {
      const { createWorker, instances } = workerFactory();

      // First "mount" (StrictMode's throwaway invocation).
      const a = createWorkerSim({ onTick, onEnd }, { createWorker });
      a.start(fixturePayload());
      // Cleanup fires synchronously before the second invocation, exactly
      // as a React effect's returned cleanup does under StrictMode's
      // double-invoke.
      a.dispose();

      // Second "mount" (the one that actually persists).
      const b = createWorkerSim({ onTick, onEnd }, { createWorker });
      b.start(fixturePayload());

      expect(instances).toHaveLength(2);
      expect(instances[0].terminated).toBe(true);
      expect(instances[1].terminated).toBe(false);

      // The abandoned first mount's worker "catching up" and sending a
      // late message must not leak into either controller's callbacks.
      instances[0].emit({ type: "tick", positions: new Float64Array([1, 1]) });
      expect(onTick).not.toHaveBeenCalled();

      instances[1].emit({ type: "tick", positions: new Float64Array([2, 2]) });
      expect(onTick).toHaveBeenCalledTimes(1);
    });
  });
});
