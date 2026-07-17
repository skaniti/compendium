import type { CSSProperties } from "react";

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

// TODO(mig-03): remove this dev note (and DEV_NOTE_STYLE above it) when the
// graph lands.
const DEV_NOTE_STYLE: CSSProperties = {
  position: "absolute",
  top: "8px",
  left: "8px",
  fontSize: "0.65rem",
  color: "var(--text)",
  opacity: 0.5,
  zIndex: 3,
  fontFamily: "monospace",
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
  return (
    <div id="d3-graph-container" style={D3_GRAPH_CONTAINER_STYLE}>
      <div id="compendium-empty-state" style={EMPTY_STATE_STYLE}>
        <div style={EMPTY_STATE_LEAD_STYLE}>{EMPTY_STATE_BODY}</div>
        <div style={EMPTY_STATE_PRIVACY_STYLE}>{EMPTY_STATE_PRIVACY}</div>
        <a href={EMPTY_STATE_CTA_HREF || "#"} style={EMPTY_STATE_CTA_STYLE}>
          {EMPTY_STATE_CTA}
        </a>
      </div>
      {/* TODO(mig-03): remove when the graph lands. */}
      <div style={DEV_NOTE_STYLE}>graph arrives in a later slice</div>
    </div>
  );
}
