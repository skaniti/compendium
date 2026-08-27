"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { fetchGraph } from "@/lib/api";
import type { GraphNode, GraphPayload, TimeWindow } from "@/lib/types";

// Fetch-once graph cache (Task 5, batch 02). Several consumers -- header,
// canvas, panels -- each call useGraph() independently; without a
// module-level cache every one of them would fire its own GET /api/graph.
// This is a tiny external store (subscribe/getSnapshot, read via
// useSyncExternalStore) rather than one useEffect per hook instance, so
// concurrent mounts share the SAME in-flight request and the SAME resolved
// payload.

interface GraphCacheState {
  graph: GraphPayload | null;
  loading: boolean;
  error: Error | null;
  // Next equivalent of Dash's `graph-version` Store -- consumers (diary,
  // SUPERCLUSTERS card) refetch when it bumps. Increments only when a
  // refresh()-initiated flight COMMITS a new payload; the initial mount
  // load never bumps it (final-review M2 -- Dash bumps graph-version on
  // recluster/mutations, not on first paint, so the initial load keeps
  // version 0).
  graphVersion: number;
  // Task A1-3 (Step 3): the window the CURRENT graph reflects (or is being
  // fetched with) -- Dash's `graph-time-window` Store equivalent as read by
  // this cache. Not surfaced on UseGraphResult; GraphCanvas.tsx already
  // knows the active window directly from useTimeWindow() and only needs
  // setWindow() below to act on it. Tracked here so ensureLoaded()'s
  // mount-time kick-off and refresh()'s recluster-triggered refetch both
  // respect whatever window is CURRENTLY active instead of hardcoding "all".
  window: TimeWindow;
}

