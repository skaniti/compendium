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
  // (NavProvider's filterHighlightIds) -- unioned with setSelection's own
  // highlight set by updateHighlighting(), not routed through it. Empty
  // array/undefined clears the filter (dims nothing).
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
