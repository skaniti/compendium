// Graph interaction follow-ups, Batch B (spec: the 2026-09-13 graph-
// interaction-followups plan (private), spec.md): tiny pub/sub so the vendor's
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
 *  parallax offset is measured from, and `cx/cy` (fix review C1, 2026-09-13)
 *  is the canvas center that fit was centered on. Starfield's corrected
 *  formula is `dx = ((cx - fitX) * (1 - fitK/k) + (x - fitX) * (fitK/k)) *
 *  factor` (same for y) -- the `cx`/`fitK`/`k` term makes a pure zoom about
 *  the canvas center (no real world-space pan) report zero offset instead
 *  of the apparent screen-space shift zooming about a fixed point produces;
 *  see components/Starfield.tsx's own comment for the full derivation.
 */
export interface GraphView {
  x: number;
  y: number;
  k: number;
  fitX: number;
  fitY: number;
  fitK: number;
  cx: number;
  cy: number;
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
