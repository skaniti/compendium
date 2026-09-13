// Graph interaction follow-ups, Batch B (spec docs/project-plans/2026-09-13-
// 183006-graph-interaction-followups/spec.md): tiny pub/sub so the vendor's
// zoom handler (lib/graph/d3-graph-vendor.js, plain JS, no React) can signal
// the current pan/zoom transform to Starfield.tsx without either side
// depending on the other's module shape. GraphCanvas.tsx wires the vendor's
// `onViewChange` callback (lib/graph/vendor.d.ts) to `publishView` below;
// Starfield.tsx subscribes via `subscribeView`. Deliberately NOT React
// state -- the vendor fires this on every zoom tick (pan/wheel/pinch, up to
// 60/s), and the plan's own comment on `onViewChange` requires subscribers
// to be cheap; Starfield writes a `transform` style directly in its
// subscriber instead of triggering a re-render per tick (see that
// component's own comment).

/** One pan/zoom transform snapshot, plus the transform `fitToContent` last
 *  established -- `fitX/fitY/fitK` are the reference point Starfield's
 *  parallax offset is measured from (dx = (x - fitX) * (fitK / k) * factor).
 */
export interface GraphView {
  x: number;
  y: number;
  k: number;
  fitX: number;
  fitY: number;
  fitK: number;
}

type Listener = (view: GraphView) => void;

const listeners = new Set<Listener>();
let latest: GraphView | null = null;

/** Subscribe to every future published view. Returns an unsubscribe
 *  function (React effect cleanup shape). Does NOT replay `latest` to a
 *  new subscriber -- callers that need the current value read `lastView()`
 *  explicitly (Starfield's dev hook re-applies it this way after a factor
 *  change). */
export function subscribeView(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Publish a new view to every current subscriber and record it as the
 *  latest. Called from the vendor's zoom handler via GraphCanvas.tsx's
 *  `onViewChange` wiring. */
export function publishView(view: GraphView): void {
  latest = view;
  for (const fn of listeners) fn(view);
}

/** The most recently published view, or null if the graph has never fired
 *  onViewChange (no mount yet). */
export function lastView(): GraphView | null {
  return latest;
}
