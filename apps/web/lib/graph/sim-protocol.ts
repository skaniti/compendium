// Batch 03 (graph canvas port) Task group W -- the main-thread <-> Web
// Worker message-shape contract for lib/graph/sim.worker.ts, the worker
// that now owns the force-layout pipeline previously run synchronously
// inline in lib/graph/d3-graph-vendor.js's computeLayout (the ~600ms
// main-thread hitch task-W-brief.md exists to eliminate).
//
// Message TYPES and the tick/end positions encoding are LOCKED by
// task-W-brief.md's "Protocol" section, verbatim:
//   main->worker: {type:"start", nodes, links, params} | {type:"stop"} |
//     {type:"reheat", params?}
//   worker->main: {type:"tick", positions: Float64Array} (transferable;
//     [x0,y0,x1,y1,...] in input node order) | {type:"end", positions}
// Everything else here -- the `nodes`/`links`/`params` element shapes and
// the additional `start` fields beyond `params` -- is this port's own
// design within that contract (the brief explicitly leaves the node
// element shape "open" and allows extending `start` with new FIELDS for
// whatever dataset-level config the pipeline needs beyond `params`).

/** One page-node's pipeline INPUT. Deliberately minimal -- `id` anchors
 *  the node's slot in the `positions` Float64Array (input order) and is
 *  the join key the paint side uses to write settled coordinates back
 *  onto its own richer node objects; `parent_id` is Phase 2's per-cluster
 *  grouping key (d3-graph-vendor.js's `computeLayout`,
 *  "Phase 2: Arrange page nodes within clusters"). Every other GraphNode
 *  field (kind, label, visit_count, ...) is a paint-time-only concern and
 *  stays main-thread; sim-layout.ts never reads it. */
export interface SimNodeInput {
  id: string;
  parent_id: string | null;
}

/** One cluster-graph link -- Phase 1's forceLink input. `source`/`target`
 *  are CLUSTER ids (not page ids); the caller has already run its own
 *  edge-cleaning pass (self-edge removal + max-weight dedup) before
 *  building the `start` payload, so this is the vendor's already-cleaned
 *  `validLinks`, unfiltered further here. */
export interface SimLinkInput {
  source: string;
  target: string;
  weight: number;
}

/** One cluster's pipeline INPUT -- the GraphCluster fields Phase
 *  1/1.5/1.6 actually read. `super_cluster`/`group_id`/`group_tier` are
 *  optional because legacy or noise-only clusters may not carry them yet
 *  (GraphCluster's own comment, lib/types.ts). */
export interface SimClusterInput {
  id: string;
  name: string;
  page_ids: string[];
  super_cluster?: string;
  group_id?: number;
  group_tier?: string;
}

/** Real-valued sim knobs -- the LOCKED `params` shape.
 *
 *  `charge` / `linkDistance` feed Phase 1's forceManyBody / forceLink
 *  (vendor `computeLayout`, sim1's `.force('charge', ...)` /
 *  `.force('link', ...)`): charge is the forceManyBody strength (vendor
 *  default -80); linkDistance is the BASE of the per-link distance
 *  formula `linkDistance + 120 * (1 - weight)` (vendor default 30) -- the
 *  `120` spread and the cubic-weight strength formula were never
 *  tuner-exposed in the vendor either, so sim-layout.ts keeps them fixed
 *  internal constants instead of inventing new protocol fields for a
 *  tunability that doesn't exist upstream.
 *
 *  `collideRadius` feeds Phase 2's forceCollide (vendor:
 *  `(NODE_RADIUS + 2) * PAGE_SPREAD_MULT`) -- precomputed by the caller
 *  from its current NODE_RADIUS/PAGE_SPREAD_MULT module vars (both
 *  tuner-overridable).
 *
 *  `alphaMin` is applied to every simulation instance (`.alphaMin(...)`)
 *  for API completeness but does NOT gate phase completion -- see
 *  sim-layout.ts's header comment for why this pipeline uses FIXED tick
 *  counts (vendor parity: 400 Phase-1 ticks, 150 per Phase-2 cluster)
 *  rather than alpha-threshold stopping. */
export interface SimParams {
  charge: number;
  linkDistance: number;
  collideRadius: number;
  alphaMin: number;
}

