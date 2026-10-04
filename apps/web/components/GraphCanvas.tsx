"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api";
import { patchPreferences } from "@/lib/preferences";
import { useSession } from "./SessionProvider";
import { useNav } from "./NavProvider";
import { useTheme } from "./ThemeProvider";
import { useTimeWindow } from "./TimeWindowProvider";
import { useGraph } from "@/hooks/useGraph";
import iconDataRaw from "@/lib/icon-data.json";
import type { IconEntry } from "@/lib/icons";
import { GRAPH_DEFAULTS, type GraphDefaults } from "@/lib/graph/constants";
import { resolveTunerSnapshot } from "@/lib/graph/tuner-snapshot";
import { publishView } from "@/lib/graph/view-bus";

// Type-only handle onto the vendor module's own shape (lib/graph/vendor.d.ts)
// -- used below to type renderRef, which holds the raw render() binding
// captured at mount time for direct reuse on later graphVersion bumps
// (Step 2/1a) without re-running the dynamic import().
type GraphVendorModule = typeof import("@/lib/graph/d3-graph-vendor.js");

// Task A1-1 (batch 03 graph canvas port) -- the promotion commit. Moved
// verbatim from components/sandbox/GraphA1.tsx (Task S2's "A1: port-intact"
// sandbox spike, the F2 bake-off winner), now mounted in the center panel
// in place of the deleted components/GraphPlaceholder.tsx, and merged with
// that file's own content per its TODO(mig-03) markers (both transcribed
// in full in task-A1-1-report.md's Step 1 section -- summary below).
//
// GraphPlaceholder had TWO TODO(mig-03) obligations, both honored here:
//  1. #compendium-empty-state's hidden/reveal behavior wires to REAL
//     node-count state instead of rendering unconditionally as a stand-in
//     (Dash parity, app.py:2662-2674's clientside callback:
//     `hidden = !(loaded && !hasNodes)` -- visible only once a fetch has
//     actually completed AND it reported zero nodes; hidden while loading
//     and hidden once real nodes exist). `hasNodes` below implements the
//     same two-part condition.
//  2. The dev-note placeholder text ("graph arrives in a later slice") is
//     deleted; the #graph-debug-overlay WRAPPER it lived in is NOT --
//     Dash's own wrapper persists indefinitely as the home for the
//     view-demo/return-to-admin triggers (graph_canvas.py:643-747; since
//     moved to the app header, components/Header.tsx) and a noise-toggle
//     text control (graph_canvas.py:724-733), the latter landing at Task
//     A1-3 Step 4 (#noise-toggle-btn below).
//
//     2026-08-24 (prod-mode sweep item 1): this port originally rendered
//     the outer wrapper unconditionally, deliberately NOT replicating
//     Dash's admin-context-only OUTER gate -- Dash's own 2026-07-13 roles
//     rework hides the WHOLE #graph-debug-overlay wrapper (including the
//     noise toggle) unless `role === 'admin' || admin_launched_demo`
//     (app.py:2785-2799's clientside callback), a change this port had not
//     yet mirrored; every role, including plain demo, could see it. That
//     gap is now closed: the whole wrapper below is gated on
//     `adminContext` (role === "admin" || actingAsDemo -- same predicate
//     as SearchBar.tsx's own admin-context gate), matching Dash exactly.
//

// `id="d3-graph-container"` matches the selector app/styles/theme.css
// already ported (batch 01) for the graph canvas mask + watermark/group-
// label/edge-chip rules, and is also GraphPlaceholder's former root id --
// the vendor's render() appends an <svg> into this same div via
// containerRef without touching its other children, so nesting the
// empty-state/debug-overlay divs inside it (like GraphPlaceholder did)
// works unchanged once real dots start painting alongside them.
//
// Fetch: GraphA1.tsx (pre-promotion) took `data` as a prop, fetched one
// level up in app/sandbox/graph-a1/page.tsx via 02's fetchGraph(). Since
// app/page.tsx does no data plumbing of its own (GraphPlaceholder mounted
// with zero props), that fetch moved down into this component at A1-1 --
// dropping the sandbox-only `performance.mark`/`onFirstPaint` plumbing
// that fed SandboxOverlayChip (Task S1, deleted that commit; see the
// brief's Step 3). A1-1 called fetchGraph() directly, once, with no
// re-render on later changes -- Task A1-3 (Step 2 below) rebinds this to
// hooks/useGraph.ts's shared module-cache instead: graphVersion bumps (a
// refresh()-initiated flight committing -- recluster elsewhere, or the
// time-window pill) now re-render the already-mounted vendor with fresh
// data, and multiple useGraph() consumers (header, panels, canvas) share
// one fetch rather than each firing their own.

interface IconDataFile {
  _category_order: string[];
  icons: Record<string, IconEntry>;
}
const iconData = iconDataRaw as IconDataFile;

const D3_GRAPH_CONTAINER_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  overflow: "hidden",
  position: "relative",
  zIndex: 1,
};

// Batch 03 graph fix wave V4, item 3: settle veil -- raised at the
// vendor's onRenderCycleStart, dropped at its onSettleEnd (both fire for
// every render cycle, including vendor-internal knot-expand re-renders --
// see lib/graph/d3-graph-vendor.js header comment delta #31 and
// lib/graph/vendor.d.ts's own field comments). `background:
// var(--container-bg)` matches #d3-graph-container's own transparent body
// (it shows .panel-center's `--container-bg` through -- app/styles/
// theme.css), so this reads as a plain, momentary pause rather than a
// visible flash. `zIndex: 20` sits above every other layer this
// container ever stacks (the vendor's own zoom indicator at z-index 10,
// its edge-chip layer at z-index 5, the debug overlay at z-index 3, the
// empty-state div at z-index 2, the bare <svg> itself unindexed) so
// nothing shows through during settle. `pointerEvents: "auto"` (NOT
// "none") is load-bearing: this is a plain sibling <div>, not a wrapper
// AROUND the <svg> -- a wheel/pointer/click event fired anywhere in this
// screen region targets the TOPMOST element in normal DOM hit-testing
// (this veil), and since d3-zoom's own listeners are registered directly
// on the <svg> node (a sibling, never an ancestor of this div), the event
// simply never reaches them. No onWheel/onClick/onPointerDown handlers of
// its own are needed to "swallow" anything -- z-index stacking + a
// non-"none" pointer-events value already fully intercepts every canvas
// gesture (wheel, drag, click, dblclick, touch/pinch) before it can reach
// the graph underneath.
const SETTLE_VEIL_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--container-bg)",
  pointerEvents: "auto",
};

const EMPTY_STATE_STYLE: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  textAlign: "center",
  maxWidth: "320px",
  zIndex: 2,
  opacity: "var(--dim-opacity, 0.7)",
  pointerEvents: "none",
};

const EMPTY_STATE_LEAD_STYLE: CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 500,
  color: "var(--text)",
  marginBottom: "8px",
};

