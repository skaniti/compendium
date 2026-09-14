// Ambient module declaration for lib/graph/d3-graph-vendor.js, the near-
// verbatim port of explorer's d3_graph.js (see that file's own header
// comment for the full de-Dash accounting). `allowJs` is false project-wide
// (tsconfig.json) and tsconfig's `include` only covers `**/*.ts`/`**/*.tsx`,
// so this plain `.js` file has no inferred shape -- this declaration is
// what lets `import("@/lib/graph/d3-graph-vendor.js")` (components/
// GraphCanvas.tsx) type-check. Unlike lib/vendor/vendor.d.ts's *.js wildcard
// (those files are side-effect-only, no exports), this module has real
// named exports, so they're typed here individually rather than left `any`.
//
// Keep in sync with the vendor file's own "S2 module exports" block (EOF)
// if the export set ever changes.

declare module "@/lib/graph/d3-graph-vendor.js" {
  import type { GraphPayload } from "@/lib/types";
  import type { GraphDefaults } from "@/lib/graph/constants";
  import type { IconEntry } from "@/lib/icons";
  import type { GraphView } from "@/lib/graph/view-bus";

  export interface GraphRenderOptions {
    // Fired from writeTapStore (selectNode/selectCluster/clearSelection) --
    // kind is 'node' | 'cluster' | null (null on clear), id is the
    // corresponding page/cluster id or null. Sandbox: console stub.
    onSelect?: (kind: string | null, id: string | null) => void;
    // Same shape window.__superClusterIcons carried in Dash -- see
    // lib/icon-data.json / lib/icons.tsx. Keyed by icon id.
    icons?: Record<string, IconEntry>;
    // Applied once at first mount; defaults to GRAPH_DEFAULTS when omitted
    // (see the vendor file's render wrapper). Typed as the FULL
    // GraphDefaults, not Partial<GraphDefaults>, deliberately: batch 03
    // task group B's real caller (GraphCanvas.tsx) resolves a saved
    // profile via lib/graph/tuner-snapshot.ts's resolveTunerSnapshot()
    // (which DOES return a Partial -- only the keys that pass its
    // TYPO_V/FOG_V gate) and merges it onto GRAPH_DEFAULTS
    // (`{...GRAPH_DEFAULTS, ...snapshot}`) BEFORE calling render() -- so
    // every real call site hands this a fully-populated object. Keeping
    // this field required-shape (not optional-key-by-key) is intentional:
    // the vendor's own applyTunerSnapshot only overwrites a module var
    // when the incoming key is present, so a caller passing a bare
    // sparse Partial directly (skipping the merge) would silently leave
    // stale values from a PREVIOUS mount in place for any omitted key on
    // a remount, instead of resetting them to GRAPH_DEFAULTS.
    tunerSnapshot?: GraphDefaults;
    // Re-applies the prior zoom/pan transform after a re-layout instead of
    // snapping back to fit-to-content (mirrors the Dash tuner's re-layout
    // sliders' behavior).
    preserveView?: boolean;
    // Task group W (batch 03 Web Worker force sim, header comment delta
    // #19/#20): fired once, synchronously within the FIRST worker `tick`
    // message's handling (the phyllotaxis seed -- first painted
    // positions), not on render()'s own return. render() itself starts
    // the worker and returns immediately; this is how a caller learns
    // "the canvas actually painted something" now that render() being
    // synchronous no longer implies that. components/GraphCanvas.tsx's
    // mount effect wires this to window.__compendiumGraphRendered instead
    // of setting that flag right after calling render() (task-W-report.md
    // W3; lib/vendor/vendor.d.ts's Window augmentation documents the flag
    // itself).
    onFirstPaint?: () => void;
    // Batch 03 graph fix wave V4, item 2 (vendor header comment delta #31):
    // fired SYNCHRONOUSLY at the top of every REAL render() cycle -- mount,
    // graphVersion-bump re-render, and vendor-internal re-renders alike
    // (noise toggle, tuner change, knot expand) -- before the worker sim
    // even starts. components/GraphCanvas.tsx's settle veil raises on this
    // signal. Carried through an opts-omitting OR opts-sparse re-render
    // exactly like onFirstPaint is (see that field's own comment and the
    // vendor's delta #28/#31 for the full carry-forward mechanism) -- a
    // caller does not need to re-specify this on every render() call.
    onRenderCycleStart?: () => void;
    // Fired once finishRenderAfterSettle's chunk 3 completes -- after its
    // fitToContent call and after INITIATING (not waiting out) a
    // knot-expand's 500ms frame transition, which deliberately keeps
    // animating past this signal. components/GraphCanvas.tsx's settle veil
    // drops on this signal, and (batch 03 V4 item 3b) so does
    // CompendiumLoader.tsx's cold-load dismiss trigger -- moved here from
    // onFirstPaint so the loader holds until the canvas is actually fully
    // painted, not just started. Same carry-through contract as
    // onRenderCycleStart above -- never fires for the empty/error domains
    // (GraphCanvas.tsx never calls render() for those; see its own
    // comments for the equivalent wrapper-visible resolution).
    onSettleEnd?: () => void;
    // Batch B (spec: the 2026-09-13 graph-interaction-followups plan
    // (private), spec.md): fires on every 'zoom' tick -- pan, wheel, pinch,
    // the zoom-indicator's +/- buttons, and __d3ZoomTo alike, every path
    // funnels through the same d3-zoom handler -- AFTER the vendor's own
    // manual pan clamp has already been applied to the transform, so x/y/k
    // are the final, clamped values. fitX/fitY/fitK are the transform the
    // most recent fitToContent call established (or, before this mount's
    // first fit has run, the SAME tick's own x/y/k -- i.e. zero offset).
    // components/Starfield.tsx subscribes to this (via lib/graph/view-bus.ts
    // publishView, wired here by components/GraphCanvas.tsx) to pan the
    // starfield mount at a parallax factor of the graph's own pan. Called
    // MANY times per second during a drag/wheel gesture -- consumers must
    // be cheap (no React state per tick; write a style directly, as
    // Starfield.tsx does).
    onViewChange?: (view: GraphView) => void;
  }