let cacheState: GraphCacheState = {
  graph: null,
  loading: false,
  error: null,
  graphVersion: 0,
  window: "all",
};
// The in-flight fetchGraph() promise, if any -- its mere presence is the
// dedupe key. Cleared on settle (success or failure) so a later refresh()
// can start a new flight.
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setCacheState(next: Partial<GraphCacheState>): void {
  cacheState = { ...cacheState, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): GraphCacheState {
  return cacheState;
}

// Starts the single shared fetchGraph() flight, or joins the one already in
// progress. Callers (ensureLoaded's mount-time kick-off, refresh(), and
// setWindow()) are responsible for clearing `inflight` first if they want to
// force a new flight rather than join an existing one.
//
// isRefresh distinguishes a refresh()-initiated flight (bumps graphVersion
// on commit) from the initial mount load (never bumps it) -- see
// GraphCacheState.graphVersion's own comment. `window` is the value THIS
// flight fetches with -- both callers pass their own window explicitly
// (ensureLoaded/refresh pass cacheState.window to preserve whatever's
// currently active, setWindow passes its new argument) rather than this
// function reading cacheState.window itself, so a rapid setWindow ->
// setWindow supersession (see the stale-flight guard below) can never
// confuse which flight was fetching which window.
//
// Stale-flight guard (final-review triage item 3): `flight` closes over
// THIS call's own promise chain. A superseded flight's settle handlers
// compare `inflight !== flight` before touching shared state, so an older
// flight that settles AFTER a newer one has started can neither clobber the
// newer flight's committed result nor null out its `inflight` registration
// (both handlers below check this before writing anything). Every
// comparison is safe despite `inflight` being reassigned after `flight` is
// constructed: `.then`/`.catch`/`.finally` callbacks only ever run as
// microtasks, strictly after the synchronous `inflight = flight` a few
// lines down has already executed. The SAME guard covers setWindow()'s own
// rapid-switch case (an older window's flight settling after a newer window
// was already selected) with no extra code -- it is just another `load()`
// call under the hood.
function load(isRefresh: boolean, window: TimeWindow): Promise<void> {
  if (inflight) return inflight;
  setCacheState({ loading: true, window });
  const flight: Promise<void> = fetchGraph(window)
    .then((payload) => {
      if (inflight !== flight) return; // superseded -- do not commit a stale result
      setCacheState({
        graph: payload,
        error: null,
        loading: false,
        graphVersion: isRefresh ? cacheState.graphVersion + 1 : cacheState.graphVersion,
      });
    })
    .catch((err) => {
      if (inflight !== flight) return; // superseded -- do not surface a stale error
      setCacheState({ error: err instanceof Error ? err : new Error(String(err)), loading: false });
    })
    .finally(() => {
      if (inflight === flight) inflight = null; // only clear OUR OWN registration
    });
  inflight = flight;
  return flight;
}

// Only kicks off a fetch if nothing is cached, nothing failed, and nothing
// is already in flight -- called from a useEffect (not render) so this
// never fires during SSR, where a relative `fetch("/api/graph")` would
// throw outside a browser context. Uses cacheState.window (default "all")
// rather than hardcoding "all" so a re-mount after setWindow() has already
// run (e.g. a fresh consumer joining after the window changed) still loads
// with the CURRENTLY active window instead of resetting to "all" -- though
// in practice this only ever fires once per page load, before any
// setWindow() call is even possible.
function ensureLoaded(): void {
  if (cacheState.graph || cacheState.error || inflight) return;
  void load(false, cacheState.window);
}

// Test-only reset -- mirrors the vendor one-shot init pattern elsewhere in
// this codebase (components/CompendiumLoader.tsx / Starfield.tsx's dynamic
// `import()`, which is ESM-cached and only initializes once per module
// load): this module-level cache would otherwise leak a fetched graph (or a
// stale in-flight promise) across unrelated test cases sharing the same
// Vitest module instance. Call this in beforeEach() in any test that
// exercises useGraph().
export function __resetGraphCacheForTest(): void {
  cacheState = { graph: null, loading: false, error: null, graphVersion: 0, window: "all" };
  inflight = null;
  listeners.clear();
}

export interface UseGraphResult {
  graph: GraphPayload | null;
  loading: boolean;
  error: Error | null;
  // Next equivalent of Dash's `graph-version` Store -- bumps by 1 each time
  // a refresh()-initiated flight commits a new payload (never on the
  // initial mount load). Consumers (DiaryPanel, the SUPERCLUSTERS card)
  // list this in their fetch effect deps to refetch after a recluster.
  graphVersion: number;
  // Refetches -- batch 03/Task 8 calls this after POST /api/recluster to
  // pick up the new clustering without a full page reload. Preserves
  // whatever window is currently active (see load()'s own comment) --
  // never silently resets the view back to "all".
  refresh: () => Promise<void>;
  // Task A1-3 (Step 3): TimeWindowProvider's second reader (the first is
  // the header's DATE RANGE pill's own active-className). GraphCanvas.tsx
  // calls this from an effect watching useTimeWindow()'s value. Design:
  // refetch-on-change, not window-keyed caching -- the backend itself does
  // not cache filtered (non-"all") results server-side either (see
  // fetchGraph's own comment), and there is exactly ONE active TimeWindow
  // app-wide (TimeWindowProvider is a single global provider, not
  // per-consumer), so there is nothing to gain from holding multiple
  // windows' payloads in memory at once -- consistent with useGraph's
  // existing single-slot cache contract (one graph, one graphVersion).
  // A no-op when `window` already matches the active one (idempotent,
  // mirrors lib/nav.ts's SET_WINDOW_FILTER re-click note). Bumps
  // graphVersion on commit (isRefresh=true) -- Dash's own
  // filter_graph_by_time_window bumps graph-version too (callbacks/
  // graph.py:78-108), and GraphCanvas's graphVersion-driven re-render
  // effect is the SAME mechanism a recluster's refresh() already uses, so
  // a window change re-renders the canvas for free via that one path.
  setWindow: (window: TimeWindow) => Promise<void>;
  nodeById: (id: string) => GraphNode | undefined;
  parentOf: (id: string) => GraphNode | undefined;
  breadcrumbFor: (nodeId: string) => GraphNode[];
}

// Cycle guard for breadcrumbFor's parent_id walk: a second, cruder backstop
// behind the visited-set check below. Mirrors topic_detail.py's
// _build_breadcrumbs `safety = 8` bound (there, Home -> SC -> Cluster ->
// Page is at most 4 hops) -- this is a general-purpose graph utility rather
// than that nav-specific walk, so the cap is generous rather than tuned to
// a known hierarchy depth.
const MAX_BREADCRUMB_HOPS = 64;

export function useGraph(): UseGraphResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Client-only kick-off (see ensureLoaded's own comment on why this can't
  // run during render/SSR). Every mounted consumer runs this effect; the
  // graph/error/inflight guard inside ensureLoaded means only the first one
  // to run actually starts a fetch.
  useEffect(() => {
    ensureLoaded();
  }, []);

  const refresh = useCallback(async () => {
    inflight = null; // drop any settled flight so load() is forced to start fresh
    await load(true, cacheState.window); // preserve the currently active window
  }, []);

  const setWindow = useCallback(async (window: TimeWindow) => {
    if (cacheState.window === window) return; // already active -- idempotent, no refetch
    inflight = null; // drop any in-flight fetch for the OLD window; force a fresh one
    await load(true, window);
  }, []);

  const nodeById = useCallback(
    (id: string): GraphNode | undefined => snapshot.graph?.nodes.find((n) => n.id === id),
    [snapshot.graph]
  );

  const parentOf = useCallback(
    (id: string): GraphNode | undefined => {
      const node = nodeById(id);
      if (!node?.parent_id) return undefined;
      return nodeById(node.parent_id);
    },
    [nodeById]
  );

  const breadcrumbFor = useCallback(
    (nodeId: string): GraphNode[] => {
      const start = nodeById(nodeId);
      // Unknown id -> empty breadcrumb: there's nothing to show, mirroring
      // _build_breadcrumbs' own "return None when there's nothing to show"
      // contract for an absent selection (decided + documented here since
      // the brief left this fallback to be chosen).
      if (!start) return [];

      const chain: GraphNode[] = [];
      const visited = new Set<string>();
      let current: GraphNode | undefined = start;
      while (current && !visited.has(current.id) && chain.length < MAX_BREADCRUMB_HOPS) {
        visited.add(current.id);
        chain.unshift(current);
        current = current.parent_id ? nodeById(current.parent_id) : undefined;
      }
      return chain;
    },
    [nodeById]
  );

  return {
    graph: snapshot.graph,
    loading: snapshot.loading,
    error: snapshot.error,
    graphVersion: snapshot.graphVersion,
    refresh,
    setWindow,
    nodeById,
    parentOf,
    breadcrumbFor,
  };
}