const EMPTY_STATE_PRIVACY_STYLE: CSSProperties = {
  fontSize: "0.68rem",
  color: "var(--panel-caption)",
  fontStyle: "italic",
  lineHeight: 1.45,
};

const EMPTY_STATE_CTA_STYLE: CSSProperties = {
  display: "inline-block",
  marginTop: "10px",
  fontSize: "0.72rem",
  fontWeight: 500,
  color: "var(--highlight)",
  textDecoration: "none",
  pointerEvents: "auto",
};

// Ports graph_canvas.py's #graph-debug-overlay wrapper (:735-745) -- see
// this file's header comment (obligation 2) for what changed vs.
// GraphPlaceholder's own copy of this block (only the dev-note placeholder
// text is gone; everything else, including the not-yet-ported noise
// toggle's leading separators, is unchanged).
const GRAPH_DEBUG_OVERLAY_STYLE: CSSProperties = {
  position: "absolute",
  top: "8px",
  left: "8px",
  fontSize: "0.65rem",
  color: "var(--text)",
  opacity: 0.5,
  zIndex: 3,
  fontFamily: "monospace",
};

// Task A1-3 (Step 4): verbatim port of the noise-toggle span's inline style
// dict (graph_canvas.py:724-733's html.Span(id="noise-toggle-btn")). App CSS
// (app/styles/search-bar.css, already ported) supplies the hover filter
// and :focus/:focus-visible outline for this id -- see the JSX below for
// why this element is made keyboard-focusable (tabIndex) to actually
// trigger those rules, a deliberate a11y improvement Dash's own
// n_clicks-driven html.Span never had.
const NOISE_TOGGLE_STYLE: CSSProperties = {
  cursor: "pointer",
  color: "inherit",
  textDecoration: "none",
};

// Verbatim copy from graph_canvas.py's _EMPTY_STATE_BODY / _PRIVACY / _CTA
// (:50-61). See that module's comment block for the tone/framing rationale
// before re-tuning this text.
const EMPTY_STATE_BODY =
  "Install the extension and start browsing. Your compendium builds itself as you read.";
const EMPTY_STATE_PRIVACY =
  "Two ways, always your call: start a journey for a deliberate deep-dive, or leave it " +
  "on and let it gather quietly as you browse. Either way, it only ever feeds your " +
  "compendium — and you choose which mode runs.";
const EMPTY_STATE_CTA = "Get the extension ->";
// _EMPTY_STATE_CTA_HREF is a placeholder in Dash too (graph_canvas.py:61,
// still unset as of this port) -- falls back to "#" there and here.
const EMPTY_STATE_CTA_HREF = "";

const ERROR_STYLE: CSSProperties = {
  color: "var(--text)",
  opacity: 0.7,
  fontSize: "0.85rem",
};

// Task A1-2 wave 6: the vendor's showTooltip/hideTooltip/showLinesTooltip
// (lib/graph/d3-graph-vendor.js) look up `#node-tooltip` via
// document.getElementById and never create it themselves -- Dash's LAYOUT
// provides it (app.py:1917-1921, a top-level sibling of the three-panel
// view, deliberately OUTSIDE .app-header for the same containing-block-
// escape reason documented on #sc-popovers-portal above it). This mirrors
// Dash's element verbatim: id, className, and the initial inline
// style={"display": "none"} (d3_graph.js drives left/top/display from here
// on via element.style). Visual styling lives in app/styles/style.css's
// already-ported .node-tooltip rules. Rendered as a sibling of
// #d3-graph-container rather than nested inside it -- closer to Dash's own
// DOM placement, and harmless either way since position:fixed escapes to
// the viewport regardless of DOM nesting as long as no ancestor establishes
// a containing block (checked: neither #d3-graph-container nor
// .panel-center/.app-container has a transform/filter/backdrop-filter/
// will-change rule that would trap it).
const NODE_TOOLTIP_STYLE: CSSProperties = { display: "none" };

// Almagest graph tuner (Task 4, dev-only): production safety hinges on
// GraphCanvas.tsx never containing a top-level static import of the
// ./AlmagestTuner module -- that component imports "@/lib/almagest/params",
// which side-effect-loads the CommonJS glyph generator, and a static import
// here would pull the whole thing into every client bundle regardless of
// environment. The dynamic() call below (the only place this file spells
// the module specifier as a quoted string) is instead called from INSIDE
// this `development`-only ternary, so the call -- and the chunk it
// produces -- is only ever reached at runtime when NODE_ENV is
// "development"; a production build never executes this branch and the
// browser never fetches that chunk. (GraphCanvas.test.tsx asserts the
// no-static-import half of this directly by reading this file's own source
// text -- and asserts there is exactly one quoted reference to the module,
// so this comment deliberately avoids spelling it as a quoted string.)
const AlmagestTunerDev =
  process.env.NODE_ENV === "development" ? dynamic(() => import("./AlmagestTuner"), { ssr: false }) : null;

