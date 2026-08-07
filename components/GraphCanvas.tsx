"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch, fetchGraph } from "@/lib/api";
import { useSession } from "./SessionProvider";
import { useNav } from "./NavProvider";
import iconDataRaw from "@/lib/icon-data.json";
import type { IconEntry } from "@/lib/icons";
import type { GraphPayload } from "@/lib/types";

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
//     Dash's third overlay child (a noise-toggle text control,
//     graph_canvas.py:724-733, each trigger's own " | " separator span
//     exists to lead into it) is intentionally NOT ported here -- the
//     noise toggle is Task A1-3 Step 4's job; until it lands, a visible
//     trigger's trailing separator has nothing after it, matching Dash's
//     own per-form markup (the separator lives INSIDE each form, not
//     conditioned on what follows).
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
// with zero props), that fetch moves down into this component instead --
// dropping the sandbox-only `performance.mark`/`onFirstPaint` plumbing
// that fed SandboxOverlayChip (Task S1, deleted this commit; see the
// brief's Step 3). useGraph() module-cache binding (live re-fetch on
// mutation, graphVersion re-render) is Task A1-3's job, noted there in the
// report as the seam this task intentionally leaves alone -- this fetches
// once via fetchGraph() directly, same as the sandbox did.

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

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const setSelectionRef = useRef<((type: string, id: unknown) => void) | null>(null);
  const { role, actingAsDemo } = useSession();
  const { state, dispatch, selectFromCanvas } = useNav();

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch once on mount (moved down from the deleted
  // app/sandbox/graph-a1/page.tsx, minus its performance.mark plumbing --
  // see the header comment).
  useEffect(() => {
    let cancelled = false;
    fetchGraph()
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Obligation 1 (see header comment): visible only once a fetch has
  // actually completed AND it reported zero nodes -- `payload !== null`
  // stands in for Dash's `graphVersion > 0` ("loaded"), since this fetches
  // exactly once today (no useGraph() re-fetch/version bump until A1-3).
  const hasNodes = payload !== null && payload.nodes.length > 0;
  const showEmptyState = payload !== null && !hasNodes;

  // Mount the vendor renderer once real graph data with at least one node
  // arrives. Mount-once by design, same contract GraphA1.tsx had (data was
  // a stable prop there; here it's the first non-empty fetch result) --
  // useGraph()/graphVersion re-render on data changes is A1-3's job.
  useEffect(() => {
    if (!hasNodes) return;
    let cancelled = false;
    void import("@/lib/graph/d3-graph-vendor.js").then((vendor) => {
      if (cancelled || !containerRef.current || !payload) return;
      setSelectionRef.current = vendor.setSelection;
      disposeRef.current = vendor.render(containerRef.current, payload, {
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
        // opts.tunerSnapshot stays absent -- GRAPH_DEFAULTS applies until
        // group B wires a saved profile.
      });
      // Apply whatever selection NavProvider already holds at mount time
      // (e.g. a selection made via some other surface before this fetch/
      // mount race resolved) -- the effect below only reacts to LATER
      // changes, so this covers the "already selected" case explicitly.
      if (state.selectedNodeId) vendor.setSelection("node", state.selectedNodeId);
    });
    return () => {
      cancelled = true;
      disposeRef.current?.();
      disposeRef.current = null;
      setSelectionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once
    // against the first non-empty payload by design (see above);
    // state.selectedNodeId is read once here for the initial apply, live
    // updates are the separate inbound-wiring effect below, and
    // selectFromCanvas is NavProvider's stable convenience (identity only
    // changes with `state`, which this effect deliberately does not
    // re-run on).
  }, [hasNodes]);

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

  // Step 5: inbound wiring. Subscribes to NavProvider's selection state and
  // applies it via the vendor's __d3SetSelection semantics (setSelection
  // export) -- `type: "node"` auto-detects node vs. cluster ids against
  // currentData.clusters (see the vendor's __vendorSetSelection), and a
  // null id clears every internal selection variable + re-runs
  // updateHighlighting(), which is exactly what CLEAR_SELECTION/HOME
  // should visually do here. No-ops (via the ref guard) until the vendor
  // mount effect above has actually resolved.
  //
  // filterHighlightIds (dimming for the active window filter): NavState
  // DOES carry this today, but the vendor has no entry point that layers
  // it independently of selection -- updateHighlighting()'s
  // selectedNodeId/selectedClusterId/selectedNodeIds/selectedSessionId
  // branches are mutually exclusive (a single if/else-if chain), so
  // driving filterHighlightIds through the existing `setSelection('nodes',
  // ids)` path would silently clobber a concurrent node/cluster selection
  // instead of layering both, unlike NavState's own model (filter persists
  // across selection changes -- lib/nav.ts's header comment). Wiring that
  // correctly needs new vendor-side dimming plumbing, not just a call from
  // here -- out of scope for "wire IF NavProvider exposes it" (that's
  // about not inventing new NAV state; this would be inventing new VENDOR
  // state). Left as a noted gap for A1-3/window work, per the brief.
  useEffect(() => {
    setSelectionRef.current?.("node", state.selectedNodeId);
  }, [state.selectedNodeId]);

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

  return (
    <>
      <div id="d3-graph-container" ref={containerRef} style={D3_GRAPH_CONTAINER_STYLE}>
        {showEmptyState && (
          <div id="compendium-empty-state" style={EMPTY_STATE_STYLE}>
            <div style={EMPTY_STATE_LEAD_STYLE}>{EMPTY_STATE_BODY}</div>
            <div style={EMPTY_STATE_PRIVACY_STYLE}>{EMPTY_STATE_PRIVACY}</div>
            <a href={EMPTY_STATE_CTA_HREF || "#"} style={EMPTY_STATE_CTA_STYLE}>
              {EMPTY_STATE_CTA}
            </a>
          </div>
        )}
        {error && <p style={ERROR_STYLE}>Couldn&apos;t load graph: {error}</p>}
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
        </div>
      </div>
      <div id="node-tooltip" className="node-tooltip" style={NODE_TOOLTIP_STYLE} />
    </>
  );
}
