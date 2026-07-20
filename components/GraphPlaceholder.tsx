"use client";

import type { CSSProperties } from "react";
import { useSession } from "./SessionProvider";
import { apiFetch } from "@/lib/api";

// Ports graph_canvas.py's #d3-graph-container (:769-778) + the
// #compendium-empty-state overlay (:787-843) it hosts. Dash renders these
// two as siblings under .panel-center (D3 populates the container; the
// empty-state sits beside it, absolutely positioned so it doesn't depend on
// DOM order). This component nests the empty-state inside the container
// instead -- both are position:relative/absolute so the rendered result is
// identical, and nesting lets this single component drop into the center
// panel's content slot in app/page.tsx without owning the rest of
// .panel-center (starry-sky mount, debug overlay, topic panel, search bar)
// the way graph_canvas.py's render_graph_canvas() does.
//
// Since Task 10 (chat re-home into the search-bar overlay), this is the
// SOLE flex child of .panel-center's content slot -- <SearchBar /> is a
// position:absolute overlay (.search-bar-wrapper, search-bar.css) and no
// longer a flex sibling here, so this component's height:100% resolves
// against .panel-center's own definite height (theme.css: html/body/
// .app-container/.panel all chain to a real height) instead of being
// squeezed by a sibling competing for the same flex column. Before the
// re-home, the full-page <Chat /> WAS a flex sibling in this slot and
// collapsed this container's flex-basis, which in turn let .panel's
// overflow:hidden clip the centered empty-state.
//
// TODO(mig-03): remove this dev note when the graph lands. Dash's
// #compendium-empty-state starts `hidden=True` and is only revealed by a
// clientside callback once the page-load graph refresh completes with zero
// nodes (app.py). This migration slice has no graph load yet, so there is
// nothing to gate visibility on -- the empty-state below renders
// unconditionally as a stand-in for the whole graph canvas. Re-wire the
// hidden/reveal behavior against real node-count state when the D3 port
// lands, and delete DEV_NOTE_STYLE + the dev-note <div> at the bottom of
// this file.

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

// Ports graph_canvas.py's #graph-debug-overlay wrapper (:735-745) -- an
// admin-context-only monospace strip in the same top-left corner this
// component already used for its (mig-03 TODO) dev-note placeholder text.
// Dash gates the WHOLE wrapper's visibility to role==='admin' ||
// admin_launched_demo (app.py's #5 clientside callback, 2026-07-13); this
// port deliberately does NOT replicate that outer gate -- the placeholder
// text below still has to be visible to every role until the real graph
// lands (nothing else occupies this slot), so only the two trigger links
// inside are individually gated, mirroring Dash's own per-link callbacks
// (#3, same file) exactly. Unlike the "graph arrives in a later slice" dev
// note, this wrapper is NOT temporary -- Dash's own #graph-debug-overlay
// persists indefinitely as the home for these two triggers, so it survives
// past the TODO(mig-03) graph landing even though the dev-note text itself
// gets deleted then.
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

export default function GraphPlaceholder() {
  const { role, actingAsDemo } = useSession();

  // JWT port of Dash's admin-only /__view_as_demo switch (D5, batch 04) --
  // moved here from components/Header.tsx (2026-07-13 Dash relocation into
  // the graph-canvas debug overlay; this is that same move, ported). No
  // body: app/api/auth/view-as/route.ts doesn't read the request at all --
  // it hardcodes {profile: "demo"} itself before calling the backend (the
  // only profile this UI ever offers), so sending one here would be dead
  // weight.
  // Non-2xx (403 not-admin/already-acting/demo-unavailable, 401, 5xx) is
  // logged and left for the admin to retry -- the route contract
  // deliberately leaves cookies untouched on failure, so there's no
  // session to recover from here.
  async function handleViewDemo(): Promise<void> {
    const res = await apiFetch("/api/auth/view-as", { method: "POST" });
    if (!res.ok) {
      console.error("view-as failed:", res.status);
      return;
    }
    // Full navigation, not client-side state surgery -- Dash's own
    // /__view_as_demo redirects to "/" for the same reason: every
    // server-read preference/role needs to re-hydrate against the new
    // (demo-scoped) identity, not just the parts of the UI this component
    // happens to own.
    window.location.assign("/");
  }

  // JWT port of Dash's /__return_to_admin (D5, batch 04) -- same
  // full-navigation rationale as handleViewDemo above, also moved here from
  // Header.tsx.
  async function handleReturnToAdmin(): Promise<void> {
    const res = await apiFetch("/api/auth/return", { method: "POST" });
    if (!res.ok) {
      console.error("return-to-admin failed:", res.status);
      return;
    }
    window.location.assign("/");
  }

  return (
    <div id="d3-graph-container" style={D3_GRAPH_CONTAINER_STYLE}>
      <div id="compendium-empty-state" style={EMPTY_STATE_STYLE}>
        <div style={EMPTY_STATE_LEAD_STYLE}>{EMPTY_STATE_BODY}</div>
        <div style={EMPTY_STATE_PRIVACY_STYLE}>{EMPTY_STATE_PRIVACY}</div>
        <a href={EMPTY_STATE_CTA_HREF || "#"} style={EMPTY_STATE_CTA_STYLE}>
          {EMPTY_STATE_CTA}
        </a>
      </div>
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
        {/* TODO(mig-03): remove this placeholder text (not the wrapper
            above -- see GRAPH_DEBUG_OVERLAY_STYLE's comment) when the graph
            lands. */}
        graph arrives in a later slice
      </div>
    </div>
  );
}
