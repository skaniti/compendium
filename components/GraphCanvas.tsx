"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { apiFetch } from "@/lib/api";
import { patchPreferences } from "@/lib/preferences";
import { useSession } from "./SessionProvider";
import { useNav } from "./NavProvider";
import { useTheme } from "./ThemeProvider";
import { useTimeWindow } from "./TimeWindowProvider";
import { useGraph } from "@/hooks/useGraph";
import iconDataRaw from "@/lib/icon-data.json";
import type { IconEntry } from "@/lib/icons";
import TopicPanel from "./TopicPanel";
import { GRAPH_DEFAULTS, type GraphDefaults } from "@/lib/graph/constants";
import { resolveTunerSnapshot } from "@/lib/graph/tuner-snapshot";

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
//     view-demo/return-to-admin triggers (graph_canvas.py:643-747), so it
//     survives past this port unconditionally-rendered exactly as
//     GraphPlaceholder already had it (that file's own comment: this port
//     deliberately does not replicate Dash's admin-context-only OUTER
//     gate, only the two trigger links are individually role-gated).
//     Dash's third overlay child -- a noise-toggle text control
//     (graph_canvas.py:724-733; each trigger's own " | " separator span
//     leads into it) -- landed at Task A1-3 Step 4 (#noise-toggle-btn
//     below), un-individually-gated same as Dash's own markup (only the
//     outer wrapper was ever admin-context-gated there, and this port's
//     outer wrapper is unconditional per the deviation just above).
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

// Verbatim port of the inline button style dict graph_canvas.py uses for
// both "view demo" and "return to admin" (:660-670, :693-703).
const DEBUG_LINK_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "0",
  margin: "0",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  textDecoration: "none",
};

