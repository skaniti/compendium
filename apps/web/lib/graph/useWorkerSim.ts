// Batch 03 (graph canvas port) Task group W -- the main-thread CLIENT for
// lib/graph/sim.worker.ts. Named `useWorkerSim.ts` per task-W-brief.md's
// file list, but the exported factory (`createWorkerSim`) is deliberately
// NOT a React hook: lib/graph/d3-graph-vendor.js's `render()` -- the
// function that actually owns this client's lifecycle from W2 onward --
// is a plain closure-based module function, not a component or a custom
// hook, and naming a plain factory `useXxx` would trip
// `react-hooks/rules-of-hooks` the moment it's called from there (a
// non-hook, non-component call site). A plain factory with explicit
// start/stop/reheat/dispose methods is also the more directly testable
// shape for this file's own StrictMode-lifecycle contract (create,
// dispose, create again -- exactly what a React effect's cleanup-then-
// remount does, without needing React Testing Library to prove it).
//
// "StrictMode-safe" here means: every worker this client ever creates is
// reachable through exactly one generation counter, bumped on every
// `start()` (supersedes any prior run -- task-W-brief.md W2: "no
// overlapping sims, no orphaned workers") and on `dispose()`. A message
// handler closes over the generation it was created with, so a message
// that arrives after that generation has been superseded or disposed is
// dropped rather than reaching the caller's callbacks -- covers BOTH "a
// re-layout stop()+start() supersedes the old run" and "an effect
// cleanup -> remount double-invoke (dev StrictMode) never lets the first,
// abandoned instance's late message leak into the second."

import type { MainToWorkerMessage, SimParams, SimStartPayload, WorkerToMainMessage } from "./sim-protocol";

/** The subset of the real `Worker` API this client depends on -- narrow on
 *  purpose so tests can substitute a lightweight fake without needing a
 *  real dedicated-worker environment (jsdom implements no `Worker` at
 *  all; see d3-graph-vendor.remount.test.ts's own fake for the same
 *  reason, reused via `vi.stubGlobal("Worker", ...)` so this client's
 *  DEFAULT factory below picks it up transparently). */
export interface WorkerLike {
  postMessage(message: MainToWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

export interface WorkerSimCallbacks {
  /** One call per `tick` message, positions in the `start` payload's node
   *  order (task-W-brief.md's locked encoding) -- including the very
   *  first one, which is the phyllotaxis seed, not a d3-force tick. */
  onTick: (positions: Float64Array) => void;
  /** One call per `end` message -- the run's final, settled positions. */
  onEnd: (positions: Float64Array) => void;
}

export interface WorkerSimOptions {
  /** Worker factory override, for tests. Defaults to constructing the
   *  real `lib/graph/sim.worker.ts` module worker via the ambient global
   *  `Worker` binding (read at CALL time, not at module-load time, so a
   *  test's `vi.stubGlobal("Worker", Fake)` -- installed before the
   *  caller under test ever runs -- is picked up with no explicit
   *  injection needed at the call site). */
  createWorker?: () => WorkerLike;
}

export interface WorkerSimController {
  /** Starts a fresh run against `payload`. Safe to call repeatedly on the
   *  SAME controller (each call supersedes any prior run: the previous
   *  worker is terminated and a new one spun up) -- this is what makes a
   *  single controller usable across GraphCanvas's re-layout triggers
   *  (graphVersion bump, window resize's re-fit, noise toggle) without
   *  the caller needing to dispose+recreate for every one. */
  start(payload: SimStartPayload): void;
  /** Tells the current run's worker to stop, and locally suppresses any
   *  further tick/end callbacks even if one was already in flight when
   *  `stop` was requested (the worker's own `stop` handling is
   *  best-effort async; this half is synchronous and unconditional). */
  stop(): void;
  /** Sends `reheat` to the current run's worker and re-enables callback
   *  delivery (undoes a prior `stop()`'s local suppression). A no-op if
   *  no run has ever been started, or the controller is disposed. */
  reheat(params?: Partial<SimParams>): void;
  /** Terminates the current worker (if any) and permanently disables this
   *  controller -- every method above becomes a no-op afterward, and any
   *  message already in flight from the terminated worker is dropped.
   *  Call from a React effect's cleanup. */
  dispose(): void;
}

function defaultCreateWorker(): WorkerLike {
  // `Worker` read off the global at call time (see WorkerSimOptions.createWorker's
  // comment) -- `{ type: "module" }` because sim.worker.ts uses real ES
  // module imports (`d3-force`), which only a module worker executes.
  return new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

export function createWorkerSim(callbacks: WorkerSimCallbacks, options: WorkerSimOptions = {}): WorkerSimController {
  const createWorker = options.createWorker ?? defaultCreateWorker;

  let worker: WorkerLike | null = null;
  let generation = 0;
  let suppressed = false;
  let disposed = false;

  function teardownWorker(): void {
    if (!worker) return;
    worker.onmessage = null;
    worker.terminate();
    worker = null;
  }

  function attachWorker(myGeneration: number): WorkerLike {
    const w = createWorker();
    w.onmessage = (event) => {
      // Dropped, not delivered, when: this controller is disposed; this
      // worker's generation has been superseded by a later start(); or a
      // stop() is currently suppressing delivery.
      if (disposed || myGeneration !== generation || suppressed) return;
      const data = event.data;
      if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") return;
      const msg = data as WorkerToMainMessage;
      if (msg.type === "tick") callbacks.onTick(msg.positions);
      else if (msg.type === "end") callbacks.onEnd(msg.positions);
    };
    return w;
  }

  return {
    start(payload) {
      if (disposed) return;
      teardownWorker();
      generation += 1;
      suppressed = false;
      worker = attachWorker(generation);
      const message: MainToWorkerMessage = { type: "start", ...payload };
      worker.postMessage(message);
    },
    stop() {
      if (disposed) return;
      suppressed = true;
      worker?.postMessage({ type: "stop" });
    },
    reheat(params) {
      if (disposed || !worker) return;
      suppressed = false;
      worker.postMessage({ type: "reheat", params });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      teardownWorker();
    },
  };
}