// Task group B (batch 03, spec decision C): resolves whatever saved tuner
// profile should apply BEFORE first paint -- Next-native, no boot latch, no
// timeout. A DEDICATED GET /api/auth/me call (not SessionProvider's own --
// that provider's hydration exposes role/showNoise only, and extending its
// contract to also carry `id`/full `preferences` is out of scope for this
// task) supplies both the `id` (userKey, namespaces the per-machine
// localStorage override) and the `preferences` sub-object
// resolveTunerSnapshot needs (lib/preferences.server.ts:255's own comment
// notes this is the SAME /api/auth/me endpoint that reader already
// consumes server-side -- no new endpoint here either). Swallows every
// failure to `{}` (code defaults), the same "never let a nice-to-have read
// break the UI" contract lib/preferences.ts's getPreferences already uses.
async function resolveTunerSnapshotFromMe(): Promise<Partial<GraphDefaults>> {
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) return {};
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return {};
    const me = data as { id?: unknown; preferences?: unknown };
    const userKey = typeof me.id === "number" || typeof me.id === "string" ? String(me.id) : null;
    const prefs = me.preferences;
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    return resolveTunerSnapshot(prefs, userKey, storage);
  } catch (err) {
    console.error("resolveTunerSnapshotFromMe failed:", err);
    return {};
  }
}

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const setSelectionRef = useRef<((type: string, id: unknown) => void) | null>(null);
  const recolorRef = useRef<(() => void) | null>(null);
  // Task A1-3 (Step 4): the vendor's toggleNoise(show) setter, captured at
  // mount like setSelectionRef/recolorRef above.
  const toggleNoiseRef = useRef<((show: boolean) => void) | null>(null);
  // Task A1-3 (Step 5): the vendor's setFilterDim(nodeIds) setter -- the
  // independent dimming layer (vendor header comment delta #15) that
  // composes with setSelection's own highlight set instead of clobbering
  // it (the A1-1-ratified gap this closes).
  const setFilterDimRef = useRef<((nodeIds: string[]) => void) | null>(null);
  // Task A1-3 (Step 2): the raw render() binding, captured once at mount so
  // a LATER graphVersion bump can re-invoke it directly (see the dedicated
  // effect below) without repeating the dynamic import() -- the module is
  // already loaded and cached by then (standard ESM import cache).
  const renderRef = useRef<GraphVendorModule["render"] | null>(null);
  // Task A1-3 (Step 1a/2): the graphVersion this component's vendor mount
  // currently reflects on screen -- null before the FIRST render() call has
  // happened. Guards the graphVersion-bump re-render effect below against
  // double-firing in the same commit as the mount effect (see that effect's
  // own comment for the exact race it closes).
  const lastRenderedVersionRef = useRef<number | null>(null);

  // Batch 03 graph fix wave V4, item 3: settle veil state. Covers the
  // bare-dots settle window (vendor onRenderCycleStart -> onSettleEnd,
  // lib/graph/d3-graph-vendor.js header comment delta #31) for every
  // render cycle -- mount, graphVersion-bump re-render, and vendor-
  // internal re-renders (noise toggle, tuner change, knot expand) this
  // component never calls render() for directly, which inherit the SAME
  // callbacks via the vendor's own opts carry-forward (delta #31's
  // generalization of delta #28's mechanism) with no extra wiring here.
  const [settleVeilVisible, setSettleVeilVisible] = useState(false);
  // Suppresses the veil for the FIRST cycle only -- CompendiumLoader.tsx's
  // full-screen curtain already covers cold load (item 3b: its own
  // dismiss signal now waits on this same onSettleEnd, see the mount
  // effect's onSettleEnd below), so double-covering with the veil
  // underneath would be redundant chrome-on-chrome. Design choice, not
  // the only valid one (the item's brief offered "layer it beneath"
  // as the alternative) -- documented here per that brief's own
  // "your call, document it." Flips permanently true the first time ANY
  // cycle reaches onSettleEnd; never reset, so a later graphVersion bump
  // or vendor-internal re-render always gets the veil.
  const hasSettledOnceRef = useRef(false);
  // Item 3c: failsafe -- a veil that never drops bricks the app. Cleared
  // on every onSettleEnd and on unmount (mount effect's cleanup below).
  const settleVeilTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSettleVeilTimeout = useCallback(() => {
    if (settleVeilTimeoutRef.current !== null) {
      clearTimeout(settleVeilTimeoutRef.current);
      settleVeilTimeoutRef.current = null;
    }
  }, []);
  // Wired as the vendor's onRenderCycleStart at every render() call site
  // below (mount + graphVersion-bump re-render) -- stable identity via
  // useCallback so passing it doesn't itself trigger extra effect churn.
  const handleSettleVeilRaise = useCallback(() => {
    if (!hasSettledOnceRef.current) return; // first cycle: the loader owns the cover
    setSettleVeilVisible(true);
    clearSettleVeilTimeout();
    settleVeilTimeoutRef.current = setTimeout(() => {
      console.warn(
        "GraphCanvas: settle veil force-dropped after 15s -- onSettleEnd never fired for this render cycle",
      );
      setSettleVeilVisible(false);
    }, 15000);
  }, [clearSettleVeilTimeout]);
  // Wired as the vendor's onSettleEnd at every render() call site below.
  // ALSO now owns the RENDERED-domain loader-dismiss signal (item 3b,
  // moved from onFirstPaint -- see the mount effect's own comment at its
  // call site for why) -- unconditional/idempotent, same "apply whatever
  // already exists" shape every other window.__compendiumGraphRendered
  // write site in this component already uses.
  const handleSettleVeilDrop = useCallback(() => {
    hasSettledOnceRef.current = true;
    window.__compendiumGraphRendered = true;
    clearSettleVeilTimeout();
    setSettleVeilVisible(false);
  }, [clearSettleVeilTimeout]);

  const { role, actingAsDemo, showNoise: sessionShowNoise } = useSession();
  const { state, dispatch, selectFromCanvas } = useNav();
  const { variant } = useTheme();
  const { timeWindow } = useTimeWindow();

  // Demo sessions (a direct demo login or an admin viewing as demo) get
  // 403'd by the backend on ANY preferences PATCH -- same derivation as
  // AppShell.tsx's isDemo, computed here directly since GraphCanvas already
  // reads role from useSession() and isn't threaded any props from a
  // server component.
  const isDemo = role === "demo";

  // 2026-08-24 (prod-mode sweep item 1): admin-context gate for the whole
  // #graph-debug-overlay wrapper below -- same predicate/comment precedent
  // as SearchBar.tsx's own adminContext (app.py's clientside callback
  // predicate, :2807-2830 for the search bar's gear/trace, :2785-2799 for
  // this overlay specifically): real admin role OR an admin currently
  // viewing as demo. Mirrors Dash's 2026-07-13 roles rework, which hides
  // the ENTIRE wrapper -- including the noise toggle -- for every other
  // role (plain "user", and plain/non-acting "demo").
  const adminContext = role === "admin" || actingAsDemo;

  // Task A1-3 (Step 4): noise toggle. Local state is the single source of
  // truth for BOTH the displayed label and what gets applied to the
  // vendor (via the effect below) -- seeded from the session's persisted
  // preference once hydration resolves (the seeding effect just below),
  // then owned by the click handler (handleToggleNoise) from then on.
  const [showNoise, setShowNoiseState] = useState(false);
  useEffect(() => {
    // Seeds local state from the session's persisted preference once
    // hydration resolves (see comment above); sessionShowNoise isn't
    // available synchronously at first render, so this can't be derived
    // during render instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from an external source, not derivable at render
    setShowNoiseState(sessionShowNoise);
  }, [sessionShowNoise]);
  // Always-current ref (same pattern as selectedNodeIdRef below) so the
  // vendor mount effect's async .then() applies whatever the LATEST noise
  // state is at import-resolution time, not a value stale-closed at
  // effect-definition time.
  const showNoiseRef = useRef(showNoise);
  showNoiseRef.current = showNoise;

  // Task A1-3 (Step 2): rebind from a local one-shot fetchGraph() effect to
  // the shared hooks/useGraph.ts cache -- graphVersion is the Next
  // equivalent of Dash's `graph-version` Store; refresh()-initiated flights
  // (recluster elsewhere, or a time-window change below) bump it, the
  // initial mount load does not (useGraph.ts's own documented contract).
  const { graph: payload, error: graphError, graphVersion, setWindow, refresh } = useGraph();
  const error = graphError?.message ?? null;

  // Task group B (spec decision C): kick off tuner-snapshot resolution
  // UNCONDITIONALLY at mount -- NOT gated on hasNodes/payload the way the
  // vendor mount effect below is -- so it runs WHILE the graph fetch
  // (useGraph()'s own mount-time kick-off, same commit as this effect) is
  // ALSO in flight, not sequentially after it. Stored in a ref (not state)
  // since nothing here needs to trigger a re-render -- the vendor mount
  // effect below reads tunerSnapshotPromiseRef.current directly. Runs
  // exactly once per mount (empty deps); a later remount (new GraphCanvas
  // instance) gets its own fresh promise.
  const tunerSnapshotPromiseRef = useRef<Promise<Partial<GraphDefaults>> | null>(null);
  useEffect(() => {
    tunerSnapshotPromiseRef.current = resolveTunerSnapshotFromMe();
  }, []);

  // Task A1-3 (Step 3): TimeWindowProvider's second reader (the DATE RANGE
  // header card is the first). useGraph()'s FIRST load already uses the
  // provider's (persisted) window, so on mount this setWindow() matches the
  // active window and is a no-op -- no second request, no graphVersion bump.
  // Later period changes refetch and bump graphVersion (useGraph.ts's
  // idempotence guard), reusing the SAME graphVersion-driven re-render
  // effect above -- no separate "window changed, redraw" path to keep in sync.
  useEffect(() => {
    void setWindow(timeWindow);
  }, [timeWindow, setWindow]);

  // A1-1 ledgered minor (task-A1-1-report.md / progress.md), FIXED here:
  // the vendor mount effect below applies whatever selection NavProvider
  // already holds at the moment its dynamic import() RESOLVES, not at the
  // moment the effect was DEFINED -- previously it closed over
  // `state.selectedNodeId` directly, so a selection made during the import
  // window (after the effect started, before the promise resolved) was
  // silently dropped until some LATER, unrelated nav action happened to
  // re-fire the separate inbound-wiring effect. A plain ref assigned every
  // render (not inside an effect) always reflects the LATEST value by the
  // time the async .then() below reads it.
  const selectedNodeIdRef = useRef(state.selectedNodeId);
  selectedNodeIdRef.current = state.selectedNodeId;
  // Task A1-3 (Step 5): same always-current-ref pattern as
  // selectedNodeIdRef above, for the SAME reason -- a filter dispatched
  // during the vendor's dynamic-import mount window must not be dropped.
  const filterHighlightIdsRef = useRef(state.filterHighlightIds);
  filterHighlightIdsRef.current = state.filterHighlightIds;

  // Task group B, Part 1 fix 2 (carried A1-3 correction, task-B-brief.md):
  // same always-current-ref pattern as selectedNodeIdRef/
  // filterHighlightIdsRef above, for the SAME class of bug -- a window
  // switch (or any other graphVersion-bumping commit) that lands DURING
  // the vendor's dynamic import() window must not paint the STALE
  // payload/graphVersion this effect closed over when it STARTED. Reading
  // these refs instead of the `payload`/`graphVersion` params inside the
  // async `.then()` below (payloadRef.current/graphVersionRef.current)
  // picks up whatever is CURRENT by the time the import resolves --
  // pre-fix, the mount effect closed over `payload`/`graphVersion`
  // directly, so a same-hasNodes window switch mid-import painted the old
  // window's data and recorded the old graphVersion, self-healing only on
  // some LATER, unrelated graphVersion bump.
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const graphVersionRef = useRef(graphVersion);
  graphVersionRef.current = graphVersion;

  // Obligation 1 (see header comment): visible only once a fetch has
  // actually completed AND it reported zero nodes -- `payload !== null`
  // stands in for Dash's `graphVersion > 0` ("loaded"). NOTE: now that a
  // REAL graphVersion is available (useGraph.ts), it is deliberately NOT
  // used here instead -- useGraph.ts's own contract is that the initial
  // mount load never bumps graphVersion (stays 0 forever until a
  // refresh()/window-change/mutation), so `graphVersion > 0` would never
  // become true from the initial load alone and the empty state would
  // never show. `payload !== null` ("a fetch has settled, regardless of
  // whether it bumped a version") remains the correct proxy.
  const hasNodes = payload !== null && payload.nodes.length > 0;
  const showEmptyState = payload !== null && !hasNodes;

  // Mount the vendor renderer once real graph data with at least one node
  // arrives. Mount-once by design (dynamic import() + svg/handler setup
  // only happens here) -- LATER graphVersion bumps re-invoke renderRef
  // directly via the dedicated effect below instead of re-running this one.
  useEffect(() => {
    if (!hasNodes) return;
    let cancelled = false;
    // Task group B (spec decision C): wait on BOTH the vendor's dynamic
    // import AND whatever tuner-snapshot resolution is already in flight
    // (kicked off unconditionally at mount, above -- by now it is very
    // likely already settled, since it started concurrently with the graph
    // fetch this effect is itself gated behind). This is NOT a boot latch:
    // there is no timeout and no fallback-after-N-ms -- the first render()
    // call below simply waits on a real, already-in-flight promise, the
    // same way it already waits on the vendor's own import(). A
    // fetch/resolveTunerSnapshotFromMe failure resolves to `{}` (see that
    // function's own comment), never rejects, so this can't hang.
    const tunerPromise = tunerSnapshotPromiseRef.current ?? Promise.resolve({});
    void Promise.all([import("@/lib/graph/d3-graph-vendor.js"), tunerPromise]).then(([vendor, tunerSnapshot]) => {
      // Task group B, Part 1 fix 2: read the ALWAYS-CURRENT payloadRef
      // here, not the `payload` param this effect closed over when it
      // started -- see payloadRef's own comment above for the race this
      // closes.
      if (cancelled || !containerRef.current || !payloadRef.current) return;
      renderRef.current = vendor.render;
      setSelectionRef.current = vendor.setSelection;
      // Task A1-2 wave 8: recolor() handle for the palette-change effect
      // below. Same module-scope-singleton-export shape as setSelection
      // above (lib/graph/d3-graph-vendor.js's `export { ... recolor,
      // ... }`) -- calling it reads/repaints whatever `currentData`/`svg`
      // the vendor module currently holds, no per-call arguments needed.
      recolorRef.current = vendor.recolor;
      toggleNoiseRef.current = vendor.toggleNoise;
      setFilterDimRef.current = vendor.setFilterDim;
      // Task group B, Part 1 fix 1 (carried A1-3 correction,
      // task-B-brief.md): apply the noise state BEFORE the first render()
      // call, not after. The vendor accepts toggleNoise() pre-render --
      // it writes __showNoise and no-ops the internal re-render (rawData
      // is still null the first time), so the ONE layout pass below
      // already reflects the correct state (see
      // d3-graph-vendor.remount.test.ts's "toggleNoise() call BEFORE the
      // first render()" case for that vendor-level contract). The OLD
      // order (render, THEN toggleNoise) painted the vendor's own
      // compile-time __showNoise default (true) on first paint regardless
      // of the actual pref, then toggleNoise's OWN internal re-render
      // (rawData now set) corrected it -- a full force layout running
      // TWICE per mount, with a visible flash of noise nodes whenever the
      // pref was false.
      vendor.toggleNoise(showNoiseRef.current);
      disposeRef.current = vendor.render(containerRef.current, payloadRef.current, {
        icons: iconData.icons,
        // Step 4: outbound wiring. selectFromCanvas resolves (kind, id) via
        // lib/nav.ts's resolveCanvasTapAction -- kind-with-missing-id is a
        // NO-OP (caller skips dispatch, handled inside selectFromCanvas
        // itself) and a background tap (kind === null) resolves to HOME.
        // Escape does NOT flow through here -- see the bubble-phase Esc
        // effect below and the vendor's own header comment delta #11 for
        // why routing Esc through this same callback would incorrectly
        // resolve to HOME too and wipe the nav filter.
        onSelect: (kind, id) => selectFromCanvas(kind as "node" | "cluster" | null, id ?? undefined),
        // Task group B (spec decision C): the FULL merged object, not the
        // bare (possibly sparse) Partial resolveTunerSnapshot returns --
        // every mount hands the vendor a FULLY populated snapshot so its
        // own per-key gate (applyTunerSnapshot) never interprets an
        // absent key as "leave whatever a PREVIOUS mount left this at"
        // (see lib/graph/tuner-snapshot.ts's own top-of-file comment and
        // vendor.d.ts's tunerSnapshot field comment for the full
        // reasoning). Plain-demo / no-profile paths resolve `tunerSnapshot`
        // to `{}` (see resolveTunerSnapshotFromMe's swallow-and-fall-back
        // contract), so this merge is then just GRAPH_DEFAULTS verbatim.
        tunerSnapshot: { ...GRAPH_DEFAULTS, ...tunerSnapshot },
        // Batch 03 graph fix wave V4, item 3: settle veil raise/drop
        // signals (lib/graph/d3-graph-vendor.js header comment delta #31).
        // handleSettleVeilRaise no-ops on this FIRST cycle (the loader
        // already covers it, see item 3b) -- see that handler's own
        // comment for the suppression design.
        onRenderCycleStart: handleSettleVeilRaise,
        onSettleEnd: handleSettleVeilDrop,
        // Batch B (spec: the 2026-09-13 graph-interaction-followups plan
        // (private), spec.md): publishes every pan/zoom tick to
        // lib/graph/view-bus.ts so components/Starfield.tsx can pan the
        // starfield mount at a parallax factor -- see that module's own
        // comment for why this is a plain pub/sub, not React state.
        onViewChange: publishView,
        // Task group W (batch 03 Web Worker force sim), W3 step: render()
        // itself is synchronous (it starts the worker and returns), but
        // "started" no longer means "painted" now that the force layout
        // runs off-thread -- see the write site below, right after this
        // call, for what used to fire here directly.
        //
        // Task V1 fix (vision-review fix loop, F1): ALSO the post-render
        // highlighting-apply site now, moved here from immediately after
        // this vendor.render() call. Task group B's original comment there
        // read "svg/currentData now exist (render() just built them), so
        // each call's own updateHighlighting() actually takes effect
        // immediately" -- true when it was written (render() was still
        // synchronous end-to-end), but Group W's async-worker refactor
        // silently invalidated it: svg/currentData existing is no longer
        // sufficient for updateHighlighting() to have anything to paint.
        // circle.page/use.star-spikes are created by paintPageDots, which
        // now only runs from the worker's first `tick` message -- this same
        // onFirstPaint signal -- strictly AFTER render() returns. Calling
        // vendor.setSelection/setFilterDim synchronously right after
        // vendor.render() (Task B's original site) raced an empty DOM:
        // svg.selectAll('circle.page') found nothing, so the dim/emphasis
        // attrs silently never landed, and nothing ever re-ran
        // updateHighlighting() once paintPageDots eventually created the
        // real elements (they got the plain resting-opacity defaults
        // instead, permanently, until the next explicit selection/filter
        // change). Live-verified via CDP (task-V1-report.md): vendor
        // internal state (selectedClusterId etc.) was correct, the visible
        // dim was not -- confirmed both for the FIRST mount (this site) and
        // for the graphVersion-bump re-render effect below (same fix
        // applied there). onFirstPaint is the vendor's own "DOM now exists"
        // signal (fires exactly once per render() call) -- the correct
        // place for a synchronous updateHighlighting()-driven reapply.
        onFirstPaint: () => {
          // Batch 03 graph fix wave V4, item 3b: the RENDERED-domain
          // window.__compendiumGraphRendered write moved OFF this callback
          // to handleSettleVeilDrop (wired as onSettleEnd above) -- the
          // loader now holds until the canvas is FULLY painted (settle-end),
          // not merely started (first paint), which also removes the
          // user-reported cold-load empty-canvas flash (the loader used to
          // dismiss while dots were still mid-settle). This callback still
          // owns the selection/filter reapply below, UNCHANGED (item 3d:
          // this V1-fix wiring and preserveView semantics stay untouched).
          //
          // Apply whatever selection NavProvider already holds by the time
          // the import resolves (see selectedNodeIdRef's own comment above
          // for why this reads the ref, not the closed-over `state` -- the
          // A1-1 fix). The inbound-wiring effect below only reacts to
          // LATER changes, so this covers the "already selected before/
          // during mount" case explicitly.
          if (selectedNodeIdRef.current) vendor.setSelection("node", selectedNodeIdRef.current);
          // Task A1-3 (Step 5): same pattern again, via filterHighlightIdsRef
          // (always current). Unconditional -- an empty array IS the
          // correct "no filter" call, not something to skip.
          vendor.setFilterDim(filterHighlightIdsRef.current);
        },
      });
      // Task group B, Part 1 fix 2 (continued): record via graphVersionRef,
      // not the closed-over `graphVersion` param -- the LATEST version by
      // resolution time, not whatever it was when this effect started.
      lastRenderedVersionRef.current = graphVersionRef.current;
      // Task group W, W3 step (batch 03 Web Worker force sim); RETIMED by
      // batch 03 V4 item 3b: render-complete signal for
      // components/CompendiumLoader.tsx's dismiss trigger now fires from
      // the `onSettleEnd` callback (handleSettleVeilDrop) passed into
      // vendor.render() above, not from reaching this line, and no longer
      // from `onFirstPaint` either -- render() itself is synchronous (it
      // starts the worker sim and returns), but that no longer implies
      // anything painted (the force layout runs off-thread), and "first
      // paint" (the worker's first `tick`) no longer implies FULLY painted
      // either (bare dots, pre-settle) -- lib/vendor/vendor.d.ts's Window
      // augmentation documents the flag itself; CompendiumLoader.tsx's
      // tryDismiss polls it alongside window.__compendiumLoader.
      // Idempotent regardless of how many times `onSettleEnd` fires (at
      // most once per render() call by the vendor's own contract, same as
      // onFirstPaint) -- the loader-side latch, not this flag, is what
      // makes a later re-signal a no-op. This is one of THREE write sites
      // for this flag (the other two -- the empty-state settle, and the
      // error settle -- are their own effects further down this component,
      // fix round 1/2 of task-A1-4-report.md, UNCHANGED by task group W:
      // they're settle states with no sim to wait on).
    });
    return () => {
      cancelled = true;
      disposeRef.current?.();
      disposeRef.current = null;
      renderRef.current = null;
      setSelectionRef.current = null;
      recolorRef.current = null;
      toggleNoiseRef.current = null;
      setFilterDimRef.current = null;
      // Item 3c: a disposed mount can never reach a later onSettleEnd for
      // whatever cycle was in flight -- drop the veil and its failsafe
      // timeout here too, rather than leaving either stranded until the
      // 15s timeout would otherwise fire against an already-torn-down mount.
      clearSettleVeilTimeout();
      setSettleVeilVisible(false);
    };
    // Mount-once against the first non-empty payload by design (see above);
    // selection is read via selectedNodeIdRef (always current, see its own
    // comment) rather than a dependency, live updates for LATER changes are
    // the separate inbound-wiring effect below, and selectFromCanvas is
    // NavProvider's stable convenience (identity only changes with `state`,
    // which this effect deliberately does not re-run on).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [hasNodes]);

  // Task A1-4 fix (coordinator-adjudicated in-scope, task-A1-4-report.md's
  // "fix" section -- not the speculative plumbing the original brief said
  // to avoid): the render-complete signal above only covers the "a real
  // graph painted" path. A compendium that settles into the EMPTY state
  // (payload committed, zero nodes -- showEmptyState, obligation 1 in this
  // file's header comment) is an equally "canvas settled" outcome, and a
  // first-time user with nothing captured yet is exactly the loader's own
  // first-run audience -- leaving this path unsignaled would strand it on
  // CompendiumLoader.tsx's ~10s MAX_TRIES fallback instead of dismissing
  // promptly. Fires whenever showEmptyState is true, including on a LATER
  // transition (a refetch that goes from having nodes back to zero, e.g. a
  // window filter with no results) -- unconditionally, same reasoning as
  // the mount effect's own write above: idempotent (already-true stays
  // true), and CompendiumLoader.tsx's own `completed` latch (not this
  // flag) is what actually enforces "the loader dismisses at most once" on
  // its side, so a later same-value write here from any path is always a
  // harmless no-op there. Task group W (batch 03 Web Worker force sim),
  // W3 step: UNCHANGED by the move to a worker-driven force layout -- the
  // empty state has no sim to wait on (the mount effect above never even
  // starts one for a zero-node payload), so "settled" still just means
  // "showEmptyState became true," same as before. Only the mount effect's
  // OWN write site moved (to vendor.render()'s new `onSettleEnd`
  // callback, batch 03 V4 item 3b -- see that effect's comment) -- this
  // one and the error-settle effect below are settle states with no sim,
  // and stay exactly as they were.
  //
  // Batch 03 V4 item 2/3: also drops the settle veil (idempotent no-op if
  // it was never raised) -- the vendor itself never fires onSettleEnd for
  // this domain (render() bails at its own empty-payload guard before
  // reaching any real cycle, see lib/graph/d3-graph-vendor.js header
  // comment delta #31's own note on this), so this is the "equivalent
  // wrapper-visible resolution" that keeps the veil from being stranded up
  // if a real cycle happened to still be mid-settle when a later refetch
  // (e.g. a window filter with no results) raced the canvas into empty.
  //
  // Fix round 1 (F1, reviewer finding): this is ALSO the sole resolution
  // point for hasSettledOnceRef when the canvas's FIRST-EVER outcome is
  // empty, not a real render -- handleSettleVeilDrop (the only OTHER
  // writer of that ref) never runs for this domain, since the vendor's
  // render() bails before onSettleEnd can fire. Without flipping it here
  // too, a cold load that starts empty and LATER gets real nodes (a
  // window filter, a first capture landing) would have the loader already
  // dismissed (the write above) but hasSettledOnceRef still false --
  // handleSettleVeilRaise would then suppress the veil on that first REAL
  // cycle as if it were still the loader-covered initial one, leaving a
  // bare, unveiled settle window with nothing covering it. Same
  // idempotent-write shape as the flag above (redundant once a real cycle
  // has already flipped it, harmless either way).
  useEffect(() => {
    if (!showEmptyState) return;
    window.__compendiumGraphRendered = true;
    hasSettledOnceRef.current = true;
    clearSettleVeilTimeout();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from an external source (the vendor's own settle-lifecycle signal), not derivable at render
    setSettleVeilVisible(false);
  }, [showEmptyState, clearSettleVeilTimeout]);

  // Task A1-4 fix round 2 (review Finding 1, task-A1-4-report.md's second
  // "fix" section): a REJECTED fetchGraph is ALSO a settled canvas -- the
  // "Couldn't load graph: ..." error message below (`error &&` branch) has
  // already painted, but `payload` stays null forever for this flight, so
  // neither the mount effect above NOR the showEmptyState effect above
  // ever fires (both require `payload !== null`). Without this, a backend
  // outage at page load would strand the loader on the same ~10s
  // MAX_TRIES fallback above an already-rendered error -- the pre-A1-4
  // stand-in dismissed this scenario in well under 200ms. Same
  // unconditional-write / idempotent / loader-latch-owns-exactly-once
  // reasoning as the two effects above: fires on every settle into the
  // error state, including a LATER one (a refresh() that fails again after
  // a prior success), and a later recovery into a real render (retry
  // succeeds) is just another same-value write, not a toggle.
  //
  // Batch 03 V4 item 2/3: also drops the settle veil, same reasoning as
  // the showEmptyState effect just above -- including F1's
  // hasSettledOnceRef flip (same rationale: this is the sole resolution
  // point when the canvas's FIRST-EVER outcome is an error, not a real
  // render, and a later successful retry must not have its veil
  // suppressed as if it were still the loader-covered initial cycle).
  useEffect(() => {
    if (!error) return;
    window.__compendiumGraphRendered = true;
    hasSettledOnceRef.current = true;
    clearSettleVeilTimeout();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from an external source (the vendor's own settle-lifecycle signal), not derivable at render
    setSettleVeilVisible(false);
  }, [error, clearSettleVeilTimeout]);

  // Task A1-3 (Step 1a/2): re-render the already-mounted vendor with fresh
  // graph data whenever graphVersion bumps (a refresh()-initiated flight
  // committed -- recluster elsewhere, or a time-window change below), WITHOUT
  // re-running the mount effect above (no new dynamic import(), no
  // dispose+rebuild of the ResizeObserver/Escape-listener pair the container-
  // swap guard owns -- see vendor header comment delta #11). Mirrors Dash's
  // own clientside callback (app.py's `window.__d3GraphRender(graphData)`,
  // Input=d3-graph-data): no `preserveView`, so this resets to fit-to-content
  // exactly like Dash's own re-render does, not a `toggleGroupExpansion`-style
  // camera-pinned refresh.
  //
  // Guarded two ways against the initial mount: (1) graphVersion starts at,
  // and stays, 0 through the initial load (useGraph.ts's own contract), so
  // this effect's dependency does not actually change value on that first
  // transition; (2) lastRenderedVersionRef additionally guards the one real
  // edge case where BOTH effects could fire in the same commit -- an EMPTY
  // initial payload (vendor never mounted, renderRef still null) followed by
  // a window change that both brings the first real nodes AND bumps
  // graphVersion in the same flight. In that case this effect's synchronous
  // body runs first (renderRef.current is still null -- the mount effect's
  // own dynamic import() hasn't resolved yet), so it no-ops; the mount effect
  // then handles the actual first mount once its import resolves and records
  // the version it rendered.
  useEffect(() => {
    if (!renderRef.current || !containerRef.current || !payload) return;
    if (lastRenderedVersionRef.current === graphVersion) return;
    disposeRef.current = renderRef.current(containerRef.current, payload, {
      icons: iconData.icons,
      onSelect: (kind, id) => selectFromCanvas(kind as "node" | "cluster" | null, id ?? undefined),
      // Batch 03 graph fix wave V4, item 3: same settle veil raise/drop
      // wiring as the mount effect above (a graphVersion bump -- a window
      // switch, a recluster elsewhere -- is exactly the kind of "re-render
      // an already-mounted canvas" cycle the veil exists to cover).
      onRenderCycleStart: handleSettleVeilRaise,
      onSettleEnd: handleSettleVeilDrop,
      // Batch B: same view-bus wiring as the mount effect above -- a
      // graphVersion-bump re-render rebuilds the zoom behavior too, so this
      // must be re-passed here as well or panning after a window switch/
      // recluster would silently stop updating the starfield.
      onViewChange: publishView,
      // Task V1 fix (vision-review fix loop, F1): re-apply selection AND
      // filter dim from onFirstPaint, NOT synchronously right after this
      // renderRef.current() call returns (the previous site, and the
      // regression -- see the mount effect's onFirstPaint comment above for
      // the full writeup). This effect's render() call is a re-render into
      // an EXISTING container (renderRef.current !== null, guarded above),
      // so it always hits the vendor's `else` branch: confirmed directly in
      // the vendor source (render()'s `if (!svg) {...} else {...}` branch,
      // vendor ~:3990) that every call past the FIRST wipes `.graph-root`
      // (`selectAll('*').remove()`) and rebuilds every layer group from
      // scratch -- there is no persisting incremental D3 join across
      // separate render() calls to rely on, only within a single call. That
      // wipe happens SYNCHRONOUSLY inside this render() call; the REBUILD
      // (paintPageDots creating circle.page/use.star-spikes) does not --
      // Group W moved it to the worker's first `tick` message, which is
      // exactly what onFirstPaint signals. A synchronous reapply here (the
      // pre-fix site) landed on the WIPED, not-yet-rebuilt DOM every single
      // time -- live-verified via CDP (task-V1-report.md): selecting a
      // cluster, then bumping graphVersion (e.g. a window-pill click) while
      // selected, permanently lost the dim, 100% reproducible, not a timing
      // race -- this effect's render() call and its old reapply call always
      // ran in the same synchronous tick, strictly before the worker could
      // possibly have posted anything back. Both setSelection and
      // setFilterDim are unconditional-safe no-ops when their value is
      // empty/null (see each setter's own vendor-side comment), so this
      // reapplies unconditionally -- no `if` needed, mirrors the mount
      // effect's own "apply whatever already exists" steps.
      onFirstPaint: () => {
        setSelectionRef.current?.("node", selectedNodeIdRef.current);
        setFilterDimRef.current?.(filterHighlightIdsRef.current);
      },
    });
    lastRenderedVersionRef.current = graphVersion;
  }, [graphVersion, payload, selectFromCanvas, handleSettleVeilRaise, handleSettleVeilDrop]);

  // Step 4b / Step 6: canvas Esc is a BUBBLE-phase (no `true` capture
  // flag) document listener dispatching the nav layer's reserved
  // CLEAR_SELECTION action (selection only, filter untouched --
  // lib/nav.ts) directly via dispatch, NOT via selectFromCanvas/onSelect.
  // Bubble phase so 02's ScPopover (components/ScPopover.tsx) -- which
  // registers CAPTURE-phase Esc + stopPropagation -- wins the race and
  // this never fires while a popover is open (capture always precedes
  // bubble regardless of registration order). Deliberately independent of
  // the vendor's own internal Escape handling, which the vendor header
  // comment's delta #11 now decouples from opts.onSelect for exactly this
  // reason (routing it through onSelect would resolve to HOME instead of
  // CLEAR_SELECTION and wipe the filter).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      dispatch({ type: "CLEAR_SELECTION" });
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dispatch]);

  // Task A1-3 (Step 4): pushes LATER showNoise changes to the vendor --
  // either the session's preference hydrating after the vendor has already
  // mounted, or a user click (handleToggleNoise below). No-ops via the ref
  // guard until the mount effect above has resolved (that effect's own
  // unconditional apply covers "already known by mount time" already, same
  // split as the selection inbound-wiring effect below).
  useEffect(() => {
    toggleNoiseRef.current?.(showNoise);
  }, [showNoise]);

  // Step 5: inbound wiring. Subscribes to NavProvider's selection state and
  // applies it via the vendor's __d3SetSelection semantics (setSelection
  // export) -- `type: "node"` auto-detects node vs. cluster ids against
  // currentData.clusters (see the vendor's __vendorSetSelection), and a
  // null id clears every internal selection variable + re-runs
  // updateHighlighting(), which is exactly what CLEAR_SELECTION/HOME
  // should visually do here. No-ops (via the ref guard) until the vendor
  // mount effect above has actually resolved.
  useEffect(() => {
    setSelectionRef.current?.("node", state.selectedNodeId);
  }, [state.selectedNodeId]);

  // Task A1-3 (Step 5): filterHighlightIds (dimming for the active diary-
  // window filter) -- CLOSES the A1-1-ratified gap the comment above this
  // one used to describe (task-A1-1-report.md's Step 5 section): the
  // vendor's updateHighlighting() branches for
  // selectedNodeId/selectedClusterId/selectedNodeIds/selectedSessionId are
  // still mutually exclusive, so this does NOT route through
  // setSelection('nodes', ids) (that WOULD clobber a concurrent node/
  // cluster selection). Instead it drives the vendor's INDEPENDENT
  // `setFilterDim` entry point (header comment delta #15/#27). Task V3
  // item 1 (user ruling 2026-08-10, P1) REVERSED delta #15's union
  // composition inside updateHighlighting(): a selection, when present,
  // wins outright and the filter layer does not render at all -- matching
  // Dash's actual dispatch (app.py ~:3040). This effect's shape is
  // unchanged (still an independent setFilterDim call, not routed through
  // setSelection), only the vendor-side precedence moved. Same ref-guard
  // no-op shape as setSelection above.
  useEffect(() => {
    setFilterDimRef.current?.(state.filterHighlightIds);
  }, [state.filterHighlightIds]);

  // Task A1-2 wave 8: live palette recolor. Subscribes to ThemeProvider's
  // `variant` (components/ThemeProvider.tsx) and calls the vendor's
  // exported `recolor()` -- the de-Dash replacement for Dash's
  // #dynamic-theme-css MutationObserver (observePaletteChanges /
  // recolorForPalette, vendor header comment delta #6) -- so a palette
  // switch repaints the already-mounted graph (cluster/label/nebula/
  // watermark colors) in place, no remount.
  //
  // Skips the FIRST run (mount) deliberately: the vendor's own initial
  // render() call already does one full color assignment pass as part of
  // laying out the graph, so calling recolor() again immediately after
  // mount would just be a redundant, wasted extra pass over every
  // cluster/label/nebula/watermark with the SAME palette. An explicit
  // ref guard makes this precise regardless of timing -- recolorRef.
  // current is also still null on the very first commit anyway (the
  // vendor mount effect's `import().then()` above always resolves on a
  // LATER microtask, never synchronously within the same commit), so the
  // guard and the natural async race agree, but the guard doesn't
  // silently depend on that race to stay correct.
  //
  // Ordering guarantee (why this doesn't recolor with STALE CSS):
  // ThemeProvider.setVariant (components/ThemeProvider.tsx) calls its
  // React state setter and THEN applyToDom(normalized) in source order,
  // but the state setter only *schedules* a re-render -- it does not run
  // this effect synchronously. applyToDom writes the new palette's CSS
  // custom properties (`--galaxy-0`, etc. -- lib/theme.ts's
  // getTokens/generateCssText) onto every `#theme-root` <style> node
  // SYNCHRONOUSLY, inside that same setVariant() call, before it
  // returns. React can only commit (and run this effect) once the
  // current synchronous task finishes, so by the time this effect fires
  // for a real palette change, the DOM's CSS custom properties are
  // already the NEW palette's values. This matters concretely:
  // recolorForPalette -> assignClusterColors -> getGalaxyStops() reads
  // `getComputedStyle(document.documentElement).getPropertyValue
  // ('--galaxy-N')` -- recolor() firing before the CSS vars updated
  // would repaint with the OLD palette's gradient stops.
  const isFirstVariantRender = useRef(true);
  useEffect(() => {
    if (isFirstVariantRender.current) {
      isFirstVariantRender.current = false;
      return;
    }
    recolorRef.current?.();
  }, [variant]);

  // Task A1-3 (Step 4): port of Dash's noise-toggle click handler
  // (callbacks/graph.py:129-154's toggle_noise). Flips the local/vendor
  // state unconditionally (the effect above pushes it to the vendor).
  // The `!isDemo` persistence-write guard below: a plain demo session
  // can't reach this control (the #graph-debug-overlay wrapper is
  // admin-context-gated), but an admin viewing as demo can, and its toggle
  // must not land on the demo row (2026-10-04; the backend refuses it too).
  // The toggle still flips client-side, as Dash's handler did on a failed
  // write; patchPreferences already logs-and-swallows, so no extra
  // try/catch belongs here.
  function handleToggleNoise(): void {
    const next = !showNoise;
    setShowNoiseState(next);
    if (!isDemo) {
      void patchPreferences({ show_noise: next });
    }
  }

  function handleNoiseToggleKeyDown(e: ReactKeyboardEvent<HTMLSpanElement>): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleToggleNoise();
  }

  return (
    <>
      <div id="d3-graph-container" ref={containerRef} style={D3_GRAPH_CONTAINER_STYLE}>
        {settleVeilVisible && (
          // Batch 03 graph fix wave V4, item 3a: settle veil -- see
          // SETTLE_VEIL_STYLE's own comment for the full stacking/
          // interaction-lockout writeup. .topic-spinner (app/styles/
          // search-bar.css) is the app's existing minimal loading
          // indicator (already used for topic-panel/popover loads) --
          // reused as-is, no new CSS/dependency for this "no new
          // dependencies" requirement.
          <div id="graph-settle-veil" style={SETTLE_VEIL_STYLE} aria-hidden="true">
            {/* .topic-spinner's own margin-right (search-bar.css) assumes
                inline layout next to trailing text -- zeroed here since
                this veil centers the spinner alone (inline style wins
                over the class rule for the same property regardless of
                stylesheet specificity). */}
            <span className="topic-spinner" style={{ marginRight: 0 }} />
          </div>
        )}
        {showEmptyState && (
          <div id="compendium-empty-state" style={EMPTY_STATE_STYLE}>
            <div style={EMPTY_STATE_LEAD_STYLE}>{EMPTY_STATE_BODY}</div>
            <div style={EMPTY_STATE_PRIVACY_STYLE}>{EMPTY_STATE_PRIVACY}</div>
            <a href={EMPTY_STATE_CTA_HREF || "#"} style={EMPTY_STATE_CTA_STYLE}>
              {EMPTY_STATE_CTA}
            </a>
          </div>
        )}
        {error && (
          <p className="graph-load-error" style={ERROR_STYLE}>
            Couldn&apos;t load graph: {error}
          </p>
        )}
        {/* 2026-08-24 (prod-mode sweep item 1): the whole wrapper (now just
            the noise toggle; the view-as-demo / return-to-admin controls
            moved to the app header, components/Header.tsx) is gated
            on adminContext, mirroring Dash's 2026-07-13 roles rework
            (app.py:2785-2799's clientside callback hides the entire
            #graph-debug-overlay div for every role except admin-context).
            Previously only the two trigger spans were individually
            role-gated; the noise toggle had no gate of its own and
            the outer div rendered unconditionally, so plain demo (and any
            other non-admin-context role) could see it -- ledgered known
            limitation since batch-03 (task-A1-5), closed here. */}
        {adminContext && (
          <div id="graph-debug-overlay" style={GRAPH_DEBUG_OVERLAY_STYLE}>
            {/* Task A1-3 (Step 4): port of graph_canvas.py's noise-toggle
                html.Span (:724-733). Dash gives it no gate of its own
                beyond the outer #graph-debug-overlay wrapper's own
                admin-context gate -- now mirrored one level up by the
                adminContext check wrapping this whole div, so this span
                itself stays un-individually-gated same as Dash's own
                markup. */}
            <span
              id="noise-toggle-btn"
              role="button"
              tabIndex={0}
              style={NOISE_TOGGLE_STYLE}
              onClick={handleToggleNoise}
              onKeyDown={handleNoiseToggleKeyDown}
            >
              {showNoise ? "noise: on" : "noise: off"}
            </span>
          </div>
        )}
        {AlmagestTunerDev ? <AlmagestTunerDev /> : null}
      </div>
      <div id="node-tooltip" className="node-tooltip" style={NODE_TOOLTIP_STYLE} />
    </>
  );
}