// Verbatim port of the " | " separator span style following each trigger
// (:672-677, :705-710).
const DEBUG_LINK_SEPARATOR_STYLE: CSSProperties = {
  opacity: 0.3,
  marginLeft: "4px",
  marginRight: "4px",
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
  const { role, actingAsDemo, showNoise: sessionShowNoise } = useSession();
  const { state, dispatch, selectFromCanvas } = useNav();
  const { variant } = useTheme();
  const { timeWindow } = useTimeWindow();

  // Plain demo sessions (direct login, not admin-launched view-as) get
  // 403'd by the backend on ANY preferences PATCH (Dash parity, the
  // backend's is_plain_demo gate) -- same local derivation ThemeProvider/
  // StarfieldProvider/usePanelResize's own callers use (AppShell.tsx's
  // isPlainDemo), computed here directly since GraphCanvas already reads
  // role/actingAsDemo from useSession() for the view-demo/return-to-admin
  // triggers above and isn't threaded any props from a server component.
  const isPlainDemo = role === "demo" && !actingAsDemo;

  // Task A1-3 (Step 4): noise toggle. Local state is the single source of
  // truth for BOTH the displayed label and what gets applied to the
  // vendor (via the effect below) -- seeded from the session's persisted
  // preference once hydration resolves (the seeding effect just below),
  // then owned by the click handler (handleToggleNoise) from then on.
  const [showNoise, setShowNoiseState] = useState(false);
  useEffect(() => {
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

  // Task A1-5: the legacy "Topic Interests" overlay's open/closed state.
  // TopicPanel unmounts entirely when closed (ScPopover's own philosophy --
  // no display:none-but-in-DOM branch to track) rather than Dash's
  // persistent-DOM-with-style-toggle model.
  const [topicPanelOpen, setTopicPanelOpen] = useState(false);

  // Task A1-3 (Step 3): TimeWindowProvider's second reader (the DATE RANGE
  // header card is the first). setWindow() is idempotent against the
  // already-active window (useGraph.ts's own guard) and its commit reuses
  // the SAME graphVersion-driven re-render effect above -- no separate
  // "window changed, redraw" path to keep in sync. Deliberately unguarded
  // against the initial render (unlike the palette-recolor effect's
  // isFirstVariantRender ref): calling setWindow("all") on mount is a
  // genuine no-op by construction (cacheState.window already defaults to
  // "all"), so there is nothing here worth special-casing away.
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
        // Task group W (batch 03 Web Worker force sim), W3 step: render()
        // itself is synchronous (it starts the worker and returns), but
        // "started" no longer means "painted" now that the force layout
        // runs off-thread -- see the write site below, right after this
        // call, for what used to fire here directly.
        onFirstPaint: () => {
          window.__compendiumGraphRendered = true;
        },
      });
      // Task group B, Part 1 fix 1 (continued): EXPLICIT post-render
      // highlighting apply. svg/currentData now exist (render() just
      // built them), so each call's own updateHighlighting() actually
      // takes effect immediately -- neither depends on the OTHER
      // incidentally re-running it. Pre-fix, this same pair of calls
      // "worked" only because toggleNoise's OWN internal re-render (now
      // eliminated above) wiped the DOM AFTER the selection apply, and
      // setFilterDim's own updateHighlighting() call happened to run
      // AFTER that wipe and rescue both selection and filter together --
      // an incidental ordering dependency, not a designed one (see
      // task-B-brief.md's Part 1 caution).
      //
      // Apply whatever selection NavProvider already holds by the time the
      // import resolves (see selectedNodeIdRef's own comment above for why
      // this reads the ref, not the closed-over `state` -- the A1-1 fix).
      // The effect below only reacts to LATER changes, so this covers the
      // "already selected before/during mount" case explicitly.
      if (selectedNodeIdRef.current) vendor.setSelection("node", selectedNodeIdRef.current);
      // Task A1-3 (Step 5): same pattern again, via filterHighlightIdsRef
      // (always current). Unconditional like toggleNoise above -- an empty
      // array IS the correct "no filter" call, not something to skip.
      vendor.setFilterDim(filterHighlightIdsRef.current);
      // Task group B, Part 1 fix 2 (continued): record via graphVersionRef,
      // not the closed-over `graphVersion` param -- the LATEST version by
      // resolution time, not whatever it was when this effect started.
      lastRenderedVersionRef.current = graphVersionRef.current;
      // Task group W, W3 step (batch 03 Web Worker force sim):
      // render-complete signal for components/CompendiumLoader.tsx's
      // dismiss trigger now fires from the `onFirstPaint` callback passed
      // into vendor.render() above, not from reaching this line --
      // render() itself is synchronous (it starts the worker sim and
      // returns), but that no longer implies anything painted (the force
      // layout runs off-thread; first paint is the worker's first `tick`
      // message, lib/vendor/vendor.d.ts's Window augmentation documents
      // the flag itself; CompendiumLoader.tsx's tryDismiss polls it
      // alongside window.__compendiumLoader). Idempotent regardless of
      // how many times `onFirstPaint` fires (it fires at most once per
      // render() call by the vendor's own contract) -- the loader-side
      // latch, not this flag, is what makes a later re-signal a no-op.
      // This is one of THREE write sites for this flag (the other two --
      // the empty-state settle, and the error settle -- are their own
      // effects further down this component, fix round 1/2 of
      // task-A1-4-report.md, UNCHANGED by task group W: they're settle
      // states with no sim to wait on).
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once
    // against the first non-empty payload by design (see above);
    // selection is read via selectedNodeIdRef (always current, see its own
    // comment) rather than a dependency, live updates for LATER changes are
    // the separate inbound-wiring effect below, and selectFromCanvas is
    // NavProvider's stable convenience (identity only changes with `state`,
    // which this effect deliberately does not re-run on).
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
  // OWN write site moved (to vendor.render()'s new `onFirstPaint`
  // callback, see that effect's comment) -- this one and the error-settle
  // effect below are settle states with no sim, and stay exactly as they
  // were.
  useEffect(() => {
    if (!showEmptyState) return;
    window.__compendiumGraphRendered = true;
  }, [showEmptyState]);

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
  useEffect(() => {
    if (!error) return;
    window.__compendiumGraphRendered = true;
  }, [error]);

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
    });
    lastRenderedVersionRef.current = graphVersion;
    // Re-apply selection AND filter dim against the freshly-drawn DOM.
    // Confirmed directly in the vendor source (render()'s `if (!svg) {...}
    // else {...}` branch, vendor ~:3990): every call past the FIRST wipes
    // `.graph-root` (`selectAll('*').remove()`) and rebuilds every layer
    // group from scratch before the circle/star/label data joins run --
    // there is no persisting incremental D3 join across separate render()
    // calls to rely on, only within a single call. Both setSelection and
    // setFilterDim are unconditional-safe no-ops when their value is
    // empty/null (see each setter's own vendor-side comment), so this
    // reapplies unconditionally -- no `if` needed, mirrors the mount
    // effect's own "apply whatever already exists" steps above.
    setSelectionRef.current?.("node", selectedNodeIdRef.current);
    setFilterDimRef.current?.(filterHighlightIdsRef.current);
  }, [graphVersion, payload, selectFromCanvas]);

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
  // cluster selection). Instead it drives the vendor's new INDEPENDENT
  // `setFilterDim` entry point (header comment delta #15), which
  // updateHighlighting() unions with whatever the selection branches
  // compute -- selection and filter compose (a selected node inside a
  // dimmed-out set stays visible, matching the brief's own example),
  // rather than one silently overwriting the other. Same ref-guard no-op
  // shape as setSelection above.
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

  // JWT port of Dash's admin-only /__view_as_demo switch (D5, batch 04) --
  // ported unchanged from GraphPlaceholder.tsx (originally moved there
  // from components/Header.tsx, 2026-07-13 Dash relocation into the
  // graph-canvas debug overlay).
  async function handleViewDemo(): Promise<void> {
    const res = await apiFetch("/api/auth/view-as", { method: "POST" });
    if (!res.ok) {
      console.error("view-as failed:", res.status);
      return;
    }
    window.location.assign("/");
  }

  // JWT port of Dash's /__return_to_admin (D5, batch 04) -- ported
  // unchanged from GraphPlaceholder.tsx.
  async function handleReturnToAdmin(): Promise<void> {
    const res = await apiFetch("/api/auth/return", { method: "POST" });
    if (!res.ok) {
      console.error("return-to-admin failed:", res.status);
      return;
    }
    window.location.assign("/");
  }

  // Task A1-3 (Step 4): port of Dash's noise-toggle click handler
  // (callbacks/graph.py:129-154's toggle_noise). Flips the local/vendor
  // state unconditionally (the effect above pushes it to the vendor) --
  // the control itself is NEVER hidden or disabled for plain demo, only
  // the persistence write is skipped (spec.md's "Preference writes &
  // plain-demo" section: "mutation UI never hidden for the noise toggle").
  // Dash's own handler swallows a persistence failure silently (`except
  // Exception: pass`) and still flips client-side either way; the 403
  // backstop this skip is paired with is the SAME shape patchPreferences
  // itself already logs-and-swallows (lib/preferences.ts), so no extra
  // try/catch belongs here.
  function handleToggleNoise(): void {
    const next = !showNoise;
    setShowNoiseState(next);
    if (!isPlainDemo) {
      void patchPreferences({ show_noise: next });
    }
  }

  function handleNoiseToggleKeyDown(e: ReactKeyboardEvent<HTMLSpanElement>): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleToggleNoise();
  }

  // Task A1-5: opens/closes the legacy "Topic Interests" overlay. See
  // TopicPanel.tsx's own header comment for why this trigger exists at all
  // when Dash's own :8051 has had none since 2026-05-22 (commit 3d4b4b4) --
  // short version: the human-authored mig-03 plan explicitly keeps this
  // task in scope as a "user-facing graph affordance", and
  // app/styles/search-bar.css already carries `#topic-toggle-btn`
  // hover/focus rules from an earlier batch, anticipating exactly this
  // element.
  function handleToggleTopicPanel(): void {
    setTopicPanelOpen((open) => !open);
  }

  function handleTopicToggleKeyDown(e: ReactKeyboardEvent<HTMLSpanElement>): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleToggleTopicPanel();
  }

  // Dash's own close trigger for #topic-panel (besides the close button):
  // ANY click within #d3-graph-container (callbacks/topics.py's
  // toggle_topic_panel, Input=d3-graph-container n_clicks) -- NOT a
  // document-wide "click outside" listener like ScPopover's. TopicPanel is
  // mounted as a SIBLING of this div (not nested inside it, unlike
  // #graph-debug-overlay/#compendium-empty-state above), so a click landing
  // on the panel itself never reaches this handler -- exactly mirrors
  // Dash's DOM topology, where #topic-panel is also a sibling of
  // #d3-graph-container, not a descendant.
  //
  // The exclusion below is REQUIRED, not defensive extra caution: in Dash,
  // #graph-debug-overlay/#compendium-empty-state are ALSO siblings of
  // #d3-graph-container (graph_canvas.py's render_graph_canvas returns them
  // as a flat list), so clicking "noise: off"/"view demo"/"topics" itself
  // never bumps d3-graph-container's n_clicks there. This port's OWN debug-
  // overlay/empty-state divs are nested INSIDE #d3-graph-container instead
  // (a pre-existing, ratified deviation -- see this file's header comment,
  // "obligation 2") purely for DOM-organization convenience, predating this
  // task. Without this guard, a click on e.g. the noise toggle would bubble
  // to this handler and incorrectly close the topic panel -- a click
  // Dash's real sibling-based DOM would never route there at all.
  function handleCanvasClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if (!topicPanelOpen) return;
    const target = e.target;
    if (target instanceof Element && target.closest("#graph-debug-overlay, #compendium-empty-state, .graph-load-error")) {
      return;
    }
    setTopicPanelOpen(false);
  }

  return (
    <>
      <div id="d3-graph-container" ref={containerRef} style={D3_GRAPH_CONTAINER_STYLE} onClick={handleCanvasClick}>
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
        <div id="graph-debug-overlay" style={GRAPH_DEBUG_OVERLAY_STYLE}>
          {role === "admin" && !actingAsDemo && (
            <span id="view-as-demo-form" style={{ display: "inline", margin: 0 }}>
              <button type="button" style={DEBUG_LINK_BUTTON_STYLE} onClick={() => void handleViewDemo()}>
                view demo
              </button>
              <span style={DEBUG_LINK_SEPARATOR_STYLE}> | </span>
            </span>
          )}
          {actingAsDemo && (
            <span id="return-to-admin-form" style={{ display: "inline", margin: 0 }}>
              <button
                type="button"
                style={DEBUG_LINK_BUTTON_STYLE}
                onClick={() => void handleReturnToAdmin()}
              >
                return to admin
              </button>
              <span style={DEBUG_LINK_SEPARATOR_STYLE}> | </span>
            </span>
          )}
          {/* Task A1-3 (Step 4): port of graph_canvas.py's noise-toggle
              html.Span (:724-733) -- Dash gives it NO individual role gate
              of its own (only the outer #graph-debug-overlay wrapper is
              admin-context-gated there); this port's outer wrapper is
              already unconditionally rendered (A1-1's deliberate, ratified
              deviation from Dash's own outer gate -- see this file's
              header comment), so this control follows the same
              un-individually-gated shape, satisfying the brief's own
              "toggle UI itself NEVER hidden" requirement for free. */}
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
          {/* Task A1-5: restored trigger for the legacy "Topic Interests"
              overlay -- see handleToggleTopicPanel's own comment above for
              why this exists despite Dash's :8051 no longer having one.
              Styled identically to noise-toggle-btn (same un-individually-
              gated shape, same NOISE_TOGGLE_STYLE-equivalent inline dict) --
              app/styles/search-bar.css's #topic-toggle-btn hover/focus rules
              (an earlier batch) already expect exactly this id + shape. */}
          <span style={DEBUG_LINK_SEPARATOR_STYLE}> | </span>
          <span
            id="topic-toggle-btn"
            role="button"
            tabIndex={0}
            style={NOISE_TOGGLE_STYLE}
            onClick={handleToggleTopicPanel}
            onKeyDown={handleTopicToggleKeyDown}
          >
            topics
          </span>
        </div>
      </div>
      {topicPanelOpen && (
        <TopicPanel onClose={() => setTopicPanelOpen(false)} graphVersion={graphVersion} refresh={refresh} />
      )}
      <div id="node-tooltip" className="node-tooltip" style={NODE_TOOLTIP_STYLE} />
    </>
  );
}