/** Dataset-level config beyond `params` -- every field here mirrors one
 *  vendor module var or one vendor DOM-measurement pass that Phase
 *  1/1.5/1.6/2 read as free variables in the synchronous original; see
 *  each field's own comment for the exact read site it replaces. */
export interface SimStartPayload {
  nodes: SimNodeInput[];
  links: SimLinkInput[];
  clusters: SimClusterInput[];
  params: SimParams;
  width: number;
  height: number;
  /** NODE_RADIUS (vendor module var, tuner-overridable). Phase 2's
   *  phyllotaxis seed formula (`sqrt(i) * (NODE_RADIUS * 3 *
   *  PAGE_SPREAD_MULT)`) needs this SEPARATELY from params.collideRadius
   *  above -- the two formulas combine NODE_RADIUS/PAGE_SPREAD_MULT
   *  differently, so collideRadius alone can't reconstruct seed
   *  spacing. */
  nodeRadius: number;
  /** PAGE_SPREAD_MULT (vendor module var, tuner-overridable) -- see
   *  nodeRadius's comment; the phyllotaxis formula's other operand. */
  pageSpreadMult: number;
  /** NEBULA_RADIUS_MULT (vendor module var). Phase 1.5b/1.75/1.6's
   *  estimated-nebula-radius helper: `max(sqrt(n) * 9 *
   *  NEBULA_RADIUS_MULT, NEBULA_MIN_RADIUS)`. */
  nebulaRadiusMult: number;
  /** NEBULA_MIN_RADIUS (vendor module var) -- the floor in the same
   *  formula. */
  nebulaMinRadius: number;
  /** SC_LABEL_TOP_PAD (vendor module var) -- computeWatermarkBBox's
   *  icon-to-name vertical clearance, consumed by Phase 1.5a's
   *  ring-radius calc. */
  scLabelTopPad: number;
  /** Real DOM-measured label dims, keyed by cluster NAME (vendor's
   *  labelDimsCache). measureLabelDims() draws into a hidden SVG text
   *  element and reads getBBox() -- a DOM operation only the main thread
   *  can perform. The vendor still runs its existing pre-layout
   *  measurement pass unchanged and forwards the resulting cache here so
   *  Phase 1.75's shrinkwrap/label-bbox estimators use the SAME measured
   *  widths the pre-W2 synchronous pipeline used, instead of silently
   *  falling back to the char-width estimate for every cluster (which
   *  would shift Phase 1.75's push amounts and break layout parity). A
   *  cluster name absent from this map falls back to the char-width
   *  estimate in sim-layout.ts, identical to the vendor's own fallback
   *  branch for a name measureLabelDims never ran for. */
  labelDims: Record<string, { w: number; h: number }>;
  /** expandedGroups (vendor module var, mutated by the click-to-expand
   *  toggleGroupExpansion). Phase 1.6's isCollapsedCluster gate reads it
   *  to skip collapse-packing for a group the user has expanded this
   *  session. */
  expandedGroups: Record<string, boolean>;
}

export type SimStartMessage = { type: "start" } & SimStartPayload;

export interface SimStopMessage {
  type: "stop";
}

/** Restarts ticking for the CURRENT run (task-W-brief.md's locked shape;
 *  see sim.worker.ts's header comment for this pipeline's specific
 *  reheat semantics -- unexercised by the real W2 render() integration,
 *  which only ever uses start/stop, but implemented for protocol
 *  completeness). */
export interface SimReheatMessage {
  type: "reheat";
  params?: Partial<SimParams>;
}

export type MainToWorkerMessage = SimStartMessage | SimStopMessage | SimReheatMessage;

/** `positions` is `[x0, y0, x1, y1, ...]` in the `start` message's `nodes`
 *  order -- always a FRESH Float64Array (never the engine's own live
 *  backing array), sent transferable (`postMessage(msg, [positions.buffer])`)
 *  so a large dataset's per-tick payload is zero-copy. */
export interface SimTickMessage {
  type: "tick";
  positions: Float64Array;
}

export interface SimEndMessage {
  type: "end";
  positions: Float64Array;
}

export type WorkerToMainMessage = SimTickMessage | SimEndMessage;