  // A1-1 promotion (vendor header comment delta #11): returns a dispose()
  // handle that tears down this mount's document-level Escape keydown
  // listener + ResizeObserver -- callers should invoke it from their
  // effect teardown on final unmount (a remount, i.e. calling render()
  // again with a different container, already self-heals via the
  // wrapper's own container-swap guard and does not need this).
  export function render(
    container: HTMLElement,
    data: GraphPayload,
    opts?: GraphRenderOptions
  ): () => void;

  // Palette-change hook (promotion wires this to ThemeProvider); unused by
  // the sandbox.
  export function recolor(): void;

  // Dev/CDP debug aliases -- also attached to window.__d3* when
  // NODE_ENV !== "production" (see the vendor file's header comment,
  // delta #7). Loosely typed; not part of the sandbox's own contract.
  export function setSelection(type: string, id: unknown): void;
  // Task A1-3 (header comment delta #15): the independent filter-dim layer
  // (NavProvider's filterHighlightIds) -- NOT routed through setSelection.
  // Task V3 item 1 (delta #27, user ruling 2026-08-10, P1) reversed the
  // original union: updateHighlighting() now only applies this layer when
  // NO selection is active -- a selection, once present, wins outright and
  // this layer does not render. Empty array/undefined clears the filter
  // (dims nothing).
  export function setFilterDim(nodeIds: string[] | undefined): void;
  export function toggleNoise(show: boolean): void;
  export function frameNodes(nodeIds: string[], visibleH?: number): void;
  export function getClusterPages(clusterId: string): string[];
  export function hasNode(nodeId: string): boolean;
  export function debugGetSelection(): Record<string, unknown>;
  export function resetTunerToDefaults(): boolean;
  export function applyTunerOverrides(partial: Partial<GraphDefaults>): boolean;
  export const expandedGroups: Record<string, boolean>;
}
