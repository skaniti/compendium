// Batch 03 (graph canvas port) Task group W -- the Web Worker entry that
// owns the force-layout pipeline (lib/graph/sim-layout.ts) previously run
// synchronously inline in lib/graph/d3-graph-vendor.js's computeLayout.
// Thin glue only: this file owns the message protocol (lib/graph/
// sim-protocol.ts) and the paced tick loop; the actual math lives in
// sim-layout.ts (pure, data-only, independently unit-testable).
//
// No DOM/window read anywhere below -- `self` is narrowed to exactly the
// two members this file uses (see `WorkerScope` below) rather than typed
// against the ambient `webworker` lib, since this project's tsconfig.json
// sets `lib: ["dom", ...]` project-wide (single tsconfig, no per-file
// override) and `dom`/`webworker` declare incompatible globals (`self`
// chief among them) -- they can't both be in `lib` at once. The cast
// through `unknown` sidesteps that without touching the shared tsconfig.
//
// Pacing: this worker owns ALL of Phase 2's tick timing itself (manual
// `setTimeout`-paced frames calling `engine.step()`), rather than letting
// each per-cluster d3.forceSimulation run its own internal timer
// (`.restart()`) -- see sim-layout.ts's header comment for why: every
// simulation instance is created `.stop()`-ped and driven only by manual
// `.tick()` calls, exactly like the vendor's original blocking loops, so
// the ONLY behavioral difference from the pre-W2 pipeline is that those
// manual ticks are now spread across many frames instead of one blocking
// loop -- not a different tick count, not a different stopping rule.
// `setTimeout` (not `requestAnimationFrame`) because dedicated workers
// aren't guaranteed a `requestAnimationFrame` binding across browsers;
// d3-timer itself falls back to `setTimeout` in exactly this situation,
// so this matches what an internally-timed simulation would do anyway.
//
// reheat semantics: unexercised by the real W2 render() integration (its
// re-layout triggers -- graphVersion change, window change, noise toggle
// -- always stop the old run and start a fresh one, never reheat one in
// place), implemented here for the LOCKED protocol's completeness. See
// SimEngine.reheat's own comment for exactly what "restart ticking" means
// for this pipeline.

import { createSimEngine, type SimEngine } from "./sim-layout";
import type { MainToWorkerMessage, SimParams, SimStartPayload, WorkerToMainMessage } from "./sim-protocol";

interface WorkerScope {
  // Typed `unknown` rather than `MainToWorkerMessage` -- postMessage/
  // onmessage cross a structured-clone boundary with no runtime
  // validation, so a malformed payload is a real possibility this handler
  // must guard against (see the inertness check below), not something the
  // type system can rule out for us.
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: WorkerToMainMessage, transfer: Transferable[]) => void;
}

const ctx = self as unknown as WorkerScope;

// ~60fps pacing for the manual per-frame tick loop (see header comment).
const FRAME_MS = 16;

let engine: SimEngine | null = null;
let lastPayload: SimStartPayload | null = null;
let frameHandle: ReturnType<typeof setTimeout> | null = null;

function clearFrame(): void {
  if (frameHandle != null) {
    clearTimeout(frameHandle);
    frameHandle = null;
  }
}

function postTick(positions: Float64Array): void {
  ctx.postMessage({ type: "tick", positions }, [positions.buffer]);
}

function postEnd(positions: Float64Array): void {
  ctx.postMessage({ type: "end", positions }, [positions.buffer]);
}

function scheduleFrame(): void {
  clearFrame();
  frameHandle = setTimeout(() => {
    frameHandle = null;
    if (!engine) return;
    const done = engine.step();
    const positions = engine.snapshot();
    if (done) {
      postEnd(positions);
    } else {
      postTick(positions);
      scheduleFrame();
    }
  }, FRAME_MS);
}

function mergePayloadParams(payload: SimStartPayload, params: Partial<SimParams> | undefined): SimStartPayload {
  if (!params) return payload;
  return { ...payload, params: { ...payload.params, ...params } };
}

function handleStart(payload: SimStartPayload): void {
  clearFrame();
  lastPayload = payload;
  engine = createSimEngine(payload);
  // First posted message is always the phyllotaxis seed -- "first paint"
  // (task-W-brief.md: "First paint = phyllotaxis seed (or first tick)
  // exactly as A2's UX did"), posted unconditionally before any Phase-2
  // tick has run, matching the A2 spike's own flushAll()+notify()-before-
  // any-sim-tick sequencing.
  const seed = engine.snapshot();
  postTick(seed);
  if (engine.done) {
    // No cluster had any live-simmable member (e.g. every node orphaned) --
    // nothing will ever tick; settle immediately on the seed rather than
    // leaving the caller waiting on a run that was never going to move.
    postEnd(engine.snapshot());
    return;
  }
  scheduleFrame();
}

function handleStop(): void {
  clearFrame();
  // Abandon the in-flight run silently -- no further tick/end messages,
  // and no closing message either (task-W-brief.md: re-layout triggers
  // stop the old run and immediately start a new one; the old run just
  // stops producing output, it doesn't get a final message). `lastPayload`
  // is deliberately NOT cleared -- a later `reheat` with no intervening
  // `start` can still restart from it (see handleReheat).
  engine = null;
}

function handleReheat(params: Partial<SimParams> | undefined): void {
  if (!engine) {
    // No active run (never started, or a prior `stop`) -- restart from
    // the last known payload if there is one; otherwise this is a no-op
    // (nothing to reheat).
    if (!lastPayload) return;
    handleStart(mergePayloadParams(lastPayload, params));
    return;
  }
  engine.reheat(params);
  if (frameHandle == null) scheduleFrame();
}

ctx.onmessage = (event) => {
  const data = event.data;
  // Malformed/unknown message types are inert -- no throw, no reply.
  if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") return;
  const msg = data as MainToWorkerMessage;
  switch (msg.type) {
    case "start":
      handleStart(msg);
      return;
    case "stop":
      handleStop();
      return;
    case "reheat":
      handleReheat(msg.params);
      return;
    default:
      return;
  }
};
