// =====================================================================
// Batch 03 (graph canvas port) Task S2 -- "A1: port-intact" sandbox spike.
// Vendored VERBATIM from explorer frontend/dash/assets/d3_graph.js at
// explorer HEAD 4bb0a648dc961a2961b153699be7ca1827484a1a (2026-07-29,
// 5683 lines), then edited ONLY at the sites below -- every other line is
// byte-identical to that source (diff it directly against the source path
// above to verify). Line numbers are the SOURCE file's line numbers.
//
// De-Dash edits (task-S2-brief.md's exhaustive checklist):
//  1. `#d3-graph-json` store mirror + `window.__d3GraphRender` Dash
//     clientside trigger -> exported `render(container, data, opts)`.
//     The "store mirror read" itself lived in Dash's app.py clientside
//     callback (not in this file) -- nothing to edit for that half; the
//     trigger half was `window.__d3GraphRender = function (data) {...}`
//     at :5516-5566, replaced below with a direct wrapper (still aliased
//     to `window.__d3GraphRender` in dev, per delta #7).
//  2. Boot latch DELETED (:5464-5566 region): `BOOT_USER_STATE_TIMEOUT_MS`
//     (:5474), `__bootLatch` (:5477-5483), `ensureUserStateFetch`
//     (:578-593), `applyBootProfile` (:788-795), and the `/_user_state`
//     fetch (`fetchUserState`, :552-560) are all removed -- render is
//     direct, no boot-time profile fetch/race. `var __userState = {}`
//     (:561) is KEPT as a permanently-empty placeholder (never populated,
//     since its only writer was the deleted fetch) rather than deleted
//     outright, so the handful of already-dead DevTuner-profile helpers
//     that still read `__userState.*` (persistActiveProfileWithMachineOverride
//     et al. -- see delta #4) degrade to reading `undefined` off `{}`
//     instead of throwing on a missing binding. Tuner values instead
//     initialize from `opts.tunerSnapshot ?? GRAPH_DEFAULTS`
//     (lib/graph/constants.ts) exactly once per mount -- see the new
//     `render` wrapper near the old boot-latch site.
//  3. `writeTapStore` (:5401-5405, was `dash_clientside.set_props`) now
//     calls `opts.onSelect(kind, id)` (module-level `__onSelectCallback`,
//     set by the render wrapper). Its 3 call sites (selectNode,
//     selectCluster, clearSelection) are unchanged.
//  4. DevTuner mount (`mountDevTunerOnce`/`mountDevTunerWithState`,
//     :916-1386) STRIPPED -- window.DevTuner is never defined outside
//     Dash, so this was always a no-op mount guard in this repo; deleted
//     rather than gated. Its single call site inside render() (:4244)
//     is deleted too. `__d3ResetTunerToDefaults` (:823) and
//     `__d3ApplyTunerOverrides` (:832) are re-expressed against the
//     constants snapshot: `__tunerDefaults` now reads
//     `GRAPH_DEFAULTS` (imported below) instead of a
//     `getTunerSnapshot()` capture -- both functions' bodies are
//     otherwise untouched (they already only wrote page-local module
//     vars, no persistence). The other DevTuner-only persistence
//     plumbing it exclusively fed (`persistProfiles`, `persistActiveProfile`,
//     `persistActiveProfileWithMachineOverride`, `persistProfileNames`,
//     `resolveEffectiveSlot`, `MACHINE_SLOT_KEY_PREFIX`,
//     `__bootProfileApplied`, oscillation persistence) is left in place,
//     verbatim, as inert dead code -- none of it is in the brief's
//     enumerated delete list, and it has zero remaining callers post-strip
//     either way, so leaving it is the smaller diff.
//  5. `window.__superClusterIcons` (Dash global, fed by
//     assets/icon_manifest.js) -> `opts.icons` (module-level
//     `__mountedIcons`, set by the render wrapper from Compendium's own
//     lib/icon-data.json-backed mechanism -- same `{label, category,
//     viewBox, paths}` shape per icon id, so the 3 read sites need no
//     other change). Read sites: :2967, :2987 (drawWatermarks), :5287-5288
//     (buildPageTip).
//  6. Palette `MutationObserver` (`observePaletteChanges`, :5407-5465,
//     "Palette observer" section) is untouched but no longer auto-started
//     (the old auto-start call sites were inside the deleted boot latch).
//     `recolorForPalette` -- the actual recolor logic it drove -- is
//     exported as `recolor()`; this sandbox never calls it (no
//     `observePaletteChanges()` call anywhere), matching the brief's
//     "sandbox leaves it unwired." Promotion wires `recolor()` to
//     ThemeProvider's palette-change signal instead of a DOM
//     MutationObserver.
//  7. The 10 `window.__d3*` dev aliases (assign sites :108, :823, :832,
//     :5516[now the render wrapper], :5580, :5587, :5596, :5621, :5635,
//     :5645) are now ALSO module exports (via the `__vendor*` outer
//     bindings + `export {...}` at EOF), with the `window.__d3*` global
//     re-attached only when `process.env.NODE_ENV !== "production"` (dev
//     + test only -- CDP/console debug access, matching their original
//     "debug/CDP access" purpose). One internal cross-call
//     (`__d3FrameNodes` calling `window.__d3SetSelection`, :5649) was
//     repointed to call the module-level binding directly, since the
//     window alias no longer exists in production builds.
//  8. Sandbox-bar gating: `SANDBOX_SECTION_GATES` (new, below) is a
//     single boolean per gated concept, checked via an early-return at
//     the top of that concept's entry function -- nebula (`drawNebula`),
//     watermark (`drawWatermarks`), the near-zoom page-title LOD nicety
//     (`drawPageTitleLabels`), edge chips (`updateEdgeChips`), and
//     tooltips (`showTooltip`/`hideTooltip`/`showLinesTooltip`). All are
//     `false` (off) in this sandbox; flipping one flag re-enables that
//     whole concept everywhere it's called from, for promotion. Every
//     gated function's BODY is otherwise byte-identical to the source --
//     only the one-line guard was added. Group captions
//     (`drawGroupLabels`) and the core page-count cluster-label LOD +
//     collision cull (`updateLabelLOD`/`runLabelCull`) are NOT gated --
//     both are load-bearing for "cluster hull-label pills" being legible
//     on the real (dense) dataset, which the brief lists as in-scope for
//     this sandbox bar. `knot` (the collapsed-group hit-targets computed
//     inside `drawNebula`, source :2770 / vendor :2452) is independently
//     checked as of Fix round 1 below -- see item 9.
//
// S2 fix round 1 (task review findings, fixed post-de31bb9 -- see
// task-S2-report.md's "Fix round 1" section for the full writeup):
//  9. `SANDBOX_SECTION_GATES.knot` was declared but never read (dead
//     flag) -- enabling `nebula` unconditionally enabled knots too, and
//     flipping `knot: true` alone was a silent no-op. `drawNebula` (vendor
//     :2447-2462) now wraps the `computeCollapsedKnotData(...).forEach`
//     push in its own `if (SANDBOX_SECTION_GATES.knot)` guard, nested
//     inside the existing `nebula` gate (still the only call site -- no
//     independent knot entry point exists to gate on its own). Both
//     guards' surrounding code is otherwise byte-identical to source.
//  10. Remounting against a new container (React unmount + remount of
//      GraphA1, e.g. leaving and returning to /sandbox/graph-a1) silently
//      rendered nothing: the internal `render()`'s `if (!svg)` block
//      (source :4040-4147 / vendor :3731-3838, still untouched) only
//      builds svg/handlers/ResizeObserver the first time ever, with no
//      DOM-containment self-heal like `ensureZoomIndicator`/
//      `ensureEdgeChipLayer` have. The render wrapper (`__vendorRender`,
//      vendor :5183, the item-1 edit site) now detects a container swap
//      (`__mountedContainer !== container`) and nulls `svg` /
//      `storedZoomBehavior` / `lastCanvasDims` / `rawData` /
//      `__tunerInitialized` before calling the untouched internal
//      `render(data, opts)`, which forces its `if (!svg)` branch to
//      rebuild everything against the new container and re-applies a new
//      mount's `opts.tunerSnapshot` (previously ignored past the first
//      mount, since `__tunerInitialized` never reset). `rawData` is reset
//      for a subtler reason, not just symmetry: applyTunerSnapshot's own
//      tail (`if (rawData) render(rawData)`, header comment delta #2) only
//      stays a no-op because `rawData` is still null the one time
//      applyTunerSnapshot runs per mount -- without also nulling it here,
//      resetting `__tunerInitialized` alone would resurrect that "spurious
//      extra re-render" (this time with the PREVIOUS mount's stale data)
//      on every remount. Known, documented limitation AT S2 TIME (RESOLVED
//      by A1-1, see item 11 below): the OLD container's ResizeObserver and
//      the document-level Escape keydown listener (both function-local
//      inside the same untouched `if (!svg)` block) had no module-level
//      handle for this wrapper to disconnect/remove without restructuring
//      that Dash-verbatim block beyond the authorized wrapper edit site --
//      they leaked past unmount (harmless in practice: the stale
//      ResizeObserver never fires again once its element is detached, and
//      the stale Escape listener just called clearSelection() redundantly).
//
// A1-1 promotion edit (task-A1-1-report.md; Step 6 of that task's brief
// explicitly authorized extending this file's wrapper edit sites to
// resolve item 10's limitation rather than re-accepting it):
//  11. Two independent fixes at the SAME code sites (both inside the
//      `if (!svg)` block, vendor ~:3760-3793, and __vendorRender, vendor
//      ~:5220):
//        a. Teardown handles. `ro` (the ResizeObserver) and the Escape
//           keydown handler are now also assigned to module-level
//           `__resizeObserverHandle` / `__escapeKeydownHandler`. A new
//           `teardownContainerHandlers()` helper disconnects/removes both;
//           called from the container-swap guard (fixes item 10's leak on
//           remount) AND from a new `dispose()` function __vendorRender now
//           RETURNS (lets a React effect teardown call it on final
//           unmount, not just a remount).
//        b. Escape/onSelect decoupling. The Escape keydown handler no
//           longer calls the full `clearSelection()` (which fires
//           `writeTapStore(null)` -> `opts.onSelect(null, null)`) -- it
//           inlines just the local variable resets + the
//           `updateHighlighting()` call that clearSelection() also does,
//           minus the writeTapStore(null) side effect. Reason:
//           GraphCanvas.tsx (the A1-1 promotion's React wrapper) wires
//           `opts.onSelect` to
//           `useNav().selectFromCanvas`, whose reducer contract
//           (`resolveCanvasTapAction`, lib/nav.ts:112-135) resolves a
//           `(null, null)` signal to the HOME action (clears selection AND
//           the nav filter) -- correct for a REAL background tap, but this
//           listener's `(null, null)` signal is indistinguishable from one
//           at that boundary despite meaning something narrower: Esc is
//           its own reserved `CLEAR_SELECTION` action (selection only,
//           filter untouched -- see lib/nav.ts's CLEAR_SELECTION comment
//           and components/ScPopover.tsx's Esc-ordering-contract comment,
//           both written well before A1-1 with full knowledge of this
//           exact listener). GraphCanvas.tsx owns a SEPARATE bubble-phase
//           document Escape listener that dispatches CLEAR_SELECTION
//           directly, independent of this file's onSelect plumbing.
//
// A1-2 wave 4 confirmation (task-A1-2-w4-report.md) -- no code change,
// documented here because the wave's brief expected one:
//  12. The wave's described surface -- screen-clamped star dots / bloom /
//      visit-luminance (`pageDotRadius`/`starVariant`/`starGlyphOpacity`/
//      `updatePageDotScale`, :1461-1498) and Delaunay nearest-dot hover
//      arming (`rebuildDelaunay`/`disarmDot`/`updateArmedDot`, :1504-1550)
//      -- turned out to have NO `SANDBOX_SECTION_GATES` entry at all: not
//      one of the five keys item 8 above enumerates, and not gated at any
//      other layer either (checked theme.css's `circle.page, use.star-
//      spikes` rule -- a plain `color` rule, not a visibility gate; checked
//      GraphCanvas.tsx -- never references this surface). Diffed byte-
//      identical against the S2 anchor source (explorer 4bb0a648, same
//      line range) and confirmed via task-S2-report.md / task-S3-report.md
//      that this code has been unconditionally live since the original S2
//      "port-intact" vendor -- it predates the wave-gating scheme entirely,
//      unlike nebula/watermark/knot/edgeChip/tooltip, which item 8's gates
//      exist specifically for. Nothing to flip, so nothing was flipped.
//      One real tooltip entanglement, live-verified both apps (CDP,
//      results + captures in .superpowers/sdd/plan/a1-2-captures/wave4/):
//      `updateArmedDot` (:1549) calls `showTooltip(event, n)`
//      unconditionally on every arm, but `showTooltip` (:5163) is itself
//      gated (`tooltip: false`) and early-returns before touching
//      `#node-tooltip` -- doubly safe in this app, since GraphCanvas.tsx
//      also never renders a `#node-tooltip` element for it to find. The
//      non-tooltip arming visuals (1.5x glyph-scale bump, pointer cursor)
//      fire correctly and match Dash's (un-gated, tooltip-showing)
//      behavior exactly on every other measured axis.
//
// A1-2 wave 7 confirmation (task-A1-2-w7w8-report.md) -- no code change,
// documented here because the wave's brief expected one:
//  13. The zoom indicator overlay (`ensureZoomIndicator`, :1143-1240 --
//      minus/plus buttons + editable percentage, clamped to the runtime
//      `fitToContent` scaleExtent) has NO `SANDBOX_SECTION_GATES` entry:
//      not one of item 8's six keys, and its sole call site (`render()`,
//      inside the `if (!svg)` block, ~:4035) is unconditional --
//      `ensureZoomIndicator(container, function () { return
//      storedZoomBehavior; });`, no guard around it. Same class as item
//      12: unconditionally live since the original S2 "port-intact"
//      vendor, predating the wave-gating scheme. Nothing to flip, so
//      nothing was flipped. Live-verified both apps (CDP, results +
//      screenshots in .superpowers/sdd/plan/a1-2-captures/wave7/):
//      indicator DOM/styling identical both sides at fit; displayed %
//      matched the live transform ratio exactly at mid (200%) and deep
//      (350%) zoom; minus/plus-button walks converged to the SAME clamp
//      ratio both sides (min 0.5x / max 4x fit-scale, i.e. the
//      `fitToContent` scaleExtent's own `MIN_ZOOM_RATIO`(0.5)/4 bounds,
//      :3657) and stayed stable under one more click past convergence;
//      the editable-% input applied an in-range typed value (180 ->
//      1.8x) and clamped both an out-of-range-low (1% -> the same 0.5x
//      floor) and out-of-range-high (99999% -> the same 4x ceiling)
//      value identically on both sides. One environment-only finding
//      (not an app defect, see the report's "CDP methodology" section):
//      headless Chromium under CDP updates `document.activeElement`
//      synchronously on `.focus()`/`.blur()` but never fires the actual
//      `focus`/`blur` DOM events those calls normally raise (confirmed
//      generically on a throwaway pair of plain, unrelated `<input>`
//      elements, not anything specific to this widget) -- verification
//      drove the input's `applyTypedZoom()` path via a directly
//      dispatched synthetic `blur` `FocusEvent` instead of a real
//      `.focus()`/keydown-Enter/`.blur()` sequence.
//
// Task A1-3 Step 4 (noise toggle) -- task-A1-3-report.md:
//  14. `readNoiseToggleState()` (:468-472) read a `#noise-toggle-json` DOM
//      mirror Dash's clientside callback kept in sync with its
//      `noise-toggle-store` (a Dash-ism this port never created -- wave 1
//      already established the DOM-absent fallback defaults to show-
//      everything). Replaced with a plain module var (`__showNoise`,
//      default `true`, same fallback the DOM-absent branch used) written
//      EXCLUSIVELY by the exported `toggleNoise(show)` setter, which now
//      actually consumes its own `show` argument (`_show` was unused
//      before -- state came from the DOM read inside render() regardless
//      of what the caller passed). GraphCanvas.tsx calls this with the
//      session's persisted `show_noise` preference once at mount (plus on
//      every later click), the same module/opts-driven-setter shape
//      `setSelection`/`setFilterDim` (item 15 below) already use --
//      keeping the `__d3ToggleNoise` dev alias (header comment delta #7).
//  15. `updateHighlighting()` (:4936) unioned in a NEW, independent
//      module var (`filterDimNodeIds`, written by the new
//      `setFilterDim(nodeIds)` export / `__d3SetFilterDim` dev alias) on
//      top of whatever the pre-existing selection branches computed,
//      instead of routing NavProvider's `filterHighlightIds` (window-
//      filter dimming) through the existing mutually-exclusive
//      `selectedNodeId`/`selectedClusterId`/`selectedNodeIds`/
//      `selectedSessionId` if/else-if chain (which would have silently
//      CLOBBERED a concurrent node/cluster selection -- the A1-1-ratified
//      gap, task-A1-1-report.md Step 5). Semantics: union, not exclusive
//      -- a node is dimmed only if BOTH an active selection excludes it
//      AND an active filter excludes it (empty/absent = that layer
//      doesn't dim anything). Sourced from Dash's OWN app.py:3010-3065
//      comment ("Selection takes precedence over filter overlay; if both
//      set, d3 should still show the highlight overlay PLUS the
//      selection... for now, keep the existing single-layer dispatch") --
//      Dash's ACTUAL wired behavior is the single-layer dispatch that
//      comment apologizes for (selection wins, filter dropped entirely
//      whenever a node/cluster is selected), never the composed behavior
//      it describes wanting. This port ships the composed ("PLUS")
//      behavior the comment describes as the intent, not the
//      never-implemented single-layer behavior Dash actually runs --
//      see task-A1-3-report.md for the full reasoning.
//
// Two mechanical deltas, pre-authorized by the task's outer context
// (not part of the brief's own checklist above):
//  A. `d3` is imported from ./d3.ts (micro-package re-exports) instead of
//     a global UMD bundle -- see that file's header comment. New
//     micro-packages this required beyond what Task S1 already installed:
//     d3-shape (`d3.line`, `d3.curveBasisClosed`), d3-polygon
//     (`d3.polygonHull`), d3-transition (side-effect import so
//     `selection.transition()` exists) -- plus their @types packages.
//  B. TypeScript-build integration: none needed. tsconfig.json has
//     `allowJs: false` and `include` covers only `**/*.ts`/`**/*.tsx`, so
//     this plain `.js` file is entirely outside the TS program already
//     (webpack/Next's bundler still compiles+bundles it as JS) -- no
//     `@ts-nocheck` pragma required. Precedent: lib/vendor/*.js (mig-01),
//     which uses the same allowJs:false exclusion + an ambient
//     `declare module` in a sibling `vendor.d.ts` for the TS side that
//     DOES need to reference it (here: lib/graph/vendor.d.ts).
//
// Everything else below -- indentation, Dash CSS class names
// (hull-label, watermark, group-label, sc-edge-chip, etc.), function
// bodies not listed above -- is unedited. Spot-diff any large untouched
// region (e.g. computeLayout/fitToContent, :3327-3987) against the source
// path above to confirm.
// =====================================================================

import { GRAPH_DEFAULTS } from "./constants";
import d3 from "./d3";

// Outer module-scope bindings the IIFE below assigns into (plain
// `name = value`, no `var`/`let`/`const` inside the IIFE -- see delta #7
// above) so `export` statements at EOF, which must live at module top
// level, can see them. Each pairs with one of the "10 window.__d3* dev
// aliases" plus the two new hooks (`render`, `recolor`) delta #1/#6
// introduce. Naming: `render`/`recolor` get the brief's specified names;
// the other 9 keep their `__d3*` alias's suffix, camelCased, so the
// module export and the dev-console global are trivially cross-referenced.
var __vendorRender;
var __vendorRecolor;
var __vendorSetSelection;
var __vendorToggleNoise;
var __vendorFrameNodes;
var __vendorGetClusterPages;
var __vendorHasNode;
var __vendorDebugGetSelection;
var __vendorResetTunerToDefaults;
var __vendorApplyTunerOverrides;
var __vendorExpandedGroups;

/**
 * D3 knowledge graph with cluster convex hulls.
 *
 * Layout is computed synchronously (force sim + cluster forces),
 * then rendered once — no animation jiggle on load.
 * Zoom-only interaction (scroll to zoom, no drag-pan beyond content).
 */
(function () {
    'use strict';

    var NODE_RADIUS = 3;
    // retired (rethink R5) — kept so old tuner profiles still parse. The
    // pill visual is gone (see applySCMarker); this radius is still read
    // by the SC-label collision-box reservation in the label-layout pass
    // (estW/estH) to preserve existing spacing safety margins.
    var SC_PILL_RADIUS = 64;
    var HULL_PADDING = 20;
    // World-space padding around content at fit-to-content zoom (tuner-
    // exposed). This is daylight BEYOND the nebula cloud -- the cloud
    // itself is framed separately via NEBULA_FIT_CORE below, so this
    // no longer needs to absorb the fog's footprint too (pre-2026-07-14 it
    // padded only the node/watermark bbox while the fog, which extends
    // well past the nodes, spilled past the pad and ate it entirely).
    // 40 -> 55 (2026-07-14, same-day calibration): +15 world units clears
    // the blob-jitter residue at 1366x768 -- jittered blob paths overshoot
    // the nominal gradient circle by ~3px at that viewport's fit scale.
    // 55 -> 155 (2026-07-17, user re-tune, paired with NEBULA_FIT_CORE
    // 1.0 -> 0.8): framing rebalanced -- the explicit world pad grows while
    // the fit reserves only 0.8 of the nominal fog radius, trading feather
    // reservation for fixed margin. Move these two together.
    var FIT_WORLD_PAD = 155;
    // Fraction of the NOMINAL fog radius fitToContent reserves as content;
    // 1.0 reserves the whole painted blob including the gradient feather.
    // Tuner-exposed (CANVAS FIT section), range 0-1 to dial the framing
    // tighter by taste. Default 1.0 (2026-07-14 calibration): the earlier
    // 0.6 "visible core" framing undercounted -- Layer-1 blobs at the
    // radius floor read as cloud well past 0.6r, leaving the fit flush on
    // rim-adjacent clusters (measured -16..-30px top margins); sweeping f
    // showed >=+15px margins on all edges/viewports only from ~1.0.
    // 1.0 -> 0.8 (2026-07-17, user re-tune): with FIT_WORLD_PAD 55 -> 155
    // taking over margin duty, reserving the full feather over-padded the
    // fit; 0.8 core + the larger fixed pad is the preferred framing.
    var NEBULA_FIT_CORE = 0.8;
    // Zoom-out floor, expressed as a fraction of the fit-to-content scale.
    // Shared by fitToContent's scaleExtent (the actual zoom-out limit) and
    // the pan-clamp (the "everything visible at the floor" expanded rect) --
    // keeping both derived from one constant keeps them in sync.
    var MIN_ZOOM_RATIO = 0.5;
    var HULL_OPACITY = 0.13;
    var HULL_STROKE_OPACITY = 0.35;
    var LINK_OPACITY = 0.7;
    var TOOLTIP_OFFSET = 14;
    var NEBULA_RADIUS_MULT = 9.0;
    var NEBULA_MIN_RADIUS = 200;
    // SC-member clusters (real super-clusters, or SC_LIKE_CLUSTER_IDS) use a
    // MUCH larger minimum nebula radius than non-SC clusters -- see the
    // Layer-1 comment in computeNebulaData. Module-level (not local to
    // computeNebulaData) so clusterNebulaRadius() below -- shared by
    // computeNebulaData's rendering AND fitToContent's fog-aware fit
    // padding -- can read it without either duplicating the value.
    var SC_MEMBER_NEBULA_MIN_RADIUS = 380;

    // Rethink R1.3: fog is background, stars are foreground. The 0.45
    // overlay factor + 6 satellites merged every SC into one continuous
    // cloud (no dark inter-SC space at any zoom — capture evidence in the
    // 2026-07-11 rethink doc).
    var SC_OVERLAY_OPACITY_FACTOR = 0.18;
    var SC_SATELLITE_COUNT = 3;

    // var FALLBACK_COLORS = [
    //     '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    //     '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'
    // ];

    var svg = null;
    var currentData = null;   // data currently laid out + rendered (may be noise-filtered)
    var rawData = null;       // last unfiltered dataset passed to render(); source of truth for toggle re-entry
    var storedZoomBehavior = null;
    var lastCanvasDims = null;  // { w, h } from the most recent fitToContent call -- frameWorldBBox/refitView need this to convert a world bbox into a zoom transform
    // Producer: drawWatermarks (sets it right after computing centroids).
    // Consumer: updateEdgeChips (same zoom tick, fired right after
    // drawWatermarks via updateLabelScale) -- reuses the just-computed
    // centroids instead of recomputing computeClusterCentroids from scratch.
    var lastClusterCentroids = null;

    // ── S2 sandbox-port module state (new; see header comment) ────────
    var __mountedContainer = null;  // set by the render wrapper (delta #1); replaces getElementById('d3-graph-container')
    var __onSelectCallback = null;  // opts.onSelect from the render wrapper (delta #3)
    var __mountedIcons = null;      // opts.icons from the render wrapper (delta #5); replaces window.__superClusterIcons
    var __tunerInitialized = false; // guards the one-time opts.tunerSnapshot ?? GRAPH_DEFAULTS apply (delta #2)
    // A1-1 promotion (delta #11): module-level handles for the two
    // per-mount artifacts the `if (!svg)` block creates that previously had
    // no handle to tear down (S2 fix-round-1 finding 2's documented
    // limitation). teardownContainerHandlers() below disconnects/removes
    // both; called on a container swap AND from __vendorRender's returned
    // dispose().
    var __resizeObserverHandle = null;
    var __escapeKeydownHandler = null;

    // Sandbox-bar section gates (delta #8) -- single boolean per gated
    // concept, checked via early-return at the top of that concept's
    // entry function. Promotion flips them on section-by-section; A1-2
    // wave 1 flips `nebula` only (task-A1-2-w1-brief.md) -- knot stays
    // independently OFF (see drawNebula's nested guard), the rest are
    // still un-promoted.
    var SANDBOX_SECTION_GATES = {
        nebula: true,      // drawNebula (+ nested collapsed-group knot hit-targets)
        watermark: true,   // drawWatermarks -- A1-2 wave 2
        lodNicety: true,   // drawPageTitleLabels (near-zoom page-title reveal) -- A1-2 wave 5
        knot: true,        // collapsed-group knot hit-targets, nested inside drawNebula -- A1-2 wave 3
        edgeChip: true,    // updateEdgeChips -- A1-2 wave 3
        tooltip: true,     // showTooltip / hideTooltip / showLinesTooltip -- A1-2 wave 6
    };

    // Clusters that should visually render like super-clusters (SC-style
    // nebula overlay + pill label + larger label scale) even though they
    // aren't backed by a real super-cluster keyword. Currently empty --
    // historically this held the synthetic "_unclustered" / "_singletons"
    // buckets, but those were retired 2026-04-27 in favor of per-page
    // "_solo_<page_id>" faux-clusters that scatter through the nebula
    // (preserves visual density without bucketing). See
    // backend/services/graph_builder.py module docstring for rationale.
    // Kept around in case future custom buckets need SC-like rendering.
    var SC_LIKE_CLUSTER_IDS = {};
    function isSuperClusterLike(cluster) {
        if (!cluster) return false;
        return !!cluster.super_cluster || SC_LIKE_CLUSTER_IDS[cluster.id] === true;
    }

    // ── Tier-driven collapse (batch C C1, hybrid supercluster mode) ────
    // Clusters carry group_id / group_tier / group_label from the payload
    // (empty in legacy keywords mode). casual/binge groups render as ONE
    // dense mass — members packed tight, per-cluster labels suppressed,
    // a single group label shown — unless expanded this session. Click the
    // group label to toggle; state resets on reload by design.
    var expandedGroups = {};
    __vendorExpandedGroups = expandedGroups;   // module export (delta #7)
    if (process.env.NODE_ENV !== "production") {
        window.__d3ExpandedGroups = expandedGroups;   // debug/CDP access
    }
    function isCollapsedCluster(c) {
        return !!c && c.group_id != null &&
            (c.group_tier === 'casual' || c.group_tier === 'binge') &&
            !expandedGroups[c.group_id];
    }

    // Detect per-page faux-cluster ids emitted by graph_builder for noise
    // pages (HDBSCAN noise + boilerplate-filtered actives). Each one is a
    // 1-page faux-cluster sized for force-layout scattering only -- they
    // are not real groupings.
    function isSoloFauxCluster(clusterId) {
        return typeof clusterId === 'string' && clusterId.indexOf('_solo_') === 0;
    }

    // Strip noise (kind="unclustered" pages and their solo faux-clusters)
    // from a graph payload so the force layout doesn't allocate space for
    // nodes the user has hidden. Featured singletons (kind="singleton")
    // stay visible -- the toggle hides only the unlabeled background dots.
    // Returns a shallow-copied object; the original is left intact so
    // toggling noise back on re-uses the same source data.
    function filterOutNoise(data) {
        if (!data) return data;
        var hiddenSoloIds = {};
        (data.nodes || []).forEach(function (n) {
            if (n.kind === 'unclustered' && isSoloFauxCluster(n.parent_id)) {
                hiddenSoloIds[n.parent_id] = true;
            }
        });
        return {
            nodes: (data.nodes || []).filter(function (n) {
                return n.kind !== 'unclustered';
            }),
            links: (data.links || []).filter(function (l) {
                return !hiddenSoloIds[l.source] && !hiddenSoloIds[l.target];
            }),
            clusters: (data.clusters || []).filter(function (c) {
                return !hiddenSoloIds[c.id];
            }),
            super_clusters: data.super_clusters,
        };
    }

    // Task A1-3 (header comment delta #14): the noise-toggle state itself
    // -- was read from a `#noise-toggle-json` DOM mirror (Dash's
    // clientside-callback-synced dcc.Store proxy); now written exclusively
    // by the exported toggleNoise(show) setter below. Default true matches
    // the DOM-mirror-absent fallback readNoiseToggleState() used to return
    // (wave 1: with the mirror absent this ported render defaults to
    // show-everything) -- GraphCanvas.tsx overrides this explicitly at
    // mount from the session's persisted show_noise preference regardless.
    var __showNoise = true;

    // Read the current noise-toggle state (module var -- see __showNoise's
    // own comment for the DOM-mirror this replaced).
    function readNoiseToggleState() {
        return __showNoise;
    }

    var fitZoom = 1;  // scale factor fitToContent applies; LOD thresholds derive from zoom / fitZoom
    var currentZoomK = 1;  // most recent zoom transform.k; used by updateLabelScale
    var zoomIndicatorPctEl = null;  // span inside the upper-right zoom indicator
    var edgeChipLayerEl = null;  // HTML overlay div holding the R6.2 edge chips

    // Scale thresholds (relative to fit-zoom). For each key, k_min clamps
    // how small the element can get at zoom-out (1.0 = don't shrink below
    // natural screen size at fit). k_max caps growth at zoom-in.
    //
    // Separate entries so dev tuner can adjust independently:
    //   clLabel — non-SC cluster labels (plain white text on nebula)
    //   scLabel — SC-member pills (colored rect background + text)
    //   scIcon  — SC watermark icons (saturn/gear/brain SVG paths)
    //   scName  — SC name text rendered under each watermark
    //
    // Watermarks + SC names are re-rendered via drawWatermarks() on tuner
    // changes (cheap: only 3 SCs in current data). Cluster label sizes are
    // patched in place on text.hull-label via updateLabelScale.
    //
    // Page nodes and cluster placement remain non-scaling (those were
    // the ripple-inducing pieces of the old rolled-back scaling stack).
    // Painted size = BASE_*_FONT_SIZE × clamp(zoomRatio, k_min, k_max), so
    // base × k_min is the on-screen FLOOR at zoom-out. The 2026-07-11 design
    // audit measured the old floors at ~4-6px painted (base 4, k_min 1.2) —
    // sub-legible by construction. New floors target ≥11px painted for
    // informational text; k_max is kept modest so zoom-in doesn't balloon
    // labels into cartoons.
    var SCALE_THRESHOLDS = {
        clLabel: { k_min: 1.25, k_max: 2.00 },
        scLabel: { k_min: 1.00, k_max: 2.00 },
        scIcon:  { k_min: 0.50, k_max: 1.15 },  // was 5.0 — icons grew INTO labels as you zoomed (measured 1.3k->5.4k px² pill x icon); k_min was 0.60 until 2026-07-14 — above MIN_ZOOM_RATIO's 0.5 floor, so ratio in [0.5,0.6) clamped to a constant while zoomK kept shrinking, ballooning icon world-size and destabilizing the nameplate-deconfliction pass right at min zoom (icon jump bug)
        scName:  { k_min: 1.00, k_max: 2.00 },
        // Singleton page-title labels share the same shape as cluster labels
        // (clamped scale by zoom ratio) but with a smaller base size since
        // they're tertiary signal sitting on top of nebula content.
        singletonLabel: { k_min: 1.00, k_max: 2.50 },
        // Collapsed-group captions (batch C C1) — fully screen-constant at
        // zoom-out so the caption stays readable at fit, where the old
        // geometric 15px attr painted at ~8px (design audit §2).
        groupLabel: { k_min: 1.00, k_max: 1.60 },
        // Page dots (rethink R1): screen-clamped so pages read as stars at
        // every zoom x density. World radius = BASE_PAGE_DOT_SIZE x
        // clampedScale, so the painted size floors at ~1.35px (fit-and-below)
        // and caps at ~3.2px (near zoom) instead of scaling geometrically
        // (0.4-3.1px measured on the dense account pre-change; bounds
        // rescaled 2026-07-17 with BASE_PAGE_DOT_SIZE 2.6 -> 1.5).
        pageDot: { k_min: 0.90, k_max: 2.10 },
    };
    var BASE_LABEL_FONT_SIZE = 9;             // non-SC cluster labels
    var BASE_SC_LABEL_FONT_SIZE = 9;          // SC-member pill text
    var BASE_SC_ICON_SIZE = 100;              // SC watermark icon size (screen px at fit)
    var BASE_SC_NAME_FONT_SIZE = 22;          // SC name text under watermark
    var BASE_SINGLETON_LABEL_FONT_SIZE = 8;   // featured-singleton page titles
    var BASE_GROUP_LABEL_FONT_SIZE = 12;      // collapsed-group captions
    var BASE_PAGE_DOT_SIZE = 1.5;             // page-dot screen radius at fit (px)
    // Checkpoint-A feedback: phyllotaxis spacing still assumed 3px-era dots;
    // screen-clamped stars (world r ~9 units at dense fit) sat on top of
    // each other. Multiplies both the ring-seed spacing and collide radius.
    var PAGE_SPREAD_MULT = 2.6;
    // Muted resting-opacity multiplier for page star glyphs (T11b) --
    // extracted from the hardcoded 0.8 factor in starGlyphOpacity so the
    // tuner can expose it. Every glyph-opacity consumer (render enter
    // chain, hover restore, updateHighlighting) routes through that one
    // helper, so this is the only site the multiplier needs to live.
    // 0.8 -> 0.35 (2026-07-17, user re-tune): dimmer resting stars.
    var STAR_GLYPH_OPACITY_MULT = 0.35;
    // Singleton LOD: rank singletons by outlier_score and reveal a fraction
    // of the ranks proportional to (zoomRatio ^ POWER). Weaker outliers fade
    // out first as the user zooms out -- analogous to LOD_BASE_THRESHOLD/POWER
    // for cluster labels, but ranked by per-node strength instead of cluster
    // page count. POWER=2 means ratio=0.5 -> 25% visible (aggressive falloff,
    // matches their "tertiary signal" role). FADE_RANGE is the fraction of
    // total ranks that span the visible/hidden transition.
    var SINGLETON_LOD_POWER = 2.0;
    var SINGLETON_LOD_FADE_RANGE = 0.10;
    var SINGLETON_LABEL_BASE_OPACITY = 0.75;
    // Page-title disclosure at near zoom (design audit §3): past this zoom
    // ratio, page dots reveal their titles (collision-culled, tertiary
    // priority). Before this change max zoom showed only anonymous dots —
    // the map never answered "what did I read?" without a click.
    var PAGE_TITLE_LOD_K_MIN = 1.6;
    var PAGE_TITLE_LOD_FADE_RANGE = 0.4;
    var PAGE_TITLE_BASE_OPACITY = 0.85;
    // retired (rethink R5) — kept so old tuner profiles still parse.
    // SC-member labels no longer render a pill background (see
    // applySCMarker); these shape/sizing knobs have no live effect.
    var SC_PILL_SHAPE = 'circle';           // 'circle' | 'rectangle' | 'squoval' | 'squoval-rect'
    var SC_PILL_AUTOFIT = true;
    var SC_PILL_CORNER_ROUNDNESS = 0.26;    // squoval corner radius as fraction of min(w,h); 0..0.5
    var SC_PILL_FIXED_WIDTH = 93;           // rectangular shapes when autofit OFF
    var SC_PILL_FIXED_HEIGHT = 50;
    var SC_PILL_PADDING = 19;               // text bbox padding when autofit ON
    // SC name LOD: fade the supercluster name text at very-zoomed-out
    // states so only the watermark icon remains in galaxy-overview view.
    // K_MIN is the zoom ratio (currentK / fitZoom) below which the name
    // is fully hidden; FADE_RANGE is the band above K_MIN over which it
    // fades in. At ratio >= K_MIN + FADE_RANGE, full opacity.
    // 0.15 (was 0.5): the far view IS the constellation overview — SC names
    // are the one text layer that must survive zoom-out (design audit §3).
    // With the zoom-out floor at 0.5×fit this effectively never hides; the
    // knob stays as a tunable guard.
    var SC_NAME_LOD_K_MIN = 0.15;
    var SC_NAME_LOD_FADE_RANGE = 0.1;

    // Rethink R6.1: past ~1.3x fit you are INSIDE the galaxy -- the big
    // watermark icon fades out (it's mostly offscreen background clutter
    // at that depth anyway) and the nameplate hands off to edge chips
    // (updateEdgeChips) for wayfinding back to the supercluster. Uses the
    // same currentZoomK/fitZoom ratio as the other LOD gates; unlike
    // SC_NAME_LOD this one runs in the opposite direction (fades OUT as
    // you zoom IN, not as you zoom out).
    var ICON_LOD_FADE_START = 1.3;
    var ICON_LOD_FADE_END = 1.8;

    // Rethink R6.3: collapsed-group captions gate off at far zoom-out --
    // at galaxy-overview scale a caption's screen-constant font crowds
    // the SC nameplates/labels sharing that space, and the group itself
    // reads as noise at that distance anyway. K_MIN is the zoom ratio
    // below which captions are fully hidden; FADE is the band above
    // K_MIN over which they fade in. Mirrors SC_NAME_LOD's shape but
    // gates out at zoom-OUT (below K_MIN), not fade-in from zero -- i.e.
    // captions are the DEFAULT-on layer and this only hides them at the
    // far end.
    var GROUP_CAPTION_LOD_K_MIN = 0.8;
    var GROUP_CAPTION_LOD_FADE = 0.15;

    // Typography schema version for saved tuner profiles. Profiles saved
    // before the 2026-07-11 label redesign carry the old sub-legible sizes
    // (base 4-7px, k_min ≥1.2 floors); applying them would silently undo the
    // redesign at every mount. applyTunerSnapshot therefore applies
    // typography keys only from snapshots stamped with the CURRENT version;
    // spatial keys (pill shape, nebula, node radius, icon size) still apply
    // from any profile. Re-saving a profile from the tuner re-stamps it.
    //
    // RULE: any re-baseline of a gated key MUST bump this version in the
    // same commit. v2 (2026-07-11) predates the scIcon re-baselines it was
    // later asked to guard (k_max 5.0->1.15 on 07-12, k_min 0.60->0.50 on
    // 07-14), so profiles saved in that window carried a valid v2 stamp
    // around the pre-fix values and re-pinned the min-zoom icon-jump bug
    // at every mount. v3 invalidates those stamps.
    var TUNER_TYPO_VERSION = 3;

    // Fog schema version for saved tuner profiles -- same precedent as
    // TUNER_TYPO_VERSION above, scoped to the two nebula-size knobs. T3
    // (2026-07-14) re-baselined the fog to NEBULA_RADIUS_MULT 9; profiles
    // saved before that pin mult 16-20, which doubles the rendered fog and
    // defeats fitToContent's fog-aware padding (NEBULA_FIT_CORE) -- the
    // cloud balloons back out past the pad the fit computed for it.
    // applyTunerSnapshot therefore applies NEBULA_RADIUS_MULT/
    // NEBULA_MIN_RADIUS only from snapshots stamped with the CURRENT fog
    // version; HULL_PADDING is not part of the T3 re-baseline and stays
    // ungated. Re-saving a profile from the tuner re-stamps it.
    var TUNER_FOG_VERSION = 2;

    /** Pattern-3 clamped scale factor.
     *  Returns multiplier such that world_size = natural * scale gives a
     *  screen size of `natural * effRatio` after the SVG zoom transform,
     *  where effRatio = clamp(zoomK/fitZoom, k_min, k_max).
     *  "natural" means the screen size you'd see at fit zoom in the
     *  pass-through band — NOT a world-coord size. */
    function clampedScale(zoomK, key) {
        if (fitZoom <= 0 || zoomK <= 0) return 1.0;
        var ratio = zoomK / fitZoom;
        var t = SCALE_THRESHOLDS[key];
        if (!t) return 1.0;
        var effRatio;
        if (ratio < t.k_min) effRatio = t.k_min;
        else if (ratio > t.k_max) effRatio = t.k_max;
        else effRatio = ratio;
        return effRatio / zoomK;
    }

    // scPillAnchors retired: pills are now anchored to each cluster's own
    // shrinkwrap bbox (like non-SC labels). Cluster ring placement still
    // happens in Phase 1.5a but no longer drives pill positions.
    var selectedNodeId = null;
    var selectedClusterId = null;
    var selectedSessionId = null;
    var selectedNodeIds = null;  // Array of node IDs for time-window highlighting
    var clusterColorMap = {};

    // Rethink R2.1: nearest-dot hover arming. Dots are 0.4-3.1px screen
    // targets on the dense account — direct hit-testing is unusable, so a
    // Delaunay lookup arms the nearest dot within ARM_RADIUS_PX of the
    // pointer and all dot interaction routes through the armed target.
    var ARM_RADIUS_PX = 24;
    var pageDelaunay = null;
    var pageDelaunayNodes = [];
    var armedNode = null;  // datum object (not just id) -- svg click handler uses it directly

    // ── Theme-aware contrast helpers ──────────────────────────────────

    function bgLuminance() {
        var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (!bg || bg.charAt(0) !== '#') return 0.9;  // assume light if unavailable
        var hex = bg.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        var channels = [0, 2, 4].map(function (i) {
            var c = parseInt(hex.substr(i, 2), 16) / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    function isDarkBg() { return bgLuminance() < 0.4; }

    /** Muted color for edges/secondary elements — adapts to bg. */
    function mutedColor() { return isDarkBg() ? '#666' : '#999'; }

    /** Fallback neutral when cluster color is unknown. */
    function fallbackColor() { return isDarkBg() ? '#aaa' : '#888'; }

    // ── Color assignment ─────────────────────────────────────────────

    function getGalaxyStops() {
        var style = getComputedStyle(document.documentElement);
        var stops = [];
        for (var i = 0; ; i++) {
            var val = style.getPropertyValue('--galaxy-' + i).trim();
            if (!val) break;
            stops.push(val);
        }
        return stops.length > 0 ? stops : [fallbackColor()];
    }

    function lerpHex(a, b, t) {
        var ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
        var br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
        var hx = function (v) { return Math.round(v).toString(16).padStart(2, '0'); };
        return '#' + hx(ar + (br - ar) * t) + hx(ag + (bg - ag) * t) + hx(ab + (bb - ab) * t);
    }

    function sampleMirrored(stops, t) {
        // Forward-backward pass: t in [0,0.5] → stops forward, [0.5,1] → backward.
        // Ensures seamless wrap at the 0°/360° boundary.
        var m = t <= 0.5 ? t * 2 : (1 - t) * 2;
        var pos = m * (stops.length - 1);
        var lo = Math.max(0, Math.floor(pos));
        var hi = Math.min(stops.length - 1, lo + 1);
        return lerpHex(stops[lo], stops[hi], pos - lo);
    }

    /**
     * Sample the nebula background color at a point by blending all
     * overlapping nebula blobs weighted by their opacity at that distance.
     */
    function sampleNebulaAtPoint(px, py, nebulaData) {
        // Opacity curve stops: [0%, 25%, 50%, 75%, 100%] → [1, 0.7, 0.35, 0.1, 0]
        var opStops = [1, 0.7, 0.35, 0.1, 0];
        var tr = 0, tg = 0, tb = 0, tw = 0;

        for (var i = 0; i < nebulaData.length; i++) {
            var nb = nebulaData[i];
            var dx = px - nb.cx, dy = py - nb.cy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var t = dist / nb.radius;
            if (t >= 1) continue;

            // Interpolate opacity from stops
            var pos = t * (opStops.length - 1);
            var lo = Math.floor(pos), hi = Math.min(lo + 1, opStops.length - 1);
            var w = opStops[lo] + (opStops[hi] - opStops[lo]) * (pos - lo);

            var col = clusterColorMap[nb.clusterId] || fallbackColor();
            var cr = parseInt(col.slice(1, 3), 16);
            var cg = parseInt(col.slice(3, 5), 16);
            var cb = parseInt(col.slice(5, 7), 16);
            tr += cr * w; tg += cg * w; tb += cb * w; tw += w;
        }

        if (tw > 0) {
            var hx = function (v) { return Math.round(v).toString(16).padStart(2, '0'); };
            return '#' + hx(tr / tw) + hx(tg / tw) + hx(tb / tw);
        }
        return null; // no nebula coverage
    }

    function assignClusterColors(clusters, nodes) {
        var stops = getGalaxyStops();
        var centroids = computeClusterCentroids(clusters, nodes);

        // Build super-cluster color palette: evenly space topics across gradient
        var superClusters = currentData && currentData.super_clusters || [];
        var superColorMap = {};
        if (superClusters.length > 0) {
            superClusters.forEach(function (sc, i) {
                var t = superClusters.length > 1
                    ? i / superClusters.length
                    : 0.5;
                superColorMap[sc.keyword] = sampleMirrored(stops, t);
            });
        }

        // Graph center for position-based fallback (ungrouped clusters)
        var gcx = 0, gcy = 0, gcc = 0;
        clusters.forEach(function (c) {
            if (centroids[c.id]) { gcx += centroids[c.id].x; gcy += centroids[c.id].y; gcc++; }
        });
        if (gcc > 0) { gcx /= gcc; gcy /= gcc; }

        // First pass: assign SC member colors (these define the nebula palette)
        clusterColorMap = {};
        clusters.forEach(function (c) {
            if (c.super_cluster && superColorMap[c.super_cluster]) {
                clusterColorMap[c.id] = superColorMap[c.super_cluster];
            } else if (centroids[c.id]) {
                var angle = Math.atan2(centroids[c.id].y - gcy, centroids[c.id].x - gcx);
                var t = (angle + Math.PI) / (2 * Math.PI);
                clusterColorMap[c.id] = sampleMirrored(stops, t);
            } else {
                clusterColorMap[c.id] = sampleMirrored(stops, 0.5);
            }
        });

        // Second pass: re-color ungrouped clusters to match their nebula
        // background. This ensures pushed nodes blend into the surrounding
        // color field rather than clashing with nearby SC nebula blobs.
        if (superClusters.length > 0) {
            var nebulaData = computeNebulaData(clusters, nodes);
            clusters.forEach(function (c) {
                if (c.super_cluster) return; // SC members keep fixed color
                if (!centroids[c.id]) return;
                var sampled = sampleNebulaAtPoint(
                    centroids[c.id].x, centroids[c.id].y, nebulaData
                );
                if (sampled) clusterColorMap[c.id] = sampled;
            });
        }
    }

    function clusterColor(id) { return clusterColorMap[id] || fallbackColor(); }

    // Subtract the collapsed search bar's footprint from the usable canvas
    // height so fitToContent frames the graph into the area above it — not
    // underneath it. Falls back to the raw height if the wrapper isn't in
    // the DOM yet.
    function effectiveCanvasHeight(rawH) {
        var wrap = document.querySelector('.search-bar-wrapper');
        if (!wrap) return rawH;
        var wrapH = wrap.getBoundingClientRect().height;
        var reserved = wrapH;
        // #search-tab sits ABOVE the wrapper via `bottom: 100%` in CSS — it
        // is positioned outside the wrapper's own flow box, so its height
        // is NOT included in wrap's rect above; add it separately or
        // fitToContent's "canvas bottom" ends up under the tab strip.
        var tab = document.querySelector('#search-tab');
        if (tab) reserved += tab.getBoundingClientRect().height;
        // Wrapper is positioned 8px from the bottom — include that margin
        // so content doesn't butt up against the search bar.
        reserved += 8;
        return Math.max(100, rawH - reserved);
    }

    // ── Level-of-Detail (LOD) label visibility ───────────────────────
    // At fit-to-content zoom, only high-importance labels are visible;
    // as the user zooms in, lower-importance labels fade in. This is the
    // foundation for future multilayered super-clustering (labels/clusters
    // aggregate and split at different zoom levels).
    //
    // Importance metric: page count per cluster. Clusters with more pages
    // are more important and survive lower-zoom filters.
    //
    // Formula: threshold(zoom) = LOD_BASE_THRESHOLD / (zoomRatio ^ LOD_POWER)
    //   where zoomRatio = currentZoom / fitZoom (1.0 at fit, up to ~6 at max)
    //   Labels with page_count >= threshold are fully visible; fewer pages
    //   fade linearly over a small range; below that, hidden.
    var LOD_BASE_THRESHOLD = 2.5; // min page count visible at fit-zoom
    var LOD_POWER = 2.00;         // how aggressively threshold drops with zoom-in
    var LOD_FADE_RANGE = 1.3;     // pages below threshold = fade, beyond = hidden

    // Oscillate-zoom tuner defaults. The tuner provides a button that
    // auto-cycles canvas zoom between LOW_PCT and HIGH_PCT of fit-zoom
    // over CYCLE_MS milliseconds. Values are live-tunable from the panel,
    // changes take effect mid-cycle via getter callbacks, AND tuner edits
    // auto-persist per-user via POST /_persist_prefs (debounced).
    var OSCILLATE_LOW_PCT = 15;
    var OSCILLATE_HIGH_PCT = 201;
    var OSCILLATE_CYCLE_MS = 15000;

    // S2 de-Dash DELETE (header comment delta #2): `fetchUserState` (the
    // `/_user_state` fetch) and `ensureUserStateFetch` (its single-flight
    // coordinator, shared by the deleted boot latch and DevTuner mount)
    // are removed -- there is no `/_user_state` endpoint outside Dash.
    // `__userState` stays declared as a permanently-empty placeholder
    // (never populated now) so the still-present-but-dead DevTuner
    // persistence helpers below that read `__userState.*` (delta #4)
    // resolve to `undefined` instead of a missing binding.
    var __userState = {};

    // Debounced persist for oscillation. Fires 400ms after the last
    // slider/value change so a drag doesn't trigger 60 writes/sec.
    var __oscPersistTimer = null;
    function persistOscillation() {
        if (__oscPersistTimer) clearTimeout(__oscPersistTimer);
        __oscPersistTimer = setTimeout(function () {
            fetch('/_persist_prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: 'oscillation',
                    value: {
                        low_pct: OSCILLATE_LOW_PCT,
                        high_pct: OSCILLATE_HIGH_PCT,
                        cycle_ms: OSCILLATE_CYCLE_MS,
                    },
                }),
            }).catch(function () { /* fire-and-forget */ });
        }, 400);
    }

    // ── Tuner snapshot helpers ───────────────────────────────────────
    // Capture / restore the full set of tuner-controlled vars (excluding
    // oscillation which is per-user auto-saved on its own track). Used by
    // the profile menu's Save / Load / Reset actions.
    //
    // The snapshot is a plain JSON-stringifiable object, deep-copied for
    // SCALE_THRESHOLDS so saved profiles can be JSON-serialized to the
    // backend without aliasing the live object.

    function getTunerSnapshot() {
        return {
            TYPO_V: TUNER_TYPO_VERSION,
            FOG_V: TUNER_FOG_VERSION,
            SCALE_THRESHOLDS: JSON.parse(JSON.stringify(SCALE_THRESHOLDS)),
            BASE_LABEL_FONT_SIZE: BASE_LABEL_FONT_SIZE,
            BASE_SC_LABEL_FONT_SIZE: BASE_SC_LABEL_FONT_SIZE,
            BASE_GROUP_LABEL_FONT_SIZE: BASE_GROUP_LABEL_FONT_SIZE,
            BASE_SC_ICON_SIZE: BASE_SC_ICON_SIZE,
            BASE_SC_NAME_FONT_SIZE: BASE_SC_NAME_FONT_SIZE,
            BASE_SINGLETON_LABEL_FONT_SIZE: BASE_SINGLETON_LABEL_FONT_SIZE,
            LOD_BASE_THRESHOLD: LOD_BASE_THRESHOLD,
            LOD_POWER: LOD_POWER,
            LOD_FADE_RANGE: LOD_FADE_RANGE,
            SINGLETON_LOD_POWER: SINGLETON_LOD_POWER,
            SINGLETON_LOD_FADE_RANGE: SINGLETON_LOD_FADE_RANGE,
            SINGLETON_LABEL_BASE_OPACITY: SINGLETON_LABEL_BASE_OPACITY,
            SC_NAME_LOD_K_MIN: SC_NAME_LOD_K_MIN,
            SC_NAME_LOD_FADE_RANGE: SC_NAME_LOD_FADE_RANGE,
            ICON_LOD_FADE_START: ICON_LOD_FADE_START,
            ICON_LOD_FADE_END: ICON_LOD_FADE_END,
            GROUP_CAPTION_LOD_K_MIN: GROUP_CAPTION_LOD_K_MIN,
            GROUP_CAPTION_LOD_FADE: GROUP_CAPTION_LOD_FADE,
            SC_PILL_SHAPE: SC_PILL_SHAPE,
            SC_PILL_AUTOFIT: SC_PILL_AUTOFIT,
            SC_PILL_CORNER_ROUNDNESS: SC_PILL_CORNER_ROUNDNESS,
            SC_PILL_RADIUS: SC_PILL_RADIUS,
            SC_PILL_FIXED_WIDTH: SC_PILL_FIXED_WIDTH,
            SC_PILL_FIXED_HEIGHT: SC_PILL_FIXED_HEIGHT,
            SC_PILL_PADDING: SC_PILL_PADDING,
            HULL_PADDING: HULL_PADDING,
            FIT_WORLD_PAD: FIT_WORLD_PAD,
            NEBULA_FIT_CORE: NEBULA_FIT_CORE,
            NEBULA_RADIUS_MULT: NEBULA_RADIUS_MULT,
            NEBULA_MIN_RADIUS: NEBULA_MIN_RADIUS,
            SC_OVERLAY_OPACITY_FACTOR: SC_OVERLAY_OPACITY_FACTOR,
            SC_SATELLITE_COUNT: SC_SATELLITE_COUNT,
            SC_LABEL_TOP_PAD: SC_LABEL_TOP_PAD,
            NODE_RADIUS: NODE_RADIUS,
            BASE_PAGE_DOT_SIZE: BASE_PAGE_DOT_SIZE,
            PAGE_SPREAD_MULT: PAGE_SPREAD_MULT,
            STAR_GLYPH_OPACITY_MULT: STAR_GLYPH_OPACITY_MULT,
        };
    }

    function applyTunerSnapshot(snap) {
        if (!snap) return;
        // Typography keys apply only from snapshots stamped with the current
        // TYPO_V — see the TUNER_TYPO_VERSION comment. Spatial keys below
        // (icon size, pills, nebula, node radius, LOD visibility) apply from
        // any profile version.
        var typoOK = snap.TYPO_V === TUNER_TYPO_VERSION;
        // Fog keys (NEBULA_RADIUS_MULT/NEBULA_MIN_RADIUS) apply only from
        // snapshots stamped with the current FOG_V — see the
        // TUNER_FOG_VERSION comment. HULL_PADDING is not part of the T3
        // re-baseline and is applied unconditionally below regardless.
        var fogOK = snap.FOG_V === TUNER_FOG_VERSION;
        // scIcon rides the typo gate too: its thresholds were re-baselined
        // in the same 2026-07-11 redesign (k_max 5.0 retired -> 1.15) and
        // again 2026-07-14 (k_min aligned to the 0.5 zoom floor). Unstamped
        // pre-redesign profiles pinning the old values silently undid both
        // re-baselines at every mount (the min-zoom icon-jump fix e151813
        // never reached live sessions until this gate).
        var TYPO_SCALE_KEYS = { clLabel: 1, scLabel: 1, scName: 1, singletonLabel: 1, groupLabel: 1, scIcon: 1 };
        if (snap.SCALE_THRESHOLDS) {
            for (var k in snap.SCALE_THRESHOLDS) {
                if (TYPO_SCALE_KEYS[k] && !typoOK) continue;
                if (SCALE_THRESHOLDS[k] && snap.SCALE_THRESHOLDS[k]) {
                    if (typeof snap.SCALE_THRESHOLDS[k].k_min === 'number') SCALE_THRESHOLDS[k].k_min = snap.SCALE_THRESHOLDS[k].k_min;
                    if (typeof snap.SCALE_THRESHOLDS[k].k_max === 'number') SCALE_THRESHOLDS[k].k_max = snap.SCALE_THRESHOLDS[k].k_max;
                }
            }
        }
        if (typoOK) {
            if (typeof snap.BASE_LABEL_FONT_SIZE === 'number') BASE_LABEL_FONT_SIZE = snap.BASE_LABEL_FONT_SIZE;
            if (typeof snap.BASE_SC_LABEL_FONT_SIZE === 'number') BASE_SC_LABEL_FONT_SIZE = snap.BASE_SC_LABEL_FONT_SIZE;
            if (typeof snap.BASE_GROUP_LABEL_FONT_SIZE === 'number') BASE_GROUP_LABEL_FONT_SIZE = snap.BASE_GROUP_LABEL_FONT_SIZE;
            if (typeof snap.BASE_SC_NAME_FONT_SIZE === 'number') BASE_SC_NAME_FONT_SIZE = snap.BASE_SC_NAME_FONT_SIZE;
            if (typeof snap.BASE_SINGLETON_LABEL_FONT_SIZE === 'number') BASE_SINGLETON_LABEL_FONT_SIZE = snap.BASE_SINGLETON_LABEL_FONT_SIZE;
            if (typeof snap.SC_NAME_LOD_K_MIN === 'number') SC_NAME_LOD_K_MIN = snap.SC_NAME_LOD_K_MIN;
            if (typeof snap.SC_NAME_LOD_FADE_RANGE === 'number') SC_NAME_LOD_FADE_RANGE = snap.SC_NAME_LOD_FADE_RANGE;
        }
        if (typeof snap.BASE_SC_ICON_SIZE === 'number') BASE_SC_ICON_SIZE = snap.BASE_SC_ICON_SIZE;
        if (typeof snap.ICON_LOD_FADE_START === 'number') ICON_LOD_FADE_START = snap.ICON_LOD_FADE_START;
        if (typeof snap.ICON_LOD_FADE_END === 'number') ICON_LOD_FADE_END = snap.ICON_LOD_FADE_END;
        if (typeof snap.GROUP_CAPTION_LOD_K_MIN === 'number') GROUP_CAPTION_LOD_K_MIN = snap.GROUP_CAPTION_LOD_K_MIN;
        if (typeof snap.GROUP_CAPTION_LOD_FADE === 'number') GROUP_CAPTION_LOD_FADE = snap.GROUP_CAPTION_LOD_FADE;
        if (typeof snap.LOD_BASE_THRESHOLD === 'number') LOD_BASE_THRESHOLD = snap.LOD_BASE_THRESHOLD;
        if (typeof snap.LOD_POWER === 'number') LOD_POWER = snap.LOD_POWER;
        if (typeof snap.LOD_FADE_RANGE === 'number') LOD_FADE_RANGE = snap.LOD_FADE_RANGE;
        if (typeof snap.SINGLETON_LOD_POWER === 'number') SINGLETON_LOD_POWER = snap.SINGLETON_LOD_POWER;
        if (typeof snap.SINGLETON_LOD_FADE_RANGE === 'number') SINGLETON_LOD_FADE_RANGE = snap.SINGLETON_LOD_FADE_RANGE;
        if (typeof snap.SINGLETON_LABEL_BASE_OPACITY === 'number') SINGLETON_LABEL_BASE_OPACITY = snap.SINGLETON_LABEL_BASE_OPACITY;
        if (typeof snap.SC_PILL_SHAPE === 'string') SC_PILL_SHAPE = snap.SC_PILL_SHAPE;
        if (typeof snap.SC_PILL_AUTOFIT === 'boolean') SC_PILL_AUTOFIT = snap.SC_PILL_AUTOFIT;
        if (typeof snap.SC_PILL_CORNER_ROUNDNESS === 'number') SC_PILL_CORNER_ROUNDNESS = snap.SC_PILL_CORNER_ROUNDNESS;
        if (typeof snap.SC_PILL_RADIUS === 'number') SC_PILL_RADIUS = snap.SC_PILL_RADIUS;
        if (typeof snap.SC_PILL_FIXED_WIDTH === 'number') SC_PILL_FIXED_WIDTH = snap.SC_PILL_FIXED_WIDTH;
        if (typeof snap.SC_PILL_FIXED_HEIGHT === 'number') SC_PILL_FIXED_HEIGHT = snap.SC_PILL_FIXED_HEIGHT;
        if (typeof snap.SC_PILL_PADDING === 'number') SC_PILL_PADDING = snap.SC_PILL_PADDING;
        if (typeof snap.HULL_PADDING === 'number') HULL_PADDING = snap.HULL_PADDING;
        if (typeof snap.FIT_WORLD_PAD === 'number') FIT_WORLD_PAD = snap.FIT_WORLD_PAD;
        if (typeof snap.NEBULA_FIT_CORE === 'number') NEBULA_FIT_CORE = snap.NEBULA_FIT_CORE;
        if (fogOK) {
            if (typeof snap.NEBULA_RADIUS_MULT === 'number') NEBULA_RADIUS_MULT = snap.NEBULA_RADIUS_MULT;
            if (typeof snap.NEBULA_MIN_RADIUS === 'number') NEBULA_MIN_RADIUS = snap.NEBULA_MIN_RADIUS;
        }
        if (typeof snap.SC_OVERLAY_OPACITY_FACTOR === 'number') SC_OVERLAY_OPACITY_FACTOR = snap.SC_OVERLAY_OPACITY_FACTOR;
        if (typeof snap.SC_SATELLITE_COUNT === 'number') SC_SATELLITE_COUNT = snap.SC_SATELLITE_COUNT;
        if (typeof snap.SC_LABEL_TOP_PAD === 'number') SC_LABEL_TOP_PAD = snap.SC_LABEL_TOP_PAD;
        if (typeof snap.NODE_RADIUS === 'number') NODE_RADIUS = snap.NODE_RADIUS;
        if (typeof snap.BASE_PAGE_DOT_SIZE === 'number') BASE_PAGE_DOT_SIZE = snap.BASE_PAGE_DOT_SIZE;
        if (typeof snap.PAGE_SPREAD_MULT === 'number') PAGE_SPREAD_MULT = snap.PAGE_SPREAD_MULT;
        if (typeof snap.STAR_GLYPH_OPACITY_MULT === 'number') STAR_GLYPH_OPACITY_MULT = snap.STAR_GLYPH_OPACITY_MULT;
        // Full re-render so all dependent layout updates pick up changes.
        if (rawData) render(rawData);
    }

    // ── Per-machine active-profile override (2026-07 fix, part 2) ───────
    // The server remembers profile CONTENTS plus a per-USER default active
    // slot (tuner_active_profile, above). This localStorage key lets each
    // machine/browser pin its OWN active slot, which wins over that server
    // default on this machine only -- e.g. a dev laptop can stay on a
    // "debug" profile while the server default (and every other machine)
    // uses "prod-look". Namespaced by user_key (see app.py
    // _build_user_state_payload) so admin<->demo view-as switching on one
    // browser can't cross-apply a profile saved under a different account.
    var MACHINE_SLOT_KEY_PREFIX = 'compendium_tuner_slot_';

    /** Resolve which profile slot should apply at boot, machine override
     *  first, then the server per-user default. Returns a slot string
     *  ('1'|'2'|'3') to apply that slot's snapshot, or null for "apply
     *  nothing, stay on code defaults" (explicit machine reset via 'none',
     *  or no override/default resolves to real content). All localStorage
     *  access is try/catch'd -- private-mode browsers throw on read/write. */
    function resolveEffectiveSlot(userState) {
        var savedProfiles = (userState && userState.tuner_profiles) || {};
        var userKey = userState && userState.user_key;
        if (userKey) {
            try {
                var stored = window.localStorage.getItem(MACHINE_SLOT_KEY_PREFIX + userKey);
                if (stored === 'none') return null;
                if (stored && savedProfiles[stored]) return stored;
            } catch (e) { /* private mode / storage disabled -- fall through to server default */ }
        }
        var serverSlot = userState && userState.tuner_active_profile;
        if (serverSlot && savedProfiles[serverSlot]) return serverSlot;
        return null;
    }

    // Set once applyBootProfile has run (successfully or as a deliberate
    // no-op) so mountDevTunerWithState's legacy auto-apply (below) can skip
    // re-doing the same work -- see that function's guard for why a second
    // apply would be a redundant full re-render, not just wasted cycles.
    var __bootProfileApplied = false;

    // S2 de-Dash DELETE (header comment delta #2): `applyBootProfile` (was
    // here, applied a saved profile before the deleted boot latch's first
    // render) is removed -- there is no saved-profile boot path outside
    // Dash. `resolveEffectiveSlot` above and `__bootProfileApplied` below
    // are left in place, verbatim, as inert dead code (delta #4).

    // `__tunerDefaults` is re-expressed against the constants snapshot
    // (header comment delta #4): reads the imported `GRAPH_DEFAULTS`
    // (lib/graph/constants.ts) directly instead of taking a
    // `getTunerSnapshot()` capture at script-eval time -- Task S1
    // transcribed GRAPH_DEFAULTS from this same file's code defaults, so
    // the two were already equal; this just names the constants module as
    // the one source of truth instead of a redundant local capture.
    var __tunerDefaults = GRAPH_DEFAULTS;

    // Design-verify harness hook -- unchanged below except reading the
    // re-expressed __tunerDefaults above. __d3ResetTunerToDefaults resets
    // tuner state for THIS page only — no fetch/POST, no write to any
    // account's stored preferences — so the design-verify harness can call
    // it to measure code-default rendering regardless of which profile a
    // test account has saved. applyTunerSnapshot() re-renders internally
    // via rawData, so no extra render call is needed here.
    __vendorResetTunerToDefaults = function () {
        applyTunerSnapshot(__tunerDefaults);
        return true;
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3ResetTunerToDefaults = __vendorResetTunerToDefaults;
    }

    // Debug/verify hook: apply a partial tuner override (stamped current
    // TYPO_V) on top of code defaults, for harness regression tests that
    // need a forced state (e.g. oversized icons to exercise nameplate
    // deconfliction). Page-local only — never persisted.
    __vendorApplyTunerOverrides = function (partial) {
        var snap = {};
        var k;
        for (k in __tunerDefaults) { if (__tunerDefaults.hasOwnProperty(k)) snap[k] = __tunerDefaults[k]; }
        for (k in partial) { if (partial.hasOwnProperty(k)) snap[k] = partial[k]; }
        applyTunerSnapshot(snap);
        return true;
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3ApplyTunerOverrides = __vendorApplyTunerOverrides;
    }

    // Debounced profile persistence. Profiles are saved as one dict; any
    // save action POSTs the full {1:.., 2:.., 3:..} map under the
    // 'tuner_profiles' key. Debounced so a fast Save -> Save sequence
    // collapses, though in practice saves are user-button clicks (rare).
    var __profilesPersistTimer = null;
    function persistProfiles(profiles) {
        if (__profilesPersistTimer) clearTimeout(__profilesPersistTimer);
        __profilesPersistTimer = setTimeout(function () {
            fetch('/_persist_prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: 'tuner_profiles',
                    value: profiles,
                }),
            }).catch(function () { /* fire-and-forget */ });
        }, 200);
    }

    // Persist the last-touched profile slot so the next app-load auto-applies
    // it. Save / Load set this to the slot string ('1' | '2' | '3'); Reset
    // sets it to null so the next mount starts at code defaults.
    function persistActiveProfile(slot) {
        fetch('/_persist_prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: 'tuner_active_profile',
                value: slot,  // string or null
            }),
        }).catch(function () { /* fire-and-forget */ });
    }

    // Mirror the server-side active-profile write into this machine's
    // localStorage (2026-07 fix, part 2) -- write-at-origin-of-change only,
    // no write-on-load/hydrate anywhere else (hydration must never look
    // like a user change). Load/Save pass the slot string through to the
    // server AND pin it here; Reset (slot === null) writes the literal
    // string 'none' so resolveEffectiveSlot can tell "explicitly reset on
    // this machine" apart from "no override yet, defer to server default".
    // try/catch'd for private-mode browsers that throw on localStorage access.
    function persistActiveProfileWithMachineOverride(slot) {
        persistActiveProfile(slot);
        var userKey = __userState && __userState.user_key;
        if (userKey) {
            try {
                window.localStorage.setItem(MACHINE_SLOT_KEY_PREFIX + userKey, slot === null ? 'none' : slot);
            } catch (e) { /* private mode / storage disabled -- server-side pref still applies */ }
        }
    }

    // Persist user-customized profile slot names. Schema: {"1"?: str, ...}.
    // Missing entries fall back to "Profile N" in the UI. Debounced so a
    // burst of edits-per-keystroke collapses (the panel itself commits on
    // Enter/blur, but the safety net is cheap).
    var __namesPersistTimer = null;
    function persistProfileNames(names) {
        if (__namesPersistTimer) clearTimeout(__namesPersistTimer);
        __namesPersistTimer = setTimeout(function () {
            fetch('/_persist_prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: 'tuner_profile_names',
                    value: names,
                }),
            }).catch(function () { /* fire-and-forget */ });
        }, 200);
    }

    // S2 de-Dash STRIP (header comment delta #4): mountDevTunerOnce +
    // mountDevTunerWithState (source :916-1386, the whole DevTuner-mount
    // config -- oscillation control, TEXT/SUPERCLUSTER ICONS/STARS/NEBULA/
    // CANVAS FIT sections, profile menu) are deleted, not gated --
    // window.DevTuner is never defined outside Dash, so this was always a
    // no-op guard ("if (!window.DevTuner ...) return;") in this repo. Its
    // single call site inside render() is deleted too (see render()).

    /** Build a top-right zoom indicator overlay with +/- buttons inside
     *  the graph container. Idempotent — safe to call on every render. */

    function ensureZoomIndicator(container, getZoomBehavior) {
        if (zoomIndicatorPctEl && document.body.contains(zoomIndicatorPctEl)) return;
        if (!container) return;
        // Container needs non-static position for absolute children.
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        var wrap = document.createElement('div');
        wrap.className = 'd3-zoom-indicator';
        wrap.style.cssText = [
            'position:absolute', 'top:10px', 'right:10px', 'z-index:10',
            'display:flex', 'align-items:center', 'gap:4px',
            'background:rgba(0,0,0,0.5)', 'border-radius:6px',
            'padding:4px 8px', 'font:600 12px sans-serif',
            'color:#fff', 'pointer-events:auto', 'user-select:none',
        ].join(';');
        var btnStyle = [
            'background:rgba(255,255,255,0.1)', 'border:none', 'color:#fff',
            'cursor:pointer', 'width:24px', 'height:24px', 'border-radius:4px',
            'font-size:14px', 'line-height:1', 'padding:0',
        ].join(';');
        function makeBtn(label, factor, title) {
            var b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = btnStyle;
            b.title = title;
            b.addEventListener('click', function () {
                var zb = getZoomBehavior();
                if (svg && zb) {
                    svg.transition().duration(200).call(zb.scaleBy, factor);
                }
            });
            return b;
        }
        var minus = makeBtn('\u2212', 1 / 1.5, 'Zoom out');
        // Editable zoom percent: typing a number + Enter (or blur) snaps
        // the canvas to that zoom level via the bound zoom behavior. The
        // sibling "%" sign sits outside the input so the user types a
        // bare number. Range clamping uses the live scaleExtent so it
        // tracks the runtime extent set in fitToContent (10% .. 400% of
        // fit-scale at the time of writing).
        var pctGroup = document.createElement('span');
        pctGroup.style.cssText = 'display:inline-flex;align-items:center;gap:1px;';
        var pct = document.createElement('input');
        pct.type = 'text';
        pct.inputMode = 'numeric';
        pct.value = '100';
        pct.title = 'Type a zoom percentage and press Enter';
        pct.style.cssText = [
            'width:36px', 'text-align:right',
            'background:transparent', 'border:1px solid transparent',
            'color:#fff', 'font:inherit',
            'padding:1px 2px', 'border-radius:3px',
            'outline:none',
        ].join(';');
        pct.addEventListener('focus', function () {
            pct.select();
            pct.style.borderColor = 'rgba(255,255,255,0.4)';
        });
        pct.addEventListener('blur', function () {
            pct.style.borderColor = 'transparent';
            applyTypedZoom();
        });
        pct.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); pct.blur(); }
            else if (e.key === 'Escape') {
                pct.value = Math.round(((fitZoom > 0 ? currentZoomK / fitZoom : 1)) * 100) + '';
                pct.blur();
            }
        });
        function applyTypedZoom() {
            var n = parseFloat(pct.value);
            if (!isFinite(n) || fitZoom <= 0) {
                updateZoomIndicator(currentZoomK);
                return;
            }
            var zb = getZoomBehavior();
            if (!zb || !svg) {
                updateZoomIndicator(currentZoomK);
                return;
            }
            var ext = (typeof zb.scaleExtent === 'function') ? zb.scaleExtent() : [0, Infinity];
            var targetK = fitZoom * (n / 100);
            targetK = Math.max(ext[0], Math.min(ext[1], targetK));
            svg.transition().duration(200).call(zb.scaleTo, targetK);
        }
        var pctSign = document.createElement('span');
        pctSign.textContent = '%';
        pctSign.style.cssText = 'opacity:0.7;';
        pctGroup.appendChild(pct);
        pctGroup.appendChild(pctSign);
        var plus = makeBtn('+', 1.5, 'Zoom in');
        wrap.appendChild(minus);
        wrap.appendChild(pctGroup);
        wrap.appendChild(plus);
        container.appendChild(wrap);
        zoomIndicatorPctEl = pct;
    }

    /** Rethink R6.2: HTML overlay (sibling of the svg, not inside it) that
     *  holds the edge chips -- off-screen wayfinding pointers back to a
     *  supercluster whose nameplate has scrolled out of view. HTML rather
     *  than SVG so chip sizing/position never fights the zoom transform.
     *  Idempotent -- safe to call on every render, like ensureZoomIndicator. */
    function ensureEdgeChipLayer(container) {
        if (edgeChipLayerEl && document.body.contains(edgeChipLayerEl)) return edgeChipLayerEl;
        if (!container) return null;
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        var chipLayer = document.createElement('div');
        chipLayer.id = 'sc-edge-chips';
        chipLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
        container.appendChild(chipLayer);
        edgeChipLayerEl = chipLayer;
        return chipLayer;
    }

    /** Rethink R6.2: rebuild the edge-chip layer's children from scratch --
     *  cheap (a handful of SCs). A chip renders for a supercluster whose
     *  nameplate anchor (icon/name centroid) has panned offscreen while the
     *  user is still near/inside its content (its world bbox still
     *  intersects the viewport) -- i.e. you're deep inside one SC's zone
     *  and need a pointer back to it, not a chip for every SC that merely
     *  isn't centered. Called at the end of the zoom handler and once after
     *  fitToContent settles (see call sites) so chips are correct at first
     *  paint, not just after the first pan. */
    function updateEdgeChips() {
        if (!SANDBOX_SECTION_GATES.edgeChip) return;  // S2 sandbox-bar gate (header comment delta #8)
        var layer = edgeChipLayerEl;
        if (!layer) return;
        while (layer.firstChild) layer.removeChild(layer.firstChild);
        if (!svg || !currentData) return;
        var root = svg.select('.graph-root');
        var rootNode = root.node();
        if (!rootNode) return;
        var ctm = rootNode.getScreenCTM();
        if (!ctm) return;
        var container = __mountedContainer;  // was getElementById('d3-graph-container') (header comment delta #1)
        if (!container) return;
        var crect = container.getBoundingClientRect();
        if (crect.width <= 0 || crect.height <= 0) return;

        function worldToScreen(wx, wy) {
            return {
                x: ctm.a * wx + ctm.c * wy + ctm.e - crect.left,
                y: ctm.b * wx + ctm.d * wy + ctm.f - crect.top,
            };
        }

        var superClusters = currentData.super_clusters || [];
        var clusters = currentData.clusters || [];
        // Same-tick reuse: drawWatermarks (fired from updateLabelScale just
        // before this, on every zoom tick) already computed centroids for
        // the identical clusters/nodes -- only recompute if nothing has
        // populated the cache yet (e.g. first paint before any watermark
        // draw), and store it so later callers benefit too.
        var centroids = lastClusterCentroids ||
            (lastClusterCentroids = computeClusterCentroids(clusters, currentData.nodes || []));
        var MARGIN = 28;  // chip clearance from the true viewport edge, px

        superClusters.forEach(function (sc) {
            var kw = sc.keyword;
            if (!kw || !sc.icon_id) return;  // no rendered watermark -> no chip pointing at it
            var memberClusters = clusters.filter(function (c) { return c.super_cluster === kw; });
            if (!memberClusters.length) return;

            // Same centroid math as drawWatermarks -- the nameplate anchor.
            var wcx = 0, wcy = 0, wcn = 0;
            memberClusters.forEach(function (mc) {
                var cen = centroids[mc.id];
                if (cen) { wcx += cen.x; wcy += cen.y; wcn++; }
            });
            if (!wcn) return;
            wcx /= wcn; wcy /= wcn;

            var anchor = worldToScreen(wcx, wcy);
            var onscreen = anchor.x >= 0 && anchor.x <= crect.width &&
                           anchor.y >= 0 && anchor.y <= crect.height;
            if (onscreen) return;  // nameplate already visible -- no chip needed

            // Anchor offscreen isn't enough on its own (that's true from
            // clear across the map) -- also require the SC's own content to
            // still intersect the viewport, i.e. you're actually near/in
            // its territory right now.
            var bb = scWorldBBox(kw);
            if (!bb) return;
            var corners = [
                worldToScreen(bb.minX, bb.minY), worldToScreen(bb.maxX, bb.minY),
                worldToScreen(bb.minX, bb.maxY), worldToScreen(bb.maxX, bb.maxY),
            ];
            var sMinX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
            var sMaxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
            var sMinY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
            var sMaxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
            var intersects = sMaxX >= 0 && sMinX <= crect.width &&
                              sMaxY >= 0 && sMinY <= crect.height;
            if (!intersects) return;

            // Clamp the anchor into the viewport (minus margin) and pick a
            // single edge/glyph from whichever axis overflows more --
            // avoids diagonal chips, matches the four-glyph spec.
            var clampedX = Math.max(MARGIN, Math.min(crect.width - MARGIN, anchor.x));
            var clampedY = Math.max(MARGIN, Math.min(crect.height - MARGIN, anchor.y));
            var leftOver = MARGIN - anchor.x, rightOver = anchor.x - (crect.width - MARGIN);
            var topOver = MARGIN - anchor.y, bottomOver = anchor.y - (crect.height - MARGIN);
            var hOver = Math.max(leftOver, rightOver, 0);
            var vOver = Math.max(topOver, bottomOver, 0);

            var glyph, chipX, chipY;
            if (hOver >= vOver) {
                glyph = leftOver > rightOver ? '◂' : '▸';  // ◂ / ▸
                chipX = leftOver > rightOver ? MARGIN : crect.width - MARGIN;
                chipY = clampedY;
            } else {
                glyph = topOver > bottomOver ? '▴' : '▾';  // ▴ / ▾
                chipY = topOver > bottomOver ? MARGIN : crect.height - MARGIN;
                chipX = clampedX;
            }

            var chip = document.createElement('div');
            chip.className = 'sc-edge-chip';
            chip.style.left = chipX + 'px';
            chip.style.top = chipY + 'px';
            chip.style.transform = 'translate(-50%, -50%)';
            chip.style.pointerEvents = 'auto';
            chip.textContent = glyph + ' ' + kw;
            chip.addEventListener('click', function (event) {
                event.stopPropagation();
                frameWorldBBox(scWorldBBox(kw), { maxRatio: 1.2, minRatio: 0.6 });
            });
            layer.appendChild(chip);
        });
    }

    function updateZoomIndicator(currentK) {
        if (!zoomIndicatorPctEl) return;
        // Don't clobber the user mid-type. document.activeElement check lets
        // the user keep typing while a programmatic zoom (scroll, oscillate)
        // changes the underlying value.
        if (document.activeElement === zoomIndicatorPctEl) return;
        var ratio = (fitZoom > 0) ? (currentK / fitZoom) : 1;
        zoomIndicatorPctEl.value = Math.round(ratio * 100) + '';
    }

    /** Update label font-size + tspan spacing + SC-pill rect, AND re-render
     *  SC watermarks to reflect current scIcon/scName scale settings.
     *  Cluster placement, page node radius, and Phase 1.75 are NOT touched.
     *  Called on zoom events, after fitToContent, and from the tuner panel. */
    function updateLabelScale(zoomK) {
        if (!svg) return;
        currentZoomK = zoomK;
        var clScale = clampedScale(zoomK, 'clLabel');
        var scLblScale = clampedScale(zoomK, 'scLabel');

        // Patch each text.hull-label using the appropriate scale + base size
        // based on whether its cluster is an SC member.
        svg.selectAll('g.hull-label-group').each(function (d) {
            if (!d || !d.cluster) return;
            var g = d3.select(this);
            var textEl = g.select('text.hull-label');
            if (textEl.empty()) return;
            var isSC = isSuperClusterLike(d.cluster);
            var scale = isSC ? scLblScale : clScale;
            var baseSize = isSC ? BASE_SC_LABEL_FONT_SIZE : BASE_LABEL_FONT_SIZE;
            var lblSize = baseSize * scale;
            var lineH = (baseSize * 1.2) * scale;
            var gap = 16 * scale;   // LABEL_TO_CLUSTER_GAP scales with text
            textEl.attr('font-size', lblSize + 'px');
            var lineCount = +textEl.attr('data-line-count') || 1;
            // SC pills: re-center tspans on the (fixed) radial anchor.
            // Non-SC labels: keep the original "bottom pinned to cluster top"
            // formula so growing fonts don't push the label down into the cluster.
            var newCenterY;
            if (isSC) {
                newCenterY = +textEl.attr('data-anchor-y');
            } else {
                var clusterTopY = +textEl.attr('data-cluster-top-y');
                newCenterY = isFinite(clusterTopY)
                    ? clusterTopY - gap - 2 - (lineCount - 1) * (lineH / 2)
                    : NaN;
            }
            if (isFinite(newCenterY)) {
                var startY = newCenterY - (lineCount - 1) * lineH / 2;
                textEl.selectAll('tspan').each(function (_, i) {
                    d3.select(this).attr('y', startY + i * lineH);
                });
            }
            // Re-position the SC marker dot after a zoom-driven font-size
            // change — applySCMarker reads the text's current bbox and the
            // clamped scLabel scale so the marker stays screen-constant
            // alongside its label.
            if (isSC) {
                applySCMarker(g, textEl);
            }
        });

        // Group captions: screen-constant size, constant painted gap,
        // mutual deconfliction (they cluster mid-canvas when their masses
        // interleave — observed crossing captions in the V2 verify pass).
        positionGroupCaptions(zoomK);

        // Re-render SC watermarks so scIcon + scName scale changes take effect.
        // Cheap: only 3 SCs in current data. drawWatermarks reads currentZoomK
        // via clampedScale to compute its sizes.
        if (currentData && currentData.clusters) {
            var root = svg.select('g.graph-root');
            if (!root.empty()) drawWatermarks(root, currentData.clusters);
        }

        // Singleton labels piggyback on the same zoom event so their font
        // size stays consistent with cluster-label scaling at every zoom.
        updateSingletonLabelScale(zoomK);
        updatePageDotScale(zoomK);
    }

    // Rethink R1.1: world-space radius that paints screen-clamped. The
    // selected/armed x1.8 emphasis is applied by callers, not here.
    function pageDotRadius(d, zoomK) {
        var s = BASE_PAGE_DOT_SIZE * clampedScale(zoomK, 'pageDot');
        return (d && d.kind === 'singleton') ? s * 0.85 : s;
    }

    // Deterministic star-spike variant per page id, 0-3 (checkpoint-A
    // iteration). Reuses the file's existing hashId (String() guard since
    // hashId assumes a string, and page ids may arrive numeric).
    function starVariant(id) {
        return hashId(String(id)) % 4;  // 0-3: four real glyph variants (v0 = compact diamond; no plain-core case since 3c)
    }

    // Rethink R2.4: shared so the render chain and the hover mouseleave
    // restore path can't drift apart. Muted resting opacity for a page's
    // star glyph, scaled up slightly with visit_count (capped at +3 visits).
    function starGlyphOpacity(d) {
        var v = (d && d.visit_count) || 1;
        return STAR_GLYPH_OPACITY_MULT * Math.min(1, 0.78 + 0.08 * Math.min(3, v - 1));
    }

    function updatePageDotScale(zoomK) {
        if (!svg) return;
        svg.selectAll('circle.page').attr('r', function (d) {
            var r = pageDotRadius(d, zoomK);
            return (d && d.id === selectedNodeId) ? r * 1.8 : r;
        });
        svg.selectAll('use.star-spikes').attr('transform', function (d) {
            // Glyph paths span 1.3-3 units; 0.95x the anchor radius
            // (checkpoint-A tuned down from 1.15) mutes the stars; the
            // longest flare tips reach ~2.9x the anchor.
            var s = pageDotRadius(d, zoomK) * 0.95;
            // Arming emphasis (rethink R2.2, tranche-A deviation): circles
            // are invisible anchors now, so the armed/selected bump lives on
            // the visible glyph's scale, not a circle stroke.
            if (d && (d.id === selectedNodeId || (armedNode && d.id === armedNode.id))) s = s * 1.5;
            return 'translate(' + d.x + ',' + d.y + ') scale(' + s + ')';
        });
    }

    // Rethink R2.1: nearest-dot lookup rebuilt whenever the rendered node
    // set changes (render() calls this after fitToContent). Filters out
    // nodes without a laid-out position so a mid-layout call can't hand
    // d3.Delaunay NaN coordinates.
    function rebuildDelaunay(nodes) {
        pageDelaunayNodes = (nodes || []).filter(function (n) {
            return n.x != null && n.y != null;
        });
        pageDelaunay = pageDelaunayNodes.length
            ? d3.Delaunay.from(pageDelaunayNodes,
                function (n) { return n.x; }, function (n) { return n.y; })
            : null;
    }

    // Tranche-A deviation from the original brief: no circle stroke here.
    // circle.page is an invisible anchor (fill-opacity 0) since tranche A,
    // so a contrasting stroke on it would be a no-op. Arm/disarm just flip
    // armedNode and re-run updatePageDotScale, which reads armedNode itself
    // to apply the glyph-scale bump above.
    function disarmDot() {
        if (!armedNode) return;
        armedNode = null;
        hideTooltip();
        if (svg) {
            svg.style('cursor', null);
            updatePageDotScale(currentZoomK);
        }
    }

    function updateArmedDot(event) {
        if (!pageDelaunay || !svg) return;
        // Elements with their own hover semantics win over dot arming.
        var t = event.target;
        if (t && t.closest && t.closest('g.hull-label-group, g.group-label-group, g.watermark, circle.knot-hit, .d3-zoom-indicator')) {
            disarmDot();
            return;
        }
        var tf = d3.zoomTransform(svg.node());
        var p = d3.pointer(event, svg.node());
        var wx = tf.invertX(p[0]), wy = tf.invertY(p[1]);
        var n = pageDelaunayNodes[pageDelaunay.find(wx, wy)];
        if (!n) { disarmDot(); return; }
        var dx = (n.x - wx) * tf.k, dy = (n.y - wy) * tf.k;
        if (dx * dx + dy * dy > ARM_RADIUS_PX * ARM_RADIUS_PX) { disarmDot(); return; }
        if (!armedNode || armedNode.id !== n.id) {
            armedNode = n;
            svg.style('cursor', 'pointer');
            updatePageDotScale(currentZoomK);
        }
        showTooltip(event, n);
    }

    function updateLabelLOD(currentK) {
        if (!svg) return;
        var ratio = (fitZoom > 0) ? (currentK / fitZoom) : 1;
        var threshold = Math.max(0, LOD_BASE_THRESHOLD / Math.pow(ratio, LOD_POWER));
        // Page-count LOD writes the label's BASE opacity; the collision
        // cull (runLabelCull) multiplies on top via data-culled. During
        // continuous zoom, culled labels stay hidden until the debounced
        // cull re-evaluates — avoids per-tick resurrect flicker.
        svg.selectAll('g.hull-label-group').each(function (d) {
            var op = 1;
            if (d && d.cluster) {
                var pc = (d.cluster.page_ids || []).length;
                if (pc < threshold) {
                    var below = threshold - pc;
                    op = below >= LOD_FADE_RANGE ? 0 : 1 - (below / LOD_FADE_RANGE);
                }
            }
            var g = d3.select(this);
            g.attr('data-lod-opacity', op);
            g.style('opacity', g.attr('data-culled') ? 0 : op);
        });
        // Singleton fade runs on the same zoom event but uses outlier_score
        // rank as its signal (singletons are by definition 1 page, so the
        // cluster-page-count threshold above doesn't apply to them).
        updateSingletonLabelLOD(currentK);
        scheduleLabelCull();
    }

    // ── Collision-culled label visibility (design audit 2026-07-11 §3) ──
    // Page-count LOD alone left every label visible in the dense account
    // (21 colliding pairs at 1920px, 50 at 1366px — all clusters clear the
    // 2.5-page bar). This pass greedily keeps the highest-priority labels
    // whose screen boxes don't intersect anything already kept. Priority:
    // SC names + group captions are obstacles (never culled), then cluster
    // labels by page count, then page-title labels by outlier rank.
    // Debounced: runs ~90ms after the last zoom/render event.
    var __cullTimer = null;
    function scheduleLabelCull() {
        if (__cullTimer) clearTimeout(__cullTimer);
        __cullTimer = setTimeout(runLabelCull, 90);
    }

    // Screen-space AABB via getScreenCTM so ancestor transforms (zoom on
    // .graph-root, translate on g.watermark) are all accounted for. Our
    // transforms are axis-aligned (translate+scale, no rotation).
    function screenBBoxOf(el) {
        var b;
        try { b = el.getBBox(); } catch (e) { return null; }
        if (!b || !b.width || !b.height) return null;
        var m = el.getScreenCTM();
        if (!m) return null;
        var x1 = m.a * b.x + m.c * b.y + m.e;
        var y1 = m.b * b.x + m.d * b.y + m.f;
        var x2 = m.a * (b.x + b.width) + m.c * (b.y + b.height) + m.e;
        var y2 = m.b * (b.x + b.width) + m.d * (b.y + b.height) + m.f;
        return { left: Math.min(x1, x2), right: Math.max(x1, x2),
                 top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
    }

    // Shared "is this element actually painted" test for the LOD gates
    // added in R6 -- icon fade (drawWatermarks) and the group-caption gate
    // (positionGroupCaptions) both drive an element's opacity to 0 well
    // before it's removed from the DOM, and obstacle/cull passes must not
    // treat an invisible element as blocking real content.
    function computedOpacity(el) {
        if (!el) return 1;
        var v = parseFloat(getComputedStyle(el).opacity);
        return isNaN(v) ? 1 : v;
    }

    // Rethink R3.1: one obstacle set for every label-placement pass. Chrome
    // widgets and watermark lockups occupy screen space that no painted
    // text may cross; previously only SC names + captions were obstacles,
    // and only inside the cull (captions placed blind to icons entirely).
    function collectObstacleRects() {
        var rects = [];
        ['.d3-zoom-indicator', '#search-bar', '#search-tab'].forEach(function (sel) {
            var el = document.querySelector(sel);
            if (!el) return;
            var b = el.getBoundingClientRect();
            if (b.width > 0 && b.height > 0) {
                rects.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
            }
        });
        if (svg) {
            svg.selectAll('g.watermark').each(function () {
                // R6.1: a fully-faded icon (deep zoom, past ICON_LOD_FADE_END)
                // is not visually present -- it must not block caption/label
                // placement just because its geometry is still in the DOM.
                var iconPath = this.querySelector('path');
                if (computedOpacity(iconPath) <= 0.05) return;
                var r = screenBBoxOf(this);
                if (r) rects.push(r);
            });
        }
        return rects;
    }

    function runLabelCull() {
        if (!svg) return;
        var kept = [];
        collectObstacleRects().forEach(function (r) { kept.push(r); });
        var PAD = 2;  // screen px of required clearance between labels
        function collides(r) {
            for (var i = 0; i < kept.length; i++) {
                var k = kept[i];
                if (r.left < k.right + PAD && k.left < r.right + PAD &&
                    r.top < k.bottom + PAD && k.top < r.bottom + PAD) return true;
            }
            return false;
        }

        // Obstacles: SC names + group captions always win their space --
        // except when a LOD gate (SC_NAME_LOD, GROUP_CAPTION_LOD) has faded
        // one to invisible; an unpainted caption must not block a cullable
        // label from taking its pixels (R6.3).
        svg.selectAll('text.supercluster-label, text.group-label').each(function () {
            if (computedOpacity(this) <= 0.05) return;
            var r = screenBBoxOf(this);
            if (r) kept.push(r);
        });

        // Cluster labels, biggest clusters first.
        var entries = [];
        svg.selectAll('g.hull-label-group').each(function (d) {
            entries.push({
                el: this,
                g: d3.select(this),
                pc: (d && d.cluster && d.cluster.page_ids || []).length,
            });
        });
        entries.sort(function (a, b) { return b.pc - a.pc; });

        // Selection is uncullable AND wins its space against every other
        // label: seed its rect before the greedy pass so higher-priority
        // (bigger) clusters can't claim the same pixels first (T8 review).
        var selectedEntry = null;
        if (selectedClusterId) {
            for (var si = 0; si < entries.length; si++) {
                var sd = entries[si].g.datum();
                if (sd && sd.cluster && sd.cluster.id === selectedClusterId) {
                    selectedEntry = entries[si];
                    break;
                }
            }
            if (selectedEntry) {
                selectedEntry.g.attr('data-culled', null).style('opacity', 1);
                var selRect = screenBBoxOf(selectedEntry.el);
                if (selRect) kept.push(selRect);
            }
        }

        entries.forEach(function (e) {
            // Skip the selected entry — it's already seeded above
            if (e === selectedEntry) return;

            var lod = e.g.attr('data-lod-opacity');
            var baseOp = lod == null ? 1 : +lod;
            if (baseOp <= 0) { e.g.attr('data-culled', null); return; }
            var r = screenBBoxOf(e.el);
            if (!r) return;
            if (collides(r)) {
                e.g.attr('data-culled', '1').style('opacity', 0);
            } else {
                e.g.attr('data-culled', null).style('opacity', baseOp);
                kept.push(r);
            }
        });

        updatePageTitleLabels(kept, collides);
    }

    // Group captions are never culled — each is the sole caption of a
    // collapsed mass — so overlaps among them are resolved by sliding the
    // lower-priority caption (fewer pages) downward below its collider.
    // Screen-constant fonts mean overlap depends on zoom, so this runs on
    // every scale pass; y is always rebuilt from data-group-min-y first,
    // making the pass idempotent.
    function positionGroupCaptions(zoomK) {
        if (!svg) return;
        var grpScale = clampedScale(zoomK, 'groupLabel');
        var fontPx = (BASE_GROUP_LABEL_FONT_SIZE * grpScale) + 'px';
        // Rethink R6.3: gate captions off at far zoom-out. Below K_MIN the
        // galaxy-overview scale has captions crowding SC nameplates/labels
        // sharing that space; ratio is fit-relative like every other LOD
        // gate in this file.
        var ratio = (fitZoom > 0) ? (zoomK / fitZoom) : 1;
        var capOp = ratio >= GROUP_CAPTION_LOD_K_MIN + GROUP_CAPTION_LOD_FADE ? 1
            : (ratio <= GROUP_CAPTION_LOD_K_MIN ? 0
                : (ratio - GROUP_CAPTION_LOD_K_MIN) / GROUP_CAPTION_LOD_FADE);
        var items = [];
        svg.selectAll('text.group-label').each(function (d) {
            var t = d3.select(this);
            t.style('font-size', fontPx).style('opacity', capOp);
            // Invisible captions must not keep their hit target: clicking a
            // caption toggles group expand/collapse, and an unpainted
            // catcher over unrelated content is a bug (mirrors the R6.1
            // icon-fade pointer-events treatment). collectObstacleRects /
            // runLabelCull separately skip them as obstacles via
            // computedOpacity().
            d3.select(this.parentNode)
                .style('pointer-events', capOp === 0 ? 'none' : 'bounding-box');
            var minY = +t.attr('data-group-min-y');
            if (isFinite(minY)) t.attr('y', minY - GROUP_LABEL_GAP * grpScale);
            items.push({ el: this, t: t, pages: (d && d.pages) || 0 });
        });
        items.sort(function (a, b) { return b.pages - a.pages; });
        // Captions must dodge chrome/icons even when there's only one of
        // them — the old early-out only deconflicted caption-vs-caption.
        var placed = collectObstacleRects();
        // R6.1 follow-up: collectObstacleRects skips a watermark once its
        // ICON has faded (nameRatio past ICON_LOD_FADE_END) so cullable
        // labels can reclaim that screen space -- but the SC NAME text
        // inside that same g often hasn't faded (SC_NAME_LOD gates a
        // different, much-lower ratio band) and still needs protecting.
        // Re-add supercluster-label rects independently, same as
        // runLabelCull's separate obstacle pass, so a caption can't land on
        // a still-painted SC name just because its sibling icon vanished.
        svg.selectAll('text.supercluster-label').each(function () {
            if (computedOpacity(this) <= 0.05) return;
            var r = screenBBoxOf(this);
            if (r) placed.push(r);
        });
        items.forEach(function (it) {
            var r = screenBBoxOf(it.el);
            if (!r) return;
            var guard = 0, moved = true;
            while (moved && guard++ < 8) {
                moved = false;
                for (var i = 0; i < placed.length; i++) {
                    var p = placed[i];
                    if (r.left < p.right + 4 && p.left < r.right + 4 &&
                        r.top < p.bottom + 2 && p.top < r.bottom + 2) {
                        var dy = (p.bottom + 3) - r.top;      // screen px
                        it.t.attr('y', (+it.t.attr('y')) + dy / (zoomK || 1));
                        r.top += dy; r.bottom += dy;
                        moved = true;
                    }
                }
            }
            placed.push(r);
        });
    }

    // ── Shared centroid helper ───────────────────────────────────────

    function computeClusterCentroids(clusters, nodes) {
        var centroids = {};
        clusters.forEach(function (c) {
            var pageSet = {};
            c.page_ids.forEach(function (pid) { pageSet[pid] = true; });
            var cx = 0, cy = 0, cnt = 0;
            nodes.forEach(function (n) {
                if (pageSet[n.id] && n.x != null) { cx += n.x; cy += n.y; cnt++; }
            });
            if (cnt > 0) centroids[c.id] = { x: cx / cnt, y: cy / cnt };
        });
        return centroids;
    }

    // ── Shrinkwrap foundation ────────────────────────────────────────
    // Every layout participant exposes a composite AABB covering its
    // on-screen footprint so repulsion phases can treat the whole
    // visual block, not just its centroid. These helpers are read-only;
    // placement logic (Phase 2 forces, label anchors, pill perimeter
    // push) is unchanged — consumers just ingest bboxes as input.
    //
    // Consumer wiring happens in later fixes:
    //   fix #3 → Phase 1.75 uses computeClusterShrinkwrap + rectCircleOverlap
    //   fix #5 → label pass uses computeWatermarkBBox + rectRectOverlap
    //   fix #6 → pill placement uses all four

    var SHRINKWRAP_PAD = 8;
    var LABEL_LINE_HEIGHT_ESTIMATE = 12;
    var LABEL_CHAR_WIDTH_ESTIMATE = 6;
    var LABEL_WRAP_CHARS = 18;
    // Vertical clearance between the icon's bottom edge and the visual top
    // of the SC name label. Single source of truth: drawWatermarks uses
    // dominant-baseline="hanging" and offsets label y by this amount, and
    // computeWatermarkBBox uses the same value so the shrinkwrap bbox
    // tracks the rendered label position.
    var SC_LABEL_TOP_PAD = 10;

    /**
     * Wrap a name into display lines using the same heuristic the label
     * renderer uses (see drawHulls), so shrinkwrap predictions match
     * what will eventually be drawn.
     */
    function estimateLabelLines(name, maxChars) {
        var words = (name || '').split(/\s+/);
        var lines = [], cur = '';
        for (var i = 0; i < words.length; i++) {
            if (cur.length + words[i].length + 1 > maxChars && cur.length > 0) {
                lines.push(cur);
                cur = words[i];
            } else {
                cur = cur ? cur + ' ' + words[i] : words[i];
            }
        }
        if (cur) lines.push(cur);
        return lines;
    }

    // Cache of measured label dimensions, keyed by raw cluster name.
    // Populated by measureLabelDims() during render setup; falls back to
    // char-width estimate if not yet measured (first render frame, or names
    // changed mid-session).
    var labelDimsCache = {};

    /** Measure the actual rendered width of a label by drawing it into a
     *  hidden text element. More accurate than LABEL_CHAR_WIDTH_ESTIMATE
     *  for variable-width fonts — lets Phase 1.75 non-SC repel push
     *  clusters apart by the right amount. */
    function measureLabelDims(name, hostSel) {
        if (!name) return { w: 0, h: 0 };
        if (labelDimsCache[name]) return labelDimsCache[name];
        if (!hostSel || !hostSel.node) return null;
        var lines = estimateLabelLines(name, LABEL_WRAP_CHARS);
        var measureG = hostSel.append('g').style('visibility', 'hidden');
        var t = measureG.append('text')
            .attr('font-size', '10px')
            .attr('font-weight', '600');
        var maxW = 0;
        lines.forEach(function (l) {
            t.text(l);
            try {
                var bb = t.node().getBBox();
                if (bb.width > maxW) maxW = bb.width;
            } catch (e) {}
        });
        measureG.remove();
        var dims = { w: maxW, h: lines.length * LABEL_LINE_HEIGHT_ESTIMATE };
        labelDimsCache[name] = dims;
        return dims;
    }

    function estimateLabelBBox(name, anchorX, anchorY) {
        var w, h;
        var measured = labelDimsCache[name];
        if (measured) {
            w = measured.w;
            h = measured.h;
        } else {
            var lines = estimateLabelLines(name, LABEL_WRAP_CHARS);
            var maxLen = 0;
            lines.forEach(function (l) { if (l.length > maxLen) maxLen = l.length; });
            w = maxLen * LABEL_CHAR_WIDTH_ESTIMATE;
            h = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
        }
        return {
            minX: anchorX - w / 2,
            maxX: anchorX + w / 2,
            minY: anchorY - h / 2,
            maxY: anchorY + h / 2,
            w: w,
            h: h,
        };
    }

    /**
     * Pre-Phase-2 shrinkwrap estimator — uses only the cluster's centroid,
     * member count, and name. Needed in Phase 1.75 where actual node
     * positions don't exist yet; the full computeClusterShrinkwrap below
     * requires laid-out nodes and returns null otherwise.
     *
     * Returns an AABB predicting where the cluster + its plain-label
     * will sit after rendering, so Phase 1.75 can push the whole block
     * out of SC halos (not just the cluster centroid).
     */
    function estimateClusterShrinkwrap(cluster, centroidX, centroidY) {
        var n = (cluster.page_ids || []).length || 1;
        var nodeSpread = Math.sqrt(n) * 9;  // phyllotaxis outer radius
        var measured = labelDimsCache[cluster.name || ''];
        var labelW, labelH;
        if (measured) {
            labelW = measured.w;
            labelH = measured.h;
        } else {
            var lines = estimateLabelLines(cluster.name || '', LABEL_WRAP_CHARS);
            var maxLen = 0;
            lines.forEach(function (l) { if (l.length > maxLen) maxLen = l.length; });
            labelW = maxLen * LABEL_CHAR_WIDTH_ESTIMATE;
            labelH = lines.length * LABEL_LINE_HEIGHT_ESTIMATE;
        }
        var GAP = 8;  // matches LABEL_TO_CLUSTER_GAP in drawHulls
        // Nodes span [centroid - nodeSpread, centroid + nodeSpread].
        // Label sits above, bottom at (centroid.y - nodeSpread - GAP).
        var halfW = Math.max(nodeSpread, labelW / 2);
        return {
            minX: centroidX - halfW - SHRINKWRAP_PAD,
            maxX: centroidX + halfW + SHRINKWRAP_PAD,
            minY: centroidY - nodeSpread - GAP - labelH - SHRINKWRAP_PAD,
            maxY: centroidY + nodeSpread + SHRINKWRAP_PAD,
        };
    }

    /**
     * Composite AABB for a cluster = its member nodes ∪ its predicted
     * plain-label bbox + SHRINKWRAP_PAD on every side.
     *
     * Returns null if the cluster has no positioned members.
     *
     * Note: labels for SC-member clusters (pills) are placed outside
     * this bbox on the halo perimeter, so this helper should NOT be
     * used to predict pill locations — see pillShrinkwrap (forthcoming).
     */
    function computeClusterShrinkwrap(cluster, nodes) {
        var pageSet = {};
        cluster.page_ids.forEach(function (pid) { pageSet[pid] = true; });
        var members = nodes.filter(function (n) { return pageSet[n.id] && n.x != null; });
        if (members.length === 0) return null;

        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        members.forEach(function (n) {
            if (n.x - NODE_RADIUS < minX) minX = n.x - NODE_RADIUS;
            if (n.x + NODE_RADIUS > maxX) maxX = n.x + NODE_RADIUS;
            if (n.y - NODE_RADIUS < minY) minY = n.y - NODE_RADIUS;
            if (n.y + NODE_RADIUS > maxY) maxY = n.y + NODE_RADIUS;
        });

        // Predicted non-SC label anchor: centered x above cluster, one label-height above top
        var anchorX = (minX + maxX) / 2;
        var anchorY = minY - HULL_PADDING - 4 - (LABEL_LINE_HEIGHT_ESTIMATE / 2);
        var lbl = estimateLabelBBox(cluster.name, anchorX, anchorY);

        return {
            minX: Math.min(minX, lbl.minX) - SHRINKWRAP_PAD,
            maxX: Math.max(maxX, lbl.maxX) + SHRINKWRAP_PAD,
            minY: Math.min(minY, lbl.minY) - SHRINKWRAP_PAD,
            maxY: Math.max(maxY, lbl.maxY) + SHRINKWRAP_PAD,
        };
    }

    /**
     * Composite AABB for a super-cluster watermark = icon area (ICON_SIZE²)
     * ∪ SC name text below + SHRINKWRAP_PAD. This is the no-go zone the
     * projection illusion depends on — no label should ever overlap it.
     *
     * scCentroid: { x, y } — center the watermark is drawn on.
     */
    function computeWatermarkBBox(scKeyword, scCentroid) {
        var ICON_SIZE = 160;  // matches drawWatermarks
        // SC name text is rendered at font-size 30px (see theme.css
        // `.supercluster-label`) with dy: 1.15em per tspan line. The
        // previous computation used the 10px cluster-label line-height
        // estimate (12), which underestimated SC-name height by ~65%.
        // That pushed the computed bbox's maxY too far up, which in
        // turn pulled wmCenterY above the visible combined-bbox center
        // and made pill placement land "north" of the watermark group.
        var SC_NAME_FONT_SIZE = 30;
        var SC_NAME_LINE_HEIGHT = SC_NAME_FONT_SIZE * 1.15;  // ≈ 34.5
        // Char width in the SuperclusterLabel font is not Latin-aligned,
        // but at 30px ≈ 17 px/char gives a conservative width estimate.
        var SC_NAME_CHAR_WIDTH = 17;

        var nameText = (scKeyword || '').slice(0, 36);
        var lines = estimateLabelLines(nameText, 14);
        var nameH = lines.length * SC_NAME_LINE_HEIGHT;
        var nameMaxLen = 0;
        lines.forEach(function (l) { if (l.length > nameMaxLen) nameMaxLen = l.length; });
        var nameW = nameMaxLen * SC_NAME_CHAR_WIDTH;

        // Icon is drawn top-left at (cx - ICON_SIZE/2, cy - ICON_SIZE/2),
        // so icon bbox runs from (cx - half, cy - half) to (cx + half, cy + half).
        var halfIcon = ICON_SIZE / 2;
        // SC name text sits at y = ICON_SIZE + SC_LABEL_TOP_PAD below the
        // icon top (label uses dominant-baseline="hanging", so y = visual top).
        var nameTopY = scCentroid.y + halfIcon + SC_LABEL_TOP_PAD;
        var iconMinX = scCentroid.x - halfIcon;
        var iconMaxX = scCentroid.x + halfIcon;
        var nameMinX = scCentroid.x - nameW / 2;
        var nameMaxX = scCentroid.x + nameW / 2;

        return {
            minX: Math.min(iconMinX, nameMinX) - SHRINKWRAP_PAD,
            maxX: Math.max(iconMaxX, nameMaxX) + SHRINKWRAP_PAD,
            minY: scCentroid.y - halfIcon - SHRINKWRAP_PAD,
            maxY: nameTopY + nameH + SHRINKWRAP_PAD,
        };
    }

    /**
     * Is the given rect intersecting the given circle? If yes, returns
     * a unit push vector pointing the rect AWAY from the circle center
     * and the penetration distance. If not, returns { overlap: false }.
     *
     * Uses "closest point on rect to circle center" — handles all 9
     * voronoi regions of the rect perimeter correctly.
     */
    function rectCircleOverlap(rect, cx, cy, r) {
        var closestX = Math.max(rect.minX, Math.min(cx, rect.maxX));
        var closestY = Math.max(rect.minY, Math.min(cy, rect.maxY));
        var dx = closestX - cx;
        var dy = closestY - cy;
        var distSq = dx * dx + dy * dy;
        if (distSq >= r * r) return { overlap: false };

        var dist = Math.sqrt(distSq);
        var penetration = r - dist;
        if (dist < 1e-6) {
            // Rect center coincides with circle center — push along +x arbitrarily.
            return { overlap: true, nx: 1, ny: 0, penetration: r };
        }
        return {
            overlap: true,
            nx: dx / dist,  // points from circle center toward rect
            ny: dy / dist,
            penetration: penetration,
        };
    }

    /**
     * Are two AABBs overlapping (with optional padding)? If yes, returns
     * the push vector that separates them along the shortest axis.
     */
    function rectRectOverlap(a, b, pad) {
        var p = pad || 0;
        var ax = (a.minX + a.maxX) / 2, ay = (a.minY + a.maxY) / 2;
        var bx = (b.minX + b.maxX) / 2, by = (b.minY + b.maxY) / 2;
        var halfAw = (a.maxX - a.minX) / 2, halfAh = (a.maxY - a.minY) / 2;
        var halfBw = (b.maxX - b.minX) / 2, halfBh = (b.maxY - b.minY) / 2;
        var overlapX = (halfAw + halfBw + p) - Math.abs(ax - bx);
        var overlapY = (halfAh + halfBh + p) - Math.abs(ay - by);
        if (overlapX <= 0 || overlapY <= 0) return { overlap: false };
        return {
            overlap: true,
            overlapX: overlapX,
            overlapY: overlapY,
            dx: ax - bx,
            dy: ay - by,
        };
    }

    // ── Nebula background ───────────────────────────────────────────

    function nebulaOpacity() { return isDarkBg() ? 0.35 : 0.25; }

    /** Normalize a hex color to a fixed saturation/lightness, keeping hue.
     *
     * NOTE: This is the original HSL implementation. A CIE LCh variant was
     * tried (W6) and reverted because it converged ASTRONOMY/DATA SCIENCE
     * hues at the gamut-clamped chroma values. Tuning playground for
     * exploring alternatives lives at
     *   frontend/theme-tools/nebula_color_tuner.html
     * with HSL, CIE LCh, and Oklch options + live preview.
     */
    function nebulaColor(hex) {
        var r = parseInt(hex.slice(1, 3), 16) / 255;
        var g = parseInt(hex.slice(3, 5), 16) / 255;
        var b = parseInt(hex.slice(5, 7), 16) / 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h = 0;
        if (max !== min) {
            var d = max - min;
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) h = ((b - r) / d + 2) / 6;
            else h = ((r - g) / d + 4) / 6;
        }
        // Fixed S and L for uniform nebula intensity
        var s = isDarkBg() ? 0.5 : 0.6;
        var l = isDarkBg() ? 0.55 : 0.7;
        // HSL → RGB
        var c = (1 - Math.abs(2 * l - 1)) * s;
        var x = c * (1 - Math.abs((h * 6) % 2 - 1));
        var m = l - c / 2;
        var r1, g1, b1;
        if (h < 1/6)      { r1 = c; g1 = x; b1 = 0; }
        else if (h < 2/6) { r1 = x; g1 = c; b1 = 0; }
        else if (h < 3/6) { r1 = 0; g1 = c; b1 = x; }
        else if (h < 4/6) { r1 = 0; g1 = x; b1 = c; }
        else if (h < 5/6) { r1 = x; g1 = 0; b1 = c; }
        else               { r1 = c; g1 = 0; b1 = x; }
        var hx = function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); };
        return '#' + hx(r1) + hx(g1) + hx(b1);
    }

    /** Normalize a hex color for label readability — dark in light mode, light in dark. */
    function labelColor(hex) {
        var r = parseInt(hex.slice(1, 3), 16) / 255;
        var g = parseInt(hex.slice(3, 5), 16) / 255;
        var b = parseInt(hex.slice(5, 7), 16) / 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h = 0;
        if (max !== min) {
            var d = max - min;
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) h = ((b - r) / d + 2) / 6;
            else h = ((r - g) / d + 4) / 6;
        }
        var s = isDarkBg() ? 0.45 : 0.7;
        var l = isDarkBg() ? 0.8 : 0.25;
        var c = (1 - Math.abs(2 * l - 1)) * s;
        var x = c * (1 - Math.abs((h * 6) % 2 - 1));
        var m = l - c / 2;
        var r1, g1, b1;
        if (h < 1/6)      { r1 = c; g1 = x; b1 = 0; }
        else if (h < 2/6) { r1 = x; g1 = c; b1 = 0; }
        else if (h < 3/6) { r1 = 0; g1 = c; b1 = x; }
        else if (h < 4/6) { r1 = 0; g1 = x; b1 = c; }
        else if (h < 5/6) { r1 = x; g1 = 0; b1 = c; }
        else               { r1 = c; g1 = 0; b1 = x; }
        var hx = function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); };
        return '#' + hx(r1) + hx(g1) + hx(b1);
    }

    /** Deterministic pseudo-random from a seed (returns 0–1). */
    function seededRand(seed) {
        var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
        return x - Math.floor(x);
    }

    /** Hash a cluster ID string to a numeric seed. */
    function hashId(id) {
        var h = 0;
        for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    /** Mulberry32 PRNG — call mulberry32(seed) → returns a function that
     *  produces 0..1 with full 32-bit period. Used as the random source
     *  for d3.forceSimulation so layouts are deterministic across reloads
     *  (forceManyBody's tie-breaking jiggle calls Math.random by default,
     *  which was the actual source of "Big Cats lands NW one run, SSW the
     *  next" — not the radial anchor logic). Pass to a sim via
     *  ``.randomSource(mulberry32(seed))``. Picking the same seed on each
     *  load is what makes a layout reproducible. */
    function mulberry32(seed) {
        return function () {
            var t = seed += 0x6d2b79f5;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Generate a smooth closed blob path with organic random edges.
     *
     * opts.points     — perimeter sample count (default 12). More points
     *                   = finer-grained irregularity.
     * opts.jitter     — radial jitter half-amplitude as fraction of radius
     *                   (default 0.3 → range [0.7, 1.3]). Higher = lumpier.
     * opts.angularJitter
     *                 — TANGENTIAL displacement (in radians) applied to
     *                   each perimeter point. Breaks the rotational
     *                   quasi-symmetry that pure radial jitter has.
     *                   With angularJitter > 0, sample points cluster
     *                   in some arcs and sparse out in others, so the
     *                   curve has uneven wavelength — reads as ASYMMETRIC
     *                   organic, not "fluffy circle". Default 0.
     * opts.curve      — d3 curve interpolator (default curveBasisClosed).
     */
    function blobPath(cx, cy, radius, seed, opts) {
        opts = opts || {};
        var N = opts.points || 12;
        var jitterAmp = opts.jitter !== undefined ? opts.jitter : 0.3;
        var angJitter = opts.angularJitter || 0;
        var curve = opts.curve || d3.curveBasisClosed;
        var pts = [];
        for (var i = 0; i < N; i++) {
            var baseAngle = (i / N) * Math.PI * 2;
            // Tangential offset: ±angJitter radians, deterministic from seed
            var angOff = angJitter > 0
                ? (seededRand(seed + i * 313) - 0.5) * 2 * angJitter
                : 0;
            var angle = baseAngle + angOff;
            var j = (1 - jitterAmp) + (2 * jitterAmp) * seededRand(seed + i * 137);
            var r = radius * j;
            pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
        }
        return d3.line().curve(curve)(pts);
    }

    /** Max distance from a cluster's centroid to any of its own laid-out
     *  member nodes. `nodes` is passed explicitly (not closed over) so
     *  this is callable from any context that has a node array in hand --
     *  computeNebulaData AND fitToContent both do. */
    function clusterNodeMaxDist(cluster, cen, nodes) {
        var pageSet = {};
        (cluster.page_ids || []).forEach(function (pid) { pageSet[pid] = true; });
        var maxDist = 0;
        nodes.forEach(function (n) {
            if (pageSet[n.id] && n.x != null) {
                var dx = n.x - cen.x, dy = n.y - cen.y;
                var dd = Math.sqrt(dx * dx + dy * dy);
                if (dd > maxDist) maxDist = dd;
            }
        });
        return maxDist;
    }

    /** Shared per-cluster nebula radius formula -- the SAME formula
     *  computeNebulaData's Layer-1 blobs use to draw the actual fog, and
     *  the one fitToContent's fog-aware fit padding reads (see
     *  NEBULA_FIT_CORE) so the two can never drift apart. SC-member
     *  clusters get the larger SC_MEMBER_NEBULA_MIN_RADIUS floor -- see
     *  the Layer-1 comment below for why. */
    function clusterNebulaRadius(cluster, cen, nodes) {
        var maxDist = clusterNodeMaxDist(cluster, cen, nodes);
        var minR = isSuperClusterLike(cluster) ? SC_MEMBER_NEBULA_MIN_RADIUS : NEBULA_MIN_RADIUS;
        return Math.max(maxDist * NEBULA_RADIUS_MULT, minR);
    }

    /** Shared per-SC Layer-2 overlay geometry: the weighted centroid (mean
     *  of member-cluster centroids) and maxReach (the farthest any member's
     *  own fog reach extends from that centroid, floored at
     *  NEBULA_MIN_RADIUS). Same sharing contract as clusterNebulaRadius --
     *  computeNebulaData's Layer-2 overlay (core blob 0.5x, satellites
     *  scattered to 0.95x + their own radii) sizes itself from this, and
     *  fitToContent's fog-aware fit padding unions the same footprint
     *  (scaled by NEBULA_FIT_CORE), so the two can never drift apart.
     *  Note the per-member reach term deliberately uses the plain
     *  NEBULA_MIN_RADIUS floor, NOT clusterNebulaRadius's SC-member 380px
     *  floor -- that asymmetry is the pre-existing overlay formula, kept
     *  byte-identical here. Returns null when no member has a centroid. */
    function scOverlayGeometry(members, centroids, nodes) {
        var wcx = 0, wcy = 0, wcn = 0;
        members.forEach(function (m) {
            var cen = centroids[m.id];
            if (cen) { wcx += cen.x; wcy += cen.y; wcn++; }
        });
        if (wcn === 0) return null;
        wcx /= wcn; wcy /= wcn;

        var maxReach = NEBULA_MIN_RADIUS;
        members.forEach(function (m) {
            var cen = centroids[m.id];
            if (!cen) return;
            var offset = Math.sqrt(
                (cen.x - wcx) * (cen.x - wcx) + (cen.y - wcy) * (cen.y - wcy)
            );
            var maxND = clusterNodeMaxDist(m, cen, nodes);
            var reach = offset + Math.max(maxND * NEBULA_RADIUS_MULT, NEBULA_MIN_RADIUS);
            if (reach > maxReach) maxReach = reach;
        });
        return { cx: wcx, cy: wcy, maxReach: maxReach };
    }

    function computeNebulaData(clusters, nodes) {
        var centroids = computeClusterCentroids(clusters, nodes);

        // Partition clusters: SC members roll up into one blob per SC;
        // non-SC clusters keep their own individual nebula (per bullet 3).
        var scGroups = {};
        var nonSCClusters = [];
        clusters.forEach(function (c) {
            if (c.super_cluster) {
                if (!scGroups[c.super_cluster]) scGroups[c.super_cluster] = [];
                scGroups[c.super_cluster].push(c);
            } else {
                nonSCClusters.push(c);
            }
        });

        var entries = [];

        // Layer 1 — PER-CLUSTER blobs for EVERY cluster (SC members too).
        // These provide the organic, blending "galaxy" look: many small
        // overlapping gradients in varied hues.
        //
        // SC-member clusters use a MUCH larger minimum radius than non-SC
        // clusters. The large radii ensure member nebulae within an SC
        // overlap each other and extend to the SC halo boundary, so no
        // dark "negative halo" appears between per-member blobs and the
        // SC overlay. Screen blend means overlap brightens harmonically
        // rather than muddying.
        clusters.forEach(function (c) {
            var cen = centroids[c.id];
            if (!cen) return;
            // Unclustered gets the same "big organic base blob" treatment as
            // real SC members so the subsequent SC-style overlay on top has
            // a warm substrate to blend with (otherwise the overlay reads as
            // floating satellites with nothing underneath).
            var isSCMember = isSuperClusterLike(c);
            entries.push({
                gradId: 'c-' + c.id,
                clusterId: c.id,
                memberIds: [c.id],
                cx: cen.x,
                cy: cen.y,
                radius: clusterNebulaRadius(c, cen, nodes),
                seed: hashId(c.id),
                isSCOverlay: false,
                isSCMember: isSCMember,
            });
        });

        // Layer 2 — PER-SC overlay gradient on top at reduced opacity.
        // Reinforces SC grouping without replacing the per-cluster variety.
        // Geometry (weighted centroid + maxReach) comes from the shared
        // scOverlayGeometry helper so fitToContent's fog-aware padding can
        // union the identical footprint.
        Object.keys(scGroups).forEach(function (keyword) {
            var members = scGroups[keyword];
            var geo = scOverlayGeometry(members, centroids, nodes);
            if (!geo) return;
            var wcx = geo.cx, wcy = geo.cy, maxReach = geo.maxReach;

            var memberIds = members.map(function (m) { return m.id; });
            // Multi-source SC overlay: instead of ONE big circular blob
            // (which always reads as "circle with bumps" no matter how
            // perimeter-jittered), emit N satellites scattered within the
            // SC region. Their union via screen-blend creates an
            // ASYMMETRIC organic silhouette — same emergent-from-many-
            // small-pieces shape that the graph as a whole has.
            // Outer-ring scatter: satellites push toward 70-90% of maxReach
            // so they form visible lobes around the SC perimeter, not a
            // tight cluster of overlapping inner blobs (which would just
            // re-form the original "circle with bumps" shape).
            var SC_SATELLITE_INNER = 0.7;
            var SC_SATELLITE_OUTER = 0.95;
            var SC_SATELLITE_MIN = 0.3;
            var SC_SATELLITE_MAX = 0.5;
            var safeKw = keyword.replace(/[^a-zA-Z0-9_-]/g, '_');

            // Also keep ONE central anchor blob so the SC center isn't dim.
            entries.push({
                gradId: 'sc-' + safeKw + '-core',
                clusterId: memberIds[0],
                memberIds: memberIds,
                scKeyword: keyword,
                cx: wcx, cy: wcy,
                radius: maxReach * 0.5,
                seed: hashId(keyword + ':core'),
                isSCOverlay: true,
            });

            for (var sk = 0; sk < SC_SATELLITE_COUNT; sk++) {
                var satSeed = hashId(keyword + ':sat' + sk);
                var satAngle = seededRand(satSeed) * Math.PI * 2;
                // Position near SC perimeter (between INNER and OUTER fractions)
                var satDistFrac = SC_SATELLITE_INNER +
                    (SC_SATELLITE_OUTER - SC_SATELLITE_INNER) * seededRand(satSeed + 11);
                var satDist = satDistFrac * maxReach;
                var satCx = wcx + Math.cos(satAngle) * satDist;
                var satCy = wcy + Math.sin(satAngle) * satDist;
                var satRadiusFactor = SC_SATELLITE_MIN +
                    (SC_SATELLITE_MAX - SC_SATELLITE_MIN) * seededRand(satSeed + 23);
                entries.push({
                    gradId: 'sc-' + safeKw + '-sat' + sk,
                    clusterId: memberIds[0],
                    memberIds: memberIds,
                    scKeyword: keyword,
                    cx: satCx,
                    cy: satCy,
                    radius: maxReach * satRadiusFactor,
                    seed: satSeed,
                    isSCOverlay: true,
                });
            }
        });

        // Layer 2b — SC-STYLE overlay for the synthetic _unclustered bucket,
        // so the noise blob reads as a cohesive nebula instead of a flat
        // disc. Mirrors the SC overlay emission above (core + satellite
        // scatter) but sourced from a single cluster's nodes. Only emits
        // if the unclustered cluster is actually present in this render
        // (it's filtered out when the noise toggle is off).
        var unClust = null;
        for (var uc = 0; uc < clusters.length; uc++) {
            if (clusters[uc].id === '_unclustered') { unClust = clusters[uc]; break; }
        }
        if (unClust) {
            var ucCen = centroids['_unclustered'];
            if (ucCen) {
                var ucMaxND = clusterNodeMaxDist(unClust, ucCen, nodes);
                var ucReach = Math.max(ucMaxND * NEBULA_RADIUS_MULT, NEBULA_MIN_RADIUS);

                // Single core overlay at the centroid — no satellites.
                // Real super-clusters scatter SC_SATELLITE_COUNT satellites
                // around their multi-cluster region; _unclustered is a single compact
                // cluster, so satellites placed via the SC formula
                // (0.7–0.95 × NEBULA_MIN_RADIUS from centroid) float in
                // empty canvas space when the actual node span is smaller
                // than the 200px floor, producing phantom halos. Keeping
                // just the core blob gives the unclustered nebula a
                // warmer/denser look consistent with SC overlays without
                // risking orphan lobes. This branch is unclustered-only
                // and cannot affect real super-cluster rendering.
                entries.push({
                    gradId: 'sc-_unclustered-core',
                    clusterId: '_unclustered',
                    memberIds: ['_unclustered'],
                    scKeyword: '_unclustered',
                    cx: ucCen.x,
                    cy: ucCen.y,
                    radius: ucReach * 0.5,
                    seed: hashId('_unclustered:core'),
                    isSCOverlay: true,
                });
            }
        }

        return entries;
    }

    // Collapsed-group knots (audit V4, the deferred C1 "visual boost"):
    // one compact, denser blob per collapsed casual/binge mass so the ring
    // of dots reads as an object — "42 pages you binged" — instead of
    // stray dots on bright background (design audit §2.3). Entries ride
    // the normal nebula pipeline (same gradient prefix, same
    // path.nebula-cloud class) so theme recolor and hover dimming apply
    // unchanged; isKnot only switches the gradient to a tighter, brighter
    // profile. Colored by the dominant (most pages) member cluster.
    function computeCollapsedKnotData(clusters, nodes) {
        var groups = {};
        clusters.forEach(function (c) {
            if (!isCollapsedCluster(c)) return;
            var n = (c.page_ids || []).length;
            if (!groups[c.group_id]) {
                groups[c.group_id] = {
                    // Rethink R4.3: keep the type-preserved group_id (an
                    // integer from the payload) alongside the bucket --
                    // Object.keys(groups) below only yields stringified
                    // keys, and groupWorldBBox's `c.group_id === groupId`
                    // is a strict comparison, so a stringified id would
                    // silently never match and the knot click would toggle
                    // + re-render but never frame.
                    groupId: c.group_id,
                    domCluster: c.id, domPages: n, pageIds: [],
                    // Rethink R2.5: group label/topic-count carried through
                    // to the knot-hit hover card (same fields drawGroupLabels
                    // uses for its caption card).
                    label: c.group_label || 'group', memberCount: 0,
                };
            }
            var g = groups[c.group_id];
            if (n > g.domPages) { g.domPages = n; g.domCluster = c.id; }
            (c.page_ids || []).forEach(function (pid) { g.pageIds.push(pid); });
            g.memberCount++;
        });
        var nodePos = {};
        nodes.forEach(function (n) { if (n.x != null) nodePos[n.id] = n; });
        var out = [];
        Object.keys(groups).forEach(function (gid) {
            var g = groups[gid];
            var xs = 0, ys = 0, cnt = 0;
            g.pageIds.forEach(function (pid) {
                var n = nodePos[pid];
                if (n) { xs += n.x; ys += n.y; cnt++; }
            });
            if (!cnt) return;
            var cx = xs / cnt, cy = ys / cnt;
            var maxD = 0;
            g.pageIds.forEach(function (pid) {
                var n = nodePos[pid];
                if (!n) return;
                var d = Math.hypot(n.x - cx, n.y - cy);
                if (d > maxD) maxD = d;
            });
            out.push({
                gradId: 'knot-' + gid,
                clusterId: g.domCluster,
                cx: cx, cy: cy,
                radius: Math.max(maxD * 1.45, 60),
                seed: (parseInt(gid, 10) || 0) % 977 + 7,
                isKnot: true,
                // Rethink R2.5: knot-hit hover-card fields. groupId is
                // g.groupId (the type-preserved original), NOT the
                // stringified `gid` loop key -- see the comment above.
                groupId: g.groupId,
                groupLabel: g.label,
                groupTopics: g.memberCount,
                groupPages: g.pageIds.length,
            });
        });
        return out;
    }

    function drawNebula(root, clusters, nodes) {
        // S2 sandbox-bar gate (header comment delta #8).
        if (!SANDBOX_SECTION_GATES.nebula) return;
        var nebulaData = computeNebulaData(clusters, nodes);
        // Knots go last in array order → painted on top of member blobs.
        // S2 fix-round-1 (review finding 1): SANDBOX_SECTION_GATES.knot is
        // now independently checked here -- previously it was declared but
        // never read, so knots rode `nebula`'s gate unconditionally.
        // Still nested inside drawNebula (no independent call site exists
        // to gate on its own), but nebula:true + knot:false now suppresses
        // just the knot push, not the whole cloud.
        if (SANDBOX_SECTION_GATES.knot) {
            computeCollapsedKnotData(clusters, nodes).forEach(function (k) {
                nebulaData.push(k);
            });
        }
        var defs = svg.select('defs');
        var baseOpacity = nebulaOpacity();
        // SC overlay is rendered on top at reduced opacity so it reinforces
        // the SC grouping without flattening the per-cluster variety below.
        // (SC_OVERLAY_OPACITY_FACTOR is module-scoped — see rethink R1.3.)

        // Ensure any previously-rendered ambient layer from the W4
        // approach is cleaned up (helps after a code reload mid-session).
        defs.selectAll('radialGradient#nebula-ambient-grad').remove();
        root.select('.nebula').selectAll('circle.nebula-ambient').remove();

        // Create radial gradients (userSpaceOnUse for absolute positioning)
        defs.selectAll('radialGradient[id^="nebula-grad-"]').remove();
        nebulaData.forEach(function (d) {
            var gradOpacity = d.isSCOverlay
                ? baseOpacity * SC_OVERLAY_OPACITY_FACTOR
                : baseOpacity;
            var grad = defs.append('radialGradient')
                .attr('id', 'nebula-grad-' + d.gradId)
                // Tag with color-lookup key AND whether this is an SC overlay,
                // so updateNebulaColors() can re-color on theme change without
                // parsing the compound gradient id.
                .attr('data-cluster-id', d.clusterId)
                .attr('data-sc-overlay', d.isSCOverlay ? '1' : '0')
                .attr('gradientUnits', 'userSpaceOnUse')
                .attr('cx', d.cx).attr('cy', d.cy).attr('r', d.radius);
            var color = nebulaColor(clusterColor(d.clusterId));
            if (d.isKnot) {
                // Tighter, brighter profile than regular clouds: a dense
                // core with a fast edge so the collapsed mass has a
                // silhouette rather than a wide haze.
                grad.append('stop').attr('offset', '0%')
                    .attr('stop-color', color)
                    .attr('stop-opacity', Math.min(0.85, gradOpacity * 1.7));
                grad.append('stop').attr('offset', '45%')
                    .attr('stop-color', color)
                    .attr('stop-opacity', Math.min(0.6, gradOpacity * 1.2));
                grad.append('stop').attr('offset', '75%')
                    .attr('stop-color', color)
                    .attr('stop-opacity', gradOpacity * 0.5);
                grad.append('stop').attr('offset', '100%')
                    .attr('stop-color', color).attr('stop-opacity', 0);
                return;
            }
            grad.append('stop').attr('offset', '0%')
                .attr('stop-color', color)
                .attr('stop-opacity', Math.min(0.55, gradOpacity * 1.25));
            grad.append('stop').attr('offset', '25%')
                .attr('stop-color', color).attr('stop-opacity', gradOpacity * 0.7);
            grad.append('stop').attr('offset', '50%')
                .attr('stop-color', color).attr('stop-opacity', gradOpacity * 0.35);
            grad.append('stop').attr('offset', '75%')
                .attr('stop-color', color).attr('stop-opacity', gradOpacity * 0.1);
            grad.append('stop').attr('offset', '100%')
                .attr('stop-color', color).attr('stop-opacity', 0);
        });

        // Draw blob paths in the nebula layer. Entries render in array order;
        // per-cluster (Layer 1) entries are pushed first so they paint below
        // per-SC overlays (Layer 2).
        // ALL nebulae now use the organic options (more points, higher jitter,
        // Catmull-Rom interpolation) so each visible blob contributes
        // irregularity to the overall silhouette. SC overlays get slightly
        // more aggressive params since they're large and need to read as
        // distinctly non-circular at the macro scale.
        // SC blobs get angularJitter so each satellite individually has
        // non-uniform-arc perimeter, AND there are SC_SATELLITE_COUNT
        // satellites scattered within the SC region so their union forms an
        // asymmetric organic silhouette (no longer "circle with bumps", but
        // a free-form blob).
        // Per-cluster blobs use gentler radial-only jitter to stay smooth.
        var ORGANIC_BLOB_OPTS = {
            points: 32,
            jitter: 0.18,
            curve: d3.curveBasisClosed,
        };
        var SC_BLOB_OPTS = {
            points: 24,
            jitter: 0.32,
            angularJitter: 0.4,  // ±0.4 rad ≈ ±23° per-point tangential offset
            curve: d3.curveBasisClosed,
        };
        var layer = root.select('.nebula');
        layer.selectAll('path.nebula-cloud').remove();
        layer.selectAll('path.nebula-cloud')
            .data(nebulaData, function (d) { return d.gradId; })
            .enter().append('path')
            .attr('class', 'nebula-cloud')
            .attr('d', function (d) {
                // SC-related blobs (overlay + member per-cluster) get organic
                // params. Non-SC per-cluster blobs keep the default smoother
                // shape so they don't read as too angular at small radii.
                var opts;
                if (d.isSCOverlay) opts = SC_BLOB_OPTS;
                else if (d.isSCMember || d.isKnot) opts = ORGANIC_BLOB_OPTS;
                return blobPath(d.cx, d.cy, d.radius, d.seed, opts);
            })
            .attr('fill', function (d) { return 'url(#nebula-grad-' + d.gradId + ')'; })
            .attr('pointer-events', 'none')
            // Additive-style blend: overlapping nebulae combine brighter
            // instead of overwriting, which eliminates the dark "moats"
            // between per-cluster blobs and SC overlay within an SC halo.
            // 'screen' is non-linear (brightness-capped at white) so it
            // avoids the harsh over-exposure of plus-lighter on a dark bg.
            .style('mix-blend-mode', 'screen');

        // Rethink R2.5: collapsed-group knots become hit-targets. The
        // painted nebula path above is pointer-events:none (it's a visual
        // blend layer), so an invisible circle sized to half the knot's
        // radius carries hover (group card) and click (expand) — half-size
        // keeps the hit area inside the knot's dense core, not its diffuse
        // fringe, so it doesn't steal hover from neighboring content.
        // Lives in the '.knot-hits' layer (painted after '.nodes'), not
        // this function's own '.nebula' layer var — see the layer-creation
        // comment for why.
        var knotLayer = root.select('.knot-hits');
        knotLayer.selectAll('circle.knot-hit').remove();
        knotLayer.selectAll('circle.knot-hit')
            .data(nebulaData.filter(function (d) { return d.isKnot; }))
            .enter().append('circle')
            .attr('class', 'knot-hit')
            .attr('cx', function (d) { return d.cx; })
            .attr('cy', function (d) { return d.cy; })
            .attr('r', function (d) { return d.radius * 0.5; })
            .attr('fill', 'transparent')
            .attr('cursor', 'pointer')
            .on('mouseenter', function (event, d) {
                showLinesTooltip(event, [d.groupLabel,
                    d.groupTopics + ' topics · ' + d.groupPages + 'p']);
            })
            .on('mouseleave', hideTooltip)
            .on('click', function (event, d) {
                event.stopPropagation();
                toggleGroupExpansion(d.groupId, !expandedGroups[d.groupId]);
            });
    }

    function updateNebulaColors() {
        if (!svg) return;
        var baseOpacity = nebulaOpacity();
        var mult = [1, 0.7, 0.35, 0.1, 0];
        svg.select('defs').selectAll('radialGradient[id^="nebula-grad-"]').each(function () {
            var sel = d3.select(this);
            var cid = sel.attr('data-cluster-id') ||
                      sel.attr('id').replace('nebula-grad-', '');
            var isOverlay = sel.attr('data-sc-overlay') === '1';
            var opacity = isOverlay
                ? baseOpacity * SC_OVERLAY_OPACITY_FACTOR
                : baseOpacity;
            var color = nebulaColor(clusterColor(cid));
            sel.selectAll('stop').each(function (_, i) {
                d3.select(this).attr('stop-color', color)
                    .attr('stop-opacity', opacity * (mult[i] || 0));
            });
        });
    }

    // ── Super-cluster watermark icons ─────────────────────────────────

    /**
     * Wrap a short topic name into lines for rendering under a super-cluster
     * watermark. Greedy word-packing: fill each line until the next word would
     * exceed perLineBudget, then start a new line. A single word longer than
     * the budget stays on its own line intact (no mid-word splitting). No
     * ellipsis or line-count cap — the 36-char input cap upstream prevents
     * pathological overflow, so real topic names land in ≤3 lines naturally.
     *
     * @param {string} text           topic name, already ≤ 36 chars
     * @param {number} perLineBudget  soft char budget per line — 14 fits MilkyWay at 20px
     * @returns {string[]}            one line per array entry
     */
    function wrapLabelLines(text, perLineBudget) {
        if (perLineBudget == null) perLineBudget = 14;
        var words = text.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        var lines = [];
        var current = words[0];
        for (var i = 1; i < words.length; i++) {
            var candidate = current + ' ' + words[i];
            if (candidate.length <= perLineBudget) {
                current = candidate;
            } else {
                lines.push(current);
                current = words[i];
            }
        }
        lines.push(current);
        return lines;
    }

    function drawWatermarks(root, clusters) {
        if (!SANDBOX_SECTION_GATES.watermark) return;  // S2 sandbox-bar gate (header comment delta #8)
        var layer = root.select('.watermarks');
        layer.selectAll('*').remove();

        if (!__mountedIcons) return;  // was window.__superClusterIcons (header comment delta #5)
        var superClusters = currentData && currentData.super_clusters || [];
        if (!superClusters.length) return;

        // Group clusters by super_cluster
        var groups = {};
        clusters.forEach(function (c) {
            if (c.super_cluster) {
                if (!groups[c.super_cluster]) groups[c.super_cluster] = [];
                groups[c.super_cluster].push(c);
            }
        });

        var centroids = computeClusterCentroids(clusters, currentData.nodes || []);
        lastClusterCentroids = centroids;

        for (var keyword in groups) {
            var memberClusters = groups[keyword];
            var sc = superClusters.find(function (s) { return s.keyword === keyword; });
            if (!sc || !sc.icon_id) continue;
            var icon = __mountedIcons[sc.icon_id];  // was window.__superClusterIcons (header comment delta #5)
            if (!icon) continue;

            // Compute super-cluster centroid (average of member cluster centroids)
            var wcx = 0, wcy = 0, wcn = 0;
            memberClusters.forEach(function (mc) {
                var cen = centroids[mc.id];
                if (cen) { wcx += cen.x; wcy += cen.y; wcn++; }
            });
            if (wcn === 0) continue;
            wcx /= wcn; wcy /= wcn;

            var color = nebulaColor(clusterColorMap[memberClusters[0].id] || fallbackColor());

            // Apply tuner-driven scaling (clamped per SCALE_THRESHOLDS)
            // using the most-recent zoom k. SC name uses its own scale,
            // independent of the icon, so they tune separately.
            var iconScale = clampedScale(currentZoomK, 'scIcon');
            var nameScale = clampedScale(currentZoomK, 'scName');
            var ICON_SIZE = BASE_SC_ICON_SIZE * iconScale;
            var nameFontSize = BASE_SC_NAME_FONT_SIZE * nameScale;

            // Parse viewBox for scaling
            var vbParts = (icon.viewBox || '0 0 24 24').split(' ');
            var vbW = parseFloat(vbParts[2]) || 24;
            var scaleFactor = ICON_SIZE / vbW;

            // Zoom ratio (current / fit) shared by the icon fade (R6.1) and
            // the SC-name fade below -- both LOD gates key off the same
            // "how deep into the galaxy are you" measure, just in opposite
            // directions (icon fades OUT on zoom-IN, name fades IN on
            // zoom-OUT).
            var nameRatio = (fitZoom > 0) ? (currentZoomK / fitZoom) : 1;

            // Rethink R6.1: past ICON_LOD_FADE_START you're inside the
            // galaxy -- the big icon fades out and the nameplate hands off
            // to an edge chip (updateEdgeChips) for wayfinding.
            var iconOpacity;
            if (nameRatio <= ICON_LOD_FADE_START) iconOpacity = 1;
            else if (nameRatio >= ICON_LOD_FADE_END) iconOpacity = 0;
            else iconOpacity = 1 - (nameRatio - ICON_LOD_FADE_START) / (ICON_LOD_FADE_END - ICON_LOD_FADE_START);

            var totalPages = 0;
            memberClusters.forEach(function (mc) { totalPages += (mc.page_ids || []).length; });

            var g = layer.append('g')
                .attr('class', 'watermark')
                // data-sc lets the cluster-label hover handler find which
                // watermark belongs to the hovered cluster's super-cluster
                // and keep that one full opacity while dimming siblings.
                .attr('data-sc', keyword)
                // data-pages backs the nameplate deconfliction pass below --
                // bigger SCs (more member pages) hold their anchored spot,
                // smaller ones nudge out of the way.
                .attr('data-pages', totalPages)
                .attr('transform', 'translate(' + (wcx - ICON_SIZE / 2) + ',' + (wcy - ICON_SIZE / 2) + ')')
                // Rethink R2.5: SC hover card. 'bounding-box' (not the
                // default) so the whole icon+label footprint is a hit
                // target, not just the painted stroke pixels. R6.1: once the
                // icon has fully faded (deep zoom, handed off to edge
                // chips), disable the hit target -- an invisible hover/click
                // catcher sitting over unrelated content is a bug.
                .style('pointer-events', iconOpacity > 0.05 ? 'bounding-box' : 'none')
                .attr('cursor', 'pointer')
                .on('mouseenter', (function (kw, members) {
                    return function (event) {
                        var pages = 0;
                        members.forEach(function (mc) { pages += (mc.page_ids || []).length; });
                        showLinesTooltip(event, [kw, members.length + ' topics · ' + pages + ' pages']);
                    };
                })(keyword, memberClusters))
                .on('mouseleave', hideTooltip)
                // Rethink R4.4: nameplate click frames the SC -- same
                // maxRatio/minRatio band the background-click walk-up
                // (svg.on('click', ...)) already uses when a selected
                // cluster's parent SC gets framed.
                .on('click', (function (kw) {
                    return function (event) {
                        event.stopPropagation();
                        frameWorldBBox(scWorldBBox(kw), { maxRatio: 1.2, minRatio: 0.6 });
                    };
                })(keyword));

            // Stroke is set via CSS (.watermark path { stroke: var(--ink) })
            // so the icon's color flips to dark on light themes and stays
            // white on dark themes -- was hardcoded #ffffff which became
            // invisible on light backgrounds.
            icon.paths.forEach(function (pathData) {
                g.append('path')
                    .attr('d', pathData)
                    .attr('fill', 'none')
                    .attr('stroke-width', 1.1)
                    .attr('stroke-linecap', 'round')
                    .attr('stroke-linejoin', 'round')
                    .attr('opacity', iconOpacity)
                    // Once the fade has effectively completed, drop the path
                    // out of bbox/hit-testing entirely -- display:none
                    // excludes it from getBBox(), unlike a bare opacity:0.
                    // Without this, the parent g's measured footprint
                    // (screenBBoxOf -- used by the R6 nameplate-deconfliction
                    // pass and collectObstacleRects, and by the design-verify
                    // overlap harness) keeps reserving the old icon-band
                    // screen real estate for an icon that's no longer
                    // painted there, so other labels get needlessly denied
                    // that space (R6.1).
                    .style('display', iconOpacity > 0.05 ? null : 'none')
                    .attr('transform', 'scale(' + scaleFactor + ')');
            });

            // ── Label under the watermark ─────────────────────────────
            // LOD: fade out at zoom ratios below SC_NAME_LOD_K_MIN so the
            // galaxy-overview view shows only the watermark icon. fade-in
            // band spans SC_NAME_LOD_FADE_RANGE above the threshold.
            var nameOpacity;
            if (nameRatio >= SC_NAME_LOD_K_MIN + SC_NAME_LOD_FADE_RANGE) nameOpacity = 1;
            else if (nameRatio <= SC_NAME_LOD_K_MIN) nameOpacity = 0;
            else nameOpacity = (nameRatio - SC_NAME_LOD_K_MIN) / SC_NAME_LOD_FADE_RANGE;

            var rawName = sc.keyword || '';
            if (rawName) {
                var displayName = rawName.length > 36
                    ? rawName.slice(0, 36)
                    : rawName;
                var lines = wrapLabelLines(displayName, 14);

                var labelEl = g.append('text')
                    .attr('class', 'supercluster-label')
                    .attr('x', ICON_SIZE / 2)
                    .attr('y', ICON_SIZE + SC_LABEL_TOP_PAD * iconScale)
                    // Pad scales with the icon's clamp factor so the
                    // icon->name gap stays screen-stable like the icon
                    // itself (R3.2: band growth must track scIcon k_max).
                    // dominant-baseline="hanging" anchors y at the visual top
                    // of the glyph rather than the baseline, so the padding
                    // between icon bottom and label top stays exactly
                    // SC_LABEL_TOP_PAD * iconScale at any font size.
                    .attr('dominant-baseline', 'hanging')
                    // Use .style() not .attr() — inline style overrides the
                    // theme.css `.supercluster-label { font-size: 30px }`
                    // rule; SVG presentation attributes do not.
                    .style('font-size', nameFontSize + 'px')
                    .style('opacity', nameOpacity);

                lines.forEach(function (line, i) {
                    labelEl.append('tspan')
                        .attr('x', ICON_SIZE / 2)
                        .attr('dy', i === 0 ? 0 : '1.15em')
                        .text(line);
                });
            }
        }

        // Empty superclusters (allocated keywords with no member clusters)
        // are no longer painted on the canvas. The old dimmed-dashed row
        // above the nebula read as map territories with nothing under them
        // ("SCIENCE"/"ASTRONOMY" ghost titles — design audit §4.3); the
        // SUPERCLUSTERS header card already represents empty slots as
        // tiles, which is where allocation state belongs.

        // ── R6 scope addition: nameplate-vs-nameplate deconfliction ──────
        // Nameplates are uncullable but placeable (R3.1 priority list). At
        // crowded zooms two SC icon+name footprints can land close enough
        // to overlap each other -- icon-on-icon, name-on-name, or (worst)
        // a foreign SC's name landing under this SC's icon. Sort by member
        // page count descending so the biggest SC keeps its anchored spot,
        // then nudge each smaller nameplate off whatever's already been
        // placed, along whichever axis has the LEAST overlap (min-penetration
        // separation) rather than always pushing down. Down-only resolution
        // made displacement discontinuous in zoom: the screen-constant name
        // text (scName k_min 1.00) grows the world footprint as zoom shrinks,
        // so two side-by-side nameplates first make contact HORIZONTALLY --
        // at that instant their vertical intervals are already deeply
        // overlapping, so a down-only push jumped from 0 to nearly a full
        // plate height in a single zoom tick. Resolving along the shallowest
        // axis instead means the nudge at overlap onset is ~0 on the contact
        // axis and grows continuously from there as zoom continues to
        // shrink -- no jump. Idempotent by construction: every g.watermark
        // above was just torn down and rebuilt from its true centroid (wcx,
        // wcy) this call -- so this pass always starts from the anchored
        // position, never a previously-nudged one (mirrors how
        // positionGroupCaptions rebuilds y from data-group-min-y before its
        // own slide).
        //
        // Convergence: pure greedy min-axis resolution can 2-cycle in a
        // 3-body squeeze -- one plate pinched horizontally between two
        // neighbors gets pushed left off A, which re-opens the overlap
        // with B, whose resolution pushes it right back into A, forever
        // (an exact float-level cycle; the guard cap then freezes it
        // mid-cycle with a residual overlap and a parity-dependent
        // position). A genuine two-sided pinch has NO continuous escape:
        // while the pinch is open the minimal displacement is ~0, and the
        // moment the gap closes the minimal non-overlapping displacement
        // jumps to roughly the full perpendicular overlap -- so any scheme
        // that keeps sliding along the contact axis (direction-locking,
        // axis-switching, relaxation) either jumps anyway or tunnels
        // across a neighbor's plate. Fix: cycle detection with a monotone
        // fallback. Per entry, remember which placed plates it has already
        // been pushed off (resolvedAgainst); colliding with the SAME plate
        // a second time proves a cycle, and from then on every remaining
        // collision for THIS entry resolves with the legacy down-only push
        // (dDown), which increases ty monotonically and therefore provably
        // terminates against a finite placed set. Entries that never cycle
        // keep pure min-axis behavior -- the common case stays continuous;
        // the pinched case trades an unavoidable one-tick hop at pinch
        // closure for guaranteed convergence: no frozen overlaps, and a
        // deterministic output independent of float parity.
        var wmEntries = [];
        layer.selectAll('g.watermark').each(function () {
            wmEntries.push({ el: this, pages: +this.getAttribute('data-pages') || 0 });
        });
        wmEntries.sort(function (a, b) { return b.pages - a.pages; });
        var WM_PAD = 2;
        var wmPlaced = [];
        wmEntries.forEach(function (e) {
            var r = screenBBoxOf(e.el);
            if (!r) return;
            var guard = 0, moved = true;
            // Cycle detection (see comment block above): which placed
            // indices this entry has already been pushed off, and whether
            // a repeat collision has demoted it to down-only resolution.
            var resolvedAgainst = {};
            var fallbackDown = false;
            while (moved && guard++ < 8) {
                moved = false;
                for (var i = 0; i < wmPlaced.length; i++) {
                    var p = wmPlaced[i];
                    if (r.left < p.right + WM_PAD && p.left < r.right + WM_PAD &&
                        r.top < p.bottom + WM_PAD && p.top < r.bottom + WM_PAD) {
                        // Four positive separation distances -- how far r
                        // would need to move (in one direction) to clear p
                        // on that axis alone. Smallest wins (minimum
                        // penetration axis); ties prefer down, the legacy
                        // direction, to keep behavior deterministic.
                        var dDown = (p.bottom + WM_PAD) - r.top;
                        var dUp = (r.bottom + WM_PAD) - p.top;
                        var dRight = (p.right + WM_PAD) - r.left;
                        var dLeft = (r.right + WM_PAD) - p.left;
                        // Second collision with the same placed plate =
                        // the min-axis picks are cycling; go monotone.
                        if (resolvedAgainst[i]) fallbackDown = true;
                        resolvedAgainst[i] = true;
                        var dMin = fallbackDown ? dDown : Math.min(dDown, dUp, dRight, dLeft);
                        if (dMin <= 0) continue;
                        var m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(e.el.getAttribute('transform') || '');
                        var tx = m ? parseFloat(m[1]) : 0;
                        var ty = m ? parseFloat(m[2]) : 0;
                        // Screen->world conversion: same as positionGroupCaptions'
                        // dy / (zoomK || 1) -- currentZoomK here is the raw
                        // absolute zoom k (not a fit-relative ratio).
                        var worldD = dMin / (currentZoomK || 1);
                        if (dMin === dDown) {
                            ty += worldD;
                            r.top += dMin; r.bottom += dMin;
                        } else if (dMin === dUp) {
                            ty -= worldD;
                            r.top -= dMin; r.bottom -= dMin;
                        } else if (dMin === dRight) {
                            tx += worldD;
                            r.left += dMin; r.right += dMin;
                        } else {
                            tx -= worldD;
                            r.left -= dMin; r.right -= dMin;
                        }
                        e.el.setAttribute('transform', 'translate(' + tx + ',' + ty + ')');
                        moved = true;
                    }
                }
            }
            wmPlaced.push(r);
        });
    }

    function updateWatermarkColors() {
        if (!svg || !currentData) return;
        var superClusters = currentData.super_clusters || [];
        if (!superClusters.length) return;

        svg.selectAll('g.watermark').each(function () {
            var g = d3.select(this);
            var paths = g.selectAll('path');
            if (paths.empty()) return;
            // Extract keyword from the group's path fill color — simpler to
            // just re-draw since watermarks are lightweight
        });
        // Full redraw is cheap for a handful of watermark groups
        var root = svg.select('.graph-root');
        drawWatermarks(root, currentData.clusters || []);
    }

    // ── Padded hull path ─────────────────────────────────────────────

    function paddedHullPath(points, pad) {
        if (points.length < 2) return '';
        if (points.length === 2) {
            var cx = (points[0][0] + points[1][0]) / 2;
            var cy = (points[0][1] + points[1][1]) / 2;
            var rx = Math.abs(points[0][0] - points[1][0]) / 2 + pad;
            var ry = Math.max(pad, Math.abs(points[0][1] - points[1][1]) / 2 + pad);
            return 'M' + (cx - rx) + ',' + cy +
                   'A' + rx + ',' + ry + ' 0 1,0 ' + (cx + rx) + ',' + cy +
                   'A' + rx + ',' + ry + ' 0 1,0 ' + (cx - rx) + ',' + cy + 'Z';
        }
        var hull = d3.polygonHull(points);
        if (!hull) return '';
        var segments = [];
        for (var i = 0; i < hull.length; i++) {
            var p1 = hull[(i + 1) % hull.length];
            var p2 = hull[(i + 2) % hull.length];
            var v1x = p1[0] - hull[i][0], v1y = p1[1] - hull[i][1];
            var v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
            var len1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
            var len2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
            segments.push({
                lineEnd: [p1[0] + (-v1y / len1) * pad, p1[1] + (v1x / len1) * pad],
                arcEnd:  [p1[0] + (-v2y / len2) * pad, p1[1] + (v2x / len2) * pad]
            });
        }
        var d = 'M' + segments[0].arcEnd[0] + ',' + segments[0].arcEnd[1];
        for (var j = 1; j < segments.length; j++) {
            d += 'L' + segments[j].lineEnd[0] + ',' + segments[j].lineEnd[1];
            d += 'A' + pad + ',' + pad + ' 0 0,1 ' + segments[j].arcEnd[0] + ',' + segments[j].arcEnd[1];
        }
        d += 'L' + segments[0].lineEnd[0] + ',' + segments[0].lineEnd[1];
        d += 'A' + pad + ',' + pad + ' 0 0,1 ' + segments[0].arcEnd[0] + ',' + segments[0].arcEnd[1] + 'Z';
        return d;
    }

    // ── Cluster membership lookup builder ────────────────────────────

    function buildClusterLookup(clusters) {
        var lookup = {};
        clusters.forEach(function (c) {
            lookup[c.id] = {};
            c.page_ids.forEach(function (pid) { lookup[c.id][pid] = true; });
        });
        return lookup;
    }

    // ── Synchronous force layout ─────────────────────────────────────

    function computeLayout(nodes, clusters, links, width, height) {
        var lookup = buildClusterLookup(clusters);

        // Build cluster membership count for collide radius
        var clusterSize = {};
        clusters.forEach(function (c) { clusterSize[c.id] = c.page_ids.length; });

        // ── Phase 1: Position cluster centroids by similarity ──────────

        // SCRUNCH FIX 2026-04-28: seeded init temporarily disabled. The
        // proportional seed range (0.2 + 0.6 * rng()) × W/H combined with
        // the absolute-pixel force parameters (charge=-80, distanceMax=300,
        // link distance 30-150) produced viewport-dependent layouts: forces
        // dominate at small viewports (good fit), but at 16:9 fullscreen
        // the seed influence remained and the force-driven equilibrium
        // (roughly square) didn't match canvas aspect, producing visible
        // letterboxing. Reverted to d3-force phyllotaxis default for now.
        // The other determinism wiring stays intact — sim1.randomSource
        // (line ~1715) and per-cluster sim.randomSource (line ~2035) still
        // seed the force-jiggle RNGs, so layout is still reproducible
        // given a stable cluster array order from the backend payload.
        // Revisit post-MVP submission alongside a canvas-aware force
        // tuning pass (decouple layout coords from viewport, or scale
        // charge/distanceMax with canvas size).
        var clusterNodes = clusters.map(function (c) {
            // var initRng = mulberry32(hashId(c.id));
            return {
                id: c.id,
                memberCount: c.page_ids.length,
                // x: width * (0.2 + 0.6 * initRng()),
                // y: height * (0.2 + 0.6 * initRng()),
            };
        });

        var clusterIdIndex = {};
        clusterNodes.forEach(function (cn, i) { clusterIdIndex[cn.id] = i; });

        // Deep-copy links for Phase 1 (forceLink mutates source/target to refs)
        var phase1Links = links
            .filter(function (l) { return clusterIdIndex[l.source] != null && clusterIdIndex[l.target] != null; })
            .map(function (l) { return { source: l.source, target: l.target, weight: l.weight }; });

        var sim1 = d3.forceSimulation(clusterNodes)
            // Seeded RNG -> deterministic tie-breaking jiggle in forceManyBody
            // / forceLink. Without this the layout drifts between reloads
            // even with seeded initial positions.
            .randomSource(mulberry32(0xC0FFEE))
            .force('link', d3.forceLink(phase1Links)
                .id(function (d) { return d.id; })
                .distance(function (d) { return 30 + 120 * (1 - d.weight); })
                .strength(function (d) { return d.weight * d.weight * d.weight; })
            )
            .force('charge', d3.forceManyBody().strength(-80).distanceMax(300))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .alphaDecay(0.02)
            .stop();

        for (var t1 = 0; t1 < 400; t1++) sim1.tick();

        // ── Phase 1.5: Gentle super-cluster attraction ───────────────
        // Pull clusters in the same super-cluster toward their group centroid.
        // SC_STRENGTH is deliberately low — a suggestion, not a mandate.
        var superClusterGroups = {};
        clusters.forEach(function (c) {
            if (c.super_cluster) {
                if (!superClusterGroups[c.super_cluster]) superClusterGroups[c.super_cluster] = [];
                superClusterGroups[c.super_cluster].push(c.id);
            }
        });

        if (Object.keys(superClusterGroups).length > 0) {
            // ── Phase 1.5b: Repel super-cluster groups from each other ──
            // Pushes SC centroids apart so their halos + a small gap fit
            // without overlap. Minimum distance is SIZE-AWARE:
            //   min_dist(A, B) = haloRadius(A) + haloRadius(B) + INTER_SC_GAP
            // 1.5b translates entire SC groups by the same delta so the
            // downstream 1.5a ring placement sees well-separated centers.
            var scKeys = Object.keys(superClusterGroups);
            if (scKeys.length > 1) {
                var SC_INTER_REPEL_ITERS = 60;
                var INTER_SC_GAP = 60;  // px buffer between halo edges

                // Page counts per cluster id (shared with Phase 1.75 below).
                var _clusterPageCount = {};
                clusters.forEach(function (c) {
                    _clusterPageCount[c.id] = (c.page_ids || []).length;
                });
                function _estNebulaRadius(clusterId) {
                    var n = _clusterPageCount[clusterId] || 1;
                    return Math.max(Math.sqrt(n) * 9 * NEBULA_RADIUS_MULT, NEBULA_MIN_RADIUS);
                }

                for (var iri = 0; iri < SC_INTER_REPEL_ITERS; iri++) {
                    // Compute current SC centroids AND halo radii
                    var scCens = {};
                    var scHaloR = {};
                    scKeys.forEach(function (sk) {
                        var mids = superClusterGroups[sk];
                        var cx2 = 0, cy2 = 0, cn2 = 0;
                        mids.forEach(function (mid) {
                            var cn = clusterNodes.find(function (n) { return n.id === mid; });
                            if (cn) { cx2 += cn.x; cy2 += cn.y; cn2++; }
                        });
                        if (cn2 === 0) return;
                        scCens[sk] = { x: cx2 / cn2, y: cy2 / cn2 };
                        // Halo radius = max over members of (offset + est nebula)
                        var maxExtent = 0;
                        mids.forEach(function (mid) {
                            var cn = clusterNodes.find(function (n) { return n.id === mid; });
                            if (!cn) return;
                            var dd = Math.sqrt(
                                (cn.x - scCens[sk].x) * (cn.x - scCens[sk].x) +
                                (cn.y - scCens[sk].y) * (cn.y - scCens[sk].y)
                            );
                            var e = dd + _estNebulaRadius(mid);
                            if (e > maxExtent) maxExtent = e;
                        });
                        scHaloR[sk] = maxExtent;
                    });

                    for (var si = 0; si < scKeys.length; si++) {
                        for (var sj = si + 1; sj < scKeys.length; sj++) {
                            var ca = scCens[scKeys[si]], cb = scCens[scKeys[sj]];
                            if (!ca || !cb) continue;
                            var sdx = ca.x - cb.x, sdy = ca.y - cb.y;
                            var sdist = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
                            var minDist = (scHaloR[scKeys[si]] || 0)
                                        + (scHaloR[scKeys[sj]] || 0)
                                        + INTER_SC_GAP;
                            if (sdist < minDist) {
                                var push = (minDist - sdist) * 0.02;
                                var snx = sdx / sdist, sny = sdy / sdist;
                                superClusterGroups[scKeys[si]].forEach(function (mid) {
                                    var cn = clusterNodes.find(function (n) { return n.id === mid; });
                                    if (cn) { cn.x += snx * push; cn.y += sny * push; }
                                });
                                superClusterGroups[scKeys[sj]].forEach(function (mid) {
                                    var cn = clusterNodes.find(function (n) { return n.id === mid; });
                                    if (cn) { cn.x -= snx * push; cn.y -= sny * push; }
                                });
                            }
                        }
                    }
                }
            }

            // ── Phase 1.5a: Ring placement around SC centroid ──
            // SC-member clusters are evenly spaced on a ring whose radius
            // clears the watermark bbox + tallest pill label + gap + pad.
            // Member angular order follows their post-sim1 direction from
            // the SC centroid so placement is deterministic but pseudo-random.
            var CLUSTER_RING_PAD = 40;
            var PILL_CLUSTER_GAP = 16;  // matches LABEL_TO_CLUSTER_GAP (K7)

            for (var scKeyR in superClusterGroups) {
                var rMemberIds = superClusterGroups[scKeyR];
                if (rMemberIds.length === 0) continue;

                var rscx = 0, rscy = 0, rscn = 0;
                rMemberIds.forEach(function (mid) {
                    var cn = clusterNodes.find(function (n) { return n.id === mid; });
                    if (cn) { rscx += cn.x; rscy += cn.y; rscn++; }
                });
                if (rscn === 0) continue;
                rscx /= rscn; rscy /= rscn;

                var rWmBox = computeWatermarkBBox(scKeyR, { x: rscx, y: rscy });
                var rWmHalfW = (rWmBox.maxX - rWmBox.minX) / 2;
                var rWmHalfH = (rWmBox.maxY - rWmBox.minY) / 2;
                var rWmHalfDiag = Math.sqrt(rWmHalfW * rWmHalfW + rWmHalfH * rWmHalfH);

                var maxPillH = 0;
                var allClusters = (currentData && currentData.clusters) || [];
                rMemberIds.forEach(function (mid) {
                    var c = allClusters.find(function (cl) { return cl.id === mid; });
                    if (!c) return;
                    var bb = estimateLabelBBox(c.name || c.id || '', 0, 0);
                    if (bb.h > maxPillH) maxPillH = bb.h;
                });
                var rClusterRadius = rWmHalfDiag + maxPillH + PILL_CLUSTER_GAP + CLUSTER_RING_PAD;

                var rRanked = rMemberIds.map(function (mid) {
                    var cn = clusterNodes.find(function (n) { return n.id === mid; });
                    var ang = cn ? Math.atan2(cn.y - rscy, cn.x - rscx) : 0;
                    return { mid: mid, angle: ang };
                }).sort(function (a, b) { return a.angle - b.angle; });

                rRanked.forEach(function (item, idx) {
                    var ringAngle = (idx / rRanked.length) * 2 * Math.PI;
                    var cn = clusterNodes.find(function (n) { return n.id === item.mid; });
                    if (cn) {
                        cn.x = rscx + Math.cos(ringAngle) * rClusterRadius;
                        cn.y = rscy + Math.sin(ringAngle) * rClusterRadius;
                    }
                });
            }

            // ── Phase 1.75: Push non-members out of super-cluster regions ──
            var scMemberSet = {};
            for (var rk in superClusterGroups) {
                superClusterGroups[rk].forEach(function (mid) { scMemberSet[mid] = rk; });
            }

            // Repulsion radius = TRUE visible halo extent, computed per-member
            // as (offset from SC centroid) + (estimated per-cluster nebula
            // radius). Previously used maxR + 120, which was only a small
            // fraction of the actual visible nebula (NEBULA_MIN_RADIUS = 200
            // alone, more for dense clusters). That left non-SC clusters
            // sitting inside the outer-edge gradient of the halo.
            var SC_REPEL_ITERS = 120;  // 120 works best with post-phyllotaxis + phase-swap (more iters over-pushes)
            var SC_REPEL_STRENGTH = 0.25;
            // Perceptual halo boundary: the visible nebula has an opacity
            // falloff from 100% at center to 0% at the full nebula radius.
            // The "prominent" boundary \u2014 where the halo is still clearly
            // perceptible \u2014 lives around 60% of the full radius (opacity
            // ~25% there, per the nebula opacity stops [1,0.7,0.35,0.1,0]).
            var HALO_VISIBLE_FRACTION = 0.6;
            // Index page counts per cluster id for nebula-radius estimation.
            var clusterPageCount = {};
            clusters.forEach(function (c) {
                clusterPageCount[c.id] = (c.page_ids || []).length;
            });
            function estimateNebulaRadius(clusterId) {
                var n = clusterPageCount[clusterId] || 1;
                // Matches § 10 rendering: radius = max(spread × 12, 200)
                // Phase-2 node spread isn't known here, so approximate via
                // phyllotaxis (spread ≈ √n × 9).
                return Math.max(Math.sqrt(n) * 9 * NEBULA_RADIUS_MULT, NEBULA_MIN_RADIUS);
            }

            for (var ri = 0; ri < SC_REPEL_ITERS; ri++) {
                var scRegions = {};
                for (var rk2 in superClusterGroups) {
                    var rmids = superClusterGroups[rk2];
                    var rcx = 0, rcy = 0, rcn = 0;
                    rmids.forEach(function (mid) {
                        var cn = clusterNodes.find(function (n) { return n.id === mid; });
                        if (cn) { rcx += cn.x; rcy += cn.y; rcn++; }
                    });
                    if (rcn === 0) continue;
                    rcx /= rcn; rcy /= rcn;

                    var maxVisible = 0;
                    rmids.forEach(function (mid) {
                        var cn = clusterNodes.find(function (n) { return n.id === mid; });
                        if (cn) {
                            var dd = Math.sqrt((cn.x - rcx) * (cn.x - rcx) + (cn.y - rcy) * (cn.y - rcy));
                            var extent = dd + estimateNebulaRadius(mid) * HALO_VISIBLE_FRACTION;
                            if (extent > maxVisible) maxVisible = extent;
                        }
                    });
                    scRegions[rk2] = { cx: rcx, cy: rcy, radius: maxVisible };
                }

                // Index cluster records so we can look up page_ids and name
                // for shrinkwrap estimation.
                var clusterById = {};
                clusters.forEach(function (c) { clusterById[c.id] = c; });

                // Halo repel: push each non-SC cluster's shrinkwrap out of
                // any SC halo it pokes into. NON_SC_CLEARANCE adds extra
                // breathing room so clusters don't sit right at the halo
                // edge — they settle comfortably further out.
                var NON_SC_CLEARANCE = 40;
                clusterNodes.forEach(function (cn) {
                    if (scMemberSet[cn.id]) return;
                    var cluster = clusterById[cn.id];
                    if (!cluster) return;
                    var bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y);
                    for (var rk3 in scRegions) {
                        var reg = scRegions[rk3];
                        var hit = rectCircleOverlap(bbox, reg.cx, reg.cy,
                                                     reg.radius + NON_SC_CLEARANCE);
                        if (hit.overlap) {
                            cn.x += hit.nx * hit.penetration * SC_REPEL_STRENGTH;
                            cn.y += hit.ny * hit.penetration * SC_REPEL_STRENGTH;
                            bbox = estimateClusterShrinkwrap(cluster, cn.x, cn.y);
                        }
                    }
                });

                // Pairwise non-SC shrinkwrap repel — the "raisins on expanding
                // bread" pass. PAIR_TOLERANCE is the clearance margin between
                // adjacent cluster bboxes: larger values = more breathing
                // room between neighbors, so they settle with comfortable
                // space rather than just barely not overlapping.
                var PAIR_TOLERANCE = 40;   // 40 works best; bumping higher destabilizes convergence
                var PAIR_PUSH_STR = 0.60;  // 0.60 works well with SC_REPEL_ITERS=120
                var nonSCList = [];
                clusterNodes.forEach(function (cn) {
                    if (scMemberSet[cn.id]) return;
                    var c = clusterById[cn.id];
                    if (!c) return;
                    nonSCList.push({
                        cn: cn,
                        bbox: estimateClusterShrinkwrap(c, cn.x, cn.y),
                        cluster: c,
                    });
                });
                for (var ai = 0; ai < nonSCList.length; ai++) {
                    var A = nonSCList[ai];
                    for (var aj = ai + 1; aj < nonSCList.length; aj++) {
                        var B = nonSCList[aj];
                        var pairHit = rectRectOverlap(A.bbox, B.bbox, PAIR_TOLERANCE);
                        if (!pairHit.overlap) continue;
                        var lenP = Math.sqrt(pairHit.dx * pairHit.dx + pairHit.dy * pairHit.dy) || 1;
                        var px, py;
                        if (pairHit.overlapX < pairHit.overlapY) {
                            px = (pairHit.overlapX / 2 + 1) * (pairHit.dx / lenP);
                            py = 0;
                        } else {
                            px = 0;
                            py = (pairHit.overlapY / 2 + 1) * (pairHit.dy / lenP);
                        }
                        A.cn.x += px * PAIR_PUSH_STR;
                        A.cn.y += py * PAIR_PUSH_STR;
                        B.cn.x -= px * PAIR_PUSH_STR;
                        B.cn.y -= py * PAIR_PUSH_STR;
                        // Refresh bboxes so subsequent pair checks in this
                        // outer iteration see the new positions.
                        A.bbox = estimateClusterShrinkwrap(A.cluster, A.cn.x, A.cn.y);
                        B.bbox = estimateClusterShrinkwrap(B.cluster, B.cn.x, B.cn.y);
                    }
                }
            }
        }

        // ── Phase 1.6: tier-driven collapse packing (batch C C1) ─────
        // Casual/binge groups contract into one dense mass: members move
        // INWARD onto a small ring around their group centroid. Contraction
        // can only vacate space, so it cannot create new overlaps with SC
        // halos or neighboring clusters laid out by Phases 1.5/1.75. The
        // small ring radius makes member nebulas overlap heavily -> reads
        // as a single blob (the "r3 aesthetic" as presentation).
        var collapsePack = {};
        clusters.forEach(function (c) {
            if (!isCollapsedCluster(c)) return;
            if (!collapsePack[c.group_id]) collapsePack[c.group_id] = [];
            collapsePack[c.group_id].push(c.id);
        });
        Object.keys(collapsePack).forEach(function (gid) {
            var mids = collapsePack[gid];
            if (mids.length < 2) return;  // a lone cluster is already a blob
            var gx = 0, gy = 0, gcnt = 0;
            mids.forEach(function (mid) {
                var cn = clusterNodes.find(function (n) { return n.id === mid; });
                if (cn) { gx += cn.x; gy += cn.y; gcnt++; }
            });
            if (!gcnt) return;
            gx /= gcnt; gy /= gcnt;
            var pageCountOf = {};
            clusters.forEach(function (c) {
                pageCountOf[c.id] = (c.page_ids || []).length;
            });
            var meanNebR = 0;
            mids.forEach(function (mid) {
                var n = pageCountOf[mid] || 1;
                meanNebR += Math.max(Math.sqrt(n) * 9 * NEBULA_RADIUS_MULT,
                                     NEBULA_MIN_RADIUS);
            });
            meanNebR /= mids.length;
            var packR = meanNebR * 0.35;
            mids.map(function (mid) {
                var cn = clusterNodes.find(function (n) { return n.id === mid; });
                return { cn: cn, angle: cn ? Math.atan2(cn.y - gy, cn.x - gx) : 0 };
            }).sort(function (a, b) { return a.angle - b.angle; })
              .forEach(function (item, idx, arr) {
                if (!item.cn) return;
                var th = (idx / arr.length) * 2 * Math.PI;
                item.cn.x = gx + Math.cos(th) * packR;
                item.cn.y = gy + Math.sin(th) * packR;
            });
        });

        // Record fixed centroid positions (after optional super-cluster attraction)
        var centroidPos = {};
        clusterNodes.forEach(function (cn) {
            centroidPos[cn.id] = { x: cn.x, y: cn.y };
        });

        // ── Phase 2: Arrange page nodes within clusters ────────────────

        // Initialize nodes at their cluster centroid using phyllotaxis spiral
        var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));  // ~137.508°
        var clusterCounters = {};
        nodes.forEach(function (n) {
            var cid = n.parent_id;
            var pos = centroidPos[cid];
            if (!pos) { n.x = width / 2; n.y = height / 2; return; }
            if (!clusterCounters[cid]) clusterCounters[cid] = 0;
            var i = clusterCounters[cid]++;
            var r = Math.sqrt(i) * (NODE_RADIUS * 3 * PAGE_SPREAD_MULT);
            var theta = i * GOLDEN_ANGLE;
            n.x = pos.x + r * Math.cos(theta);
            n.y = pos.y + r * Math.sin(theta);
        });

        // Run ONE force sim PER CLUSTER so collision is cluster-local.
        // The previous global d3.forceSimulation(nodes) meant that large dense
        // clusters (e.g. the _unclustered singleton bucket with 50+ nodes)
        // pressed against neighbors and squeezed small clusters into linear
        // columns — collide(r=5) is blind to cluster membership. Isolating
        // sims lets each cluster relax its own phyllotaxis seeding into a
        // circular cloud without interference from adjacent clusters.
        var nodesByCluster = {};
        nodes.forEach(function (n) {
            var cid = n.parent_id;
            if (!nodesByCluster[cid]) nodesByCluster[cid] = [];
            nodesByCluster[cid].push(n);
        });

        Object.keys(nodesByCluster).forEach(function (cid) {
            var group = nodesByCluster[cid];
            var pos = centroidPos[cid];
            if (!pos) return;
            var sim = d3.forceSimulation(group)
                // Per-cluster seed -> deterministic page-node packing within
                // each cluster across reloads. Without this, even with Phase 1
                // pinned, the per-page positions still drifted via collide's
                // jiggle, which is what fed cluster centroids in the radial
                // anchor calc.
                .randomSource(mulberry32(hashId(cid)))
                .force('x', d3.forceX(pos.x).strength(0.3))
                .force('y', d3.forceY(pos.y).strength(0.3))
                .force('collide', d3.forceCollide().radius((NODE_RADIUS + 2) * PAGE_SPREAD_MULT))
                .alphaDecay(0.05)
                .stop();
            for (var t = 0; t < 150; t++) sim.tick();
        });
    }

    // ── Fit-to-content zoom ──────────────────────────────────────────

    function fitToContent(nodes, canvasW, canvasH, zoomBehavior, setContentBBox) {
        if (!nodes.length || !svg) return;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(function (n) {
            if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        });

        // Include SC watermark extents: names hang ICON/2 + pad + wrapped
        // lines below the SC centroid, and the node-only bbox cropped the
        // lowest SC name at the viewport edge at fit zoom (design audit
        // §4.4 — demo's "ELECTRONICS AND ARDUINO"). Sizes are the fit-zoom
        // (BASE_*) values, which is exactly the state the fit produces.
        var scs = currentData && currentData.super_clusters || [];
        if (scs.length && currentData.clusters) {
            var scCents = computeClusterCentroids(currentData.clusters, nodes);
            var byKw = {};
            currentData.clusters.forEach(function (c) {
                if (!c.super_cluster) return;
                var cen = scCents[c.id];
                if (!cen) return;
                if (!byKw[c.super_cluster]) byKw[c.super_cluster] = { y: 0, n: 0 };
                byKw[c.super_cluster].y += cen.y;
                byKw[c.super_cluster].n++;
            });
            Object.keys(byKw).forEach(function (kw) {
                var cy = byKw[kw].y / byKw[kw].n;
                var lines = wrapLabelLines(kw.slice(0, 36), 14).length;
                var bottom = cy + BASE_SC_ICON_SIZE / 2 + SC_LABEL_TOP_PAD
                    + lines * BASE_SC_NAME_FONT_SIZE * 1.3 + 8;
                if (bottom > maxY) maxY = bottom;
                var top = cy - BASE_SC_ICON_SIZE / 2 - 8;
                if (top < minY) minY = top;
            });
        }

        // Extend the bbox by the fog footprint -- the nebula
        // (drawNebula/computeNebulaData) paints well past the node
        // positions, and without this the FIT_WORLD_PAD daylight below
        // gets eaten by the cloud instead of appearing beyond it. The
        // NEBULA_FIT_CORE fraction of each nominal fog radius counts as
        // content (default 1.0 -- a 0.6 "visible core" first cut measured
        // -16..-30px top margins at fit: rim-adjacent Layer-1 blobs at the
        // NEBULA_MIN_RADIUS floor read as cloud well past 0.6r; an f-sweep
        // showed >=+15px margins on every edge/viewport only from ~1.0).
        // Two fog layers, matching what computeNebulaData actually paints,
        // each via the SAME shared helper the renderer uses so the fit can
        // never drift from the painted fog:
        //   1. Per-cluster Layer-1 blobs: centroid +- clusterNebulaRadius()
        //      x NEBULA_FIT_CORE, for every real cluster. This is the term
        //      that governs today (measured 2026-07-14: the model
        //      (pad_terms x k) reproduces every fit margin to 0.1px from
        //      Layer-1 alone).
        //   2. Per-SC Layer-2 overlays: weighted SC centroid +-
        //      scOverlayGeometry().maxReach x NEBULA_FIT_CORE. Currently a
        //      provable NO-OP -- the overlay's offset+reach never exceeds a
        //      member's own Layer-1 term under the present constants
        //      (measured identical margins to 0.1px with/without). Kept
        //      deliberately: it costs one loop, shares the renderer's
        //      helper, and keeps the fit correct if a future Layer-2
        //      rebalance (satellite count/reach) makes the overlay
        //      dominant again.
        //
        // Source of cluster identity/centroids: currentData.clusters (the
        // module-level var render() sets before calling fitToContent, and
        // which refitView()/the ResizeObserver handler both guard on being
        // non-null before calling in) -- mirrors the SC-watermark-extents
        // block just above, which already reads currentData.clusters
        // rather than deriving cluster membership from `nodes` itself.
        //
        // Solo/noise faux-clusters (`_solo_<page_id>`, one page each --
        // scattered singleton dots AND hideable noise dots) are excluded:
        // their fog floor (NEBULA_MIN_RADIUS) is sized for a real cluster,
        // and unioning it in for every scattered single-page dot would
        // balloon the fit bbox far past what's actually visible. Their
        // nodes are already covered by the plain node-bbox pass above (+
        // the flat pad below) -- no fog term needed for them. (They also
        // never carry super_cluster, so the SC-overlay union skips them
        // structurally.)
        if (currentData && currentData.clusters) {
            var fogCentroids = computeClusterCentroids(currentData.clusters, nodes);
            var fogSCGroups = {};
            currentData.clusters.forEach(function (c) {
                if (isSoloFauxCluster(c.id)) return;
                var cen = fogCentroids[c.id];
                if (!cen) return;
                var core = clusterNebulaRadius(c, cen, nodes) * NEBULA_FIT_CORE;
                if (cen.x - core < minX) minX = cen.x - core;
                if (cen.x + core > maxX) maxX = cen.x + core;
                if (cen.y - core < minY) minY = cen.y - core;
                if (cen.y + core > maxY) maxY = cen.y + core;
                if (c.super_cluster) {
                    if (!fogSCGroups[c.super_cluster]) fogSCGroups[c.super_cluster] = [];
                    fogSCGroups[c.super_cluster].push(c);
                }
            });
            Object.keys(fogSCGroups).forEach(function (kw) {
                var geo = scOverlayGeometry(fogSCGroups[kw], fogCentroids, nodes);
                if (!geo) return;
                var core = geo.maxReach * NEBULA_FIT_CORE;
                if (geo.cx - core < minX) minX = geo.cx - core;
                if (geo.cx + core > maxX) maxX = geo.cx + core;
                if (geo.cy - core < minY) minY = geo.cy - core;
                if (geo.cy + core > maxY) maxY = geo.cy + core;
            });
        }

        minX -= HULL_PADDING + FIT_WORLD_PAD; minY -= HULL_PADDING + FIT_WORLD_PAD + 20;
        maxX += HULL_PADDING + FIT_WORLD_PAD; maxY += HULL_PADDING + FIT_WORLD_PAD;
        var bw = maxX - minX, bh = maxY - minY;
        if (bw <= 0 || bh <= 0) return;

        // Store content bounds for pan clamping
        setContentBBox({ x: minX, y: minY, w: bw, h: bh });

        var scale = Math.min(canvasW / bw, canvasH / bh);
        var mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
        var transform = d3.zoomIdentity
            .translate(canvasW / 2 - mx * scale, canvasH / 2 - my * scale)
            .scale(scale);
        svg.call(zoomBehavior.transform, transform);
        // Zoom range in RELATIVE terms (× fit-scale) so behavior is
        // compendium-size-agnostic.
        //   min = scale * 0.10 (galaxy-overview view; matches the
        //                       oscillation tuner's lowest setting)
        //   max = scale * 4    (capped at 400% — beyond this the graph
        //                       visually breaks)
        // Zoom-out floor MIN_ZOOM_RATIO×fit (was 0.10): panning is
        // content-clamped, so sub-fit zoom only shrinks the map toward a
        // smudge — at 0.10 the whole compendium painted ~100px in an empty
        // starfield (design audit §3). MIN_ZOOM_RATIO (0.5) keeps the far
        // view a legible constellation overview. This same ratio also
        // bounds the pan-clamp's expanded rect below.
        zoomBehavior.scaleExtent([scale * MIN_ZOOM_RATIO, scale * 4]);
        // Record the fit-scale so LOD can derive "zoom ratio" relative to fit.
        fitZoom = scale;
        currentZoomK = scale;
        updateLabelLOD(scale);
        updateZoomIndicator(scale);
        updateLabelScale(scale);
        // R6.2: chips are correct at first paint, not just after the first
        // pan/zoom (every fitToContent call site funnels through here).
        updateEdgeChips();
    }

    // Rethink R4: every structural click both selects and frames. Scale is
    // expressed in fit-zoom multiples so behavior is compendium-size-
    // agnostic; the zoom handler's pan clamp still applies.
    function frameWorldBBox(bb, opts) {
        if (!svg || !storedZoomBehavior || !bb || !lastCanvasDims) return;
        var o = opts || {};
        var pad = o.pad != null ? o.pad : 80;
        var w = bb.maxX - bb.minX + pad * 2, h = bb.maxY - bb.minY + pad * 2;
        if (w <= 0 || h <= 0) return;
        var scale = Math.min(lastCanvasDims.w / w, lastCanvasDims.h / h);
        scale = Math.max(fitZoom * (o.minRatio || 0.5),
                         Math.min(fitZoom * (o.maxRatio || 2.0), scale));
        var mx = (bb.minX + bb.maxX) / 2, my = (bb.minY + bb.maxY) / 2;
        var t = d3.zoomIdentity
            .translate(lastCanvasDims.w / 2 - mx * scale,
                       lastCanvasDims.h / 2 - my * scale)
            .scale(scale);
        svg.transition().duration(o.duration != null ? o.duration : 500)
            .call(storedZoomBehavior.transform, t);
    }

    function bboxOfNodes(pred) {
        if (!currentData) return null;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, any = false;
        (currentData.nodes || []).forEach(function (n) {
            if (n.x == null || !pred(n)) return;
            any = true;
            if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        });
        return any ? { minX: minX, maxX: maxX, minY: minY, maxY: maxY } : null;
    }

    function clusterWorldBBox(cluster) {
        var ids = {};
        (cluster.page_ids || []).forEach(function (pid) { ids[pid] = true; });
        return bboxOfNodes(function (n) { return ids[n.id]; });
    }

    function scWorldBBox(keyword) {
        var ids = {};
        (currentData.clusters || []).forEach(function (c) {
            if (c.super_cluster === keyword) {
                (c.page_ids || []).forEach(function (pid) { ids[pid] = true; });
            }
        });
        return bboxOfNodes(function (n) { return ids[n.id]; });
    }

    function groupWorldBBox(groupId) {
        var ids = {};
        (currentData.clusters || []).forEach(function (c) {
            if (c.group_id === groupId) {
                (c.page_ids || []).forEach(function (pid) { ids[pid] = true; });
            }
        });
        return bboxOfNodes(function (n) { return ids[n.id]; });
    }

    // Rethink R4.3: shared body for the caption click (drawGroupLabels) and
    // the knot-hit click (drawNebula) -- both toggle the same expandedGroups
    // map, re-render with the camera pinned (preserveView), then frame the
    // group only when it just expanded (collapsing never moves the camera).
    function toggleGroupExpansion(groupId, expanding) {
        expandedGroups[groupId] = expanding;
        if (!rawData) return;
        // rawData, not currentData: render() re-assigns rawData from its argument, and currentData may be noise-filtered — passing it would corrupt the toggle's source of truth.
        render(rawData, { preserveView: true });
        if (expanding) {
            var bb = groupWorldBBox(groupId);
            if (bb) frameWorldBBox(bb, { minRatio: 1.6, maxRatio: 2.6 });
        }
    }

    function refitView() {
        if (!currentData || !storedZoomBehavior || !lastCanvasDims) return;
        fitToContent(currentData.nodes || [], lastCanvasDims.w, lastCanvasDims.h,
            storedZoomBehavior, function () {});
    }

    // ── Render ────────────────────────────────────────────────────────

    function render(data, opts) {
        // Empty payload — the static layout starts d3-graph-data with
        // {nodes:[], links:[], clusters:[], super_clusters:[]} so the
        // page doesn't render a stale-baked-in snapshot during the
        // refresh_graph_on_load build window. Skip render entirely;
        // the loading overlay (managed by Dash clientside callback)
        // covers this state. When the callback completes and the store
        // populates, render() is re-invoked with real data.
        if (!data || !data.nodes || data.nodes.length === 0) {
            return;
        }

        // Keep the unfiltered dataset as the source of truth so the noise
        // toggle can re-enter render() with full data without losing the
        // _unclustered bucket after it's been hidden.
        rawData = data;

        // When noise is toggled off, fully remove _unclustered from the
        // layout input. Previously the toggle only flipped visibility,
        // which left the noise nodes participating in the force sim and
        // pushing surrounding nebulae into inorganic positions.
        var showNoise = readNoiseToggleState();
        var activeData = showNoise ? data : filterOutNoise(data);
        currentData = activeData;

        var container = __mountedContainer;  // was getElementById('d3-graph-container') (header comment delta #1)
        if (!container) return;

        var nodes = activeData.nodes || [];
        var links = activeData.links || [];
        var clusters = activeData.clusters || [];
        // ── Edge cleaning: remove self-edges, deduplicate (keep max weight) ──
        var seen = {};
        var validLinks = [];
        links.forEach(function (l) {
            if (l.source === l.target) return;              // drop self-edges
            var a = l.source < l.target ? l.source : l.target;
            var b = l.source < l.target ? l.target : l.source;
            var key = a + '|' + b;
            if (!seen[key] || l.weight > seen[key].weight) {
                seen[key] = l;
            }
        });
        for (var k in seen) validLinks.push(seen[k]);

        // Always read container dimensions FRESH so viewBox matches the
        // current panel size even if the user resized panels since the
        // initial render. Reusing a stale viewBox causes letterboxing
        // (black space) when the new aspect ratio differs.
        var rect = container.getBoundingClientRect();
        var width = rect.width || 800;
        var height = rect.height || 600;

        if (!svg) {
            svg = d3.select(container).append('svg')
                .attr('width', '100%').attr('height', '100%')
                .attr('viewBox', [0, 0, width, height].join(' '));
            svg.on('click', function (event) {
                if (armedNode) { selectNode(armedNode); return; }
                if (event.target !== svg.node() && event.target.tagName !== 'svg') return;
                // Walk up one level: page -> its cluster; cluster -> its SC
                // frame; nothing -> fit. Misses become navigation, not loss.
                if (selectedNodeId && currentData) {
                    var node = currentData.nodes.find(function (n) { return n.id === selectedNodeId; });
                    var parent = node && currentData.clusters.find(function (c) { return c.id === node.parent_id; });
                    if (parent) { selectCluster(parent, { frame: true }); return; }
                    clearSelection(); return;
                }
                if (selectedClusterId && currentData) {
                    var cl = currentData.clusters.find(function (c) { return c.id === selectedClusterId; });
                    clearSelection();
                    if (cl && cl.super_cluster) {
                        frameWorldBBox(scWorldBBox(cl.super_cluster), { maxRatio: 1.2, minRatio: 0.6 });
                    } else { refitView(); }
                    return;
                }
                clearSelection();
                refitView();
            });
            svg.on('dblclick', function () { clearSelection(); refitView(); });
            svg.on('pointermove', updateArmedDot);
            svg.on('pointerleave', disarmDot);
            // Esc walks all the way up: clear selection, camera untouched
            // (registered once here, like the pointer handlers above --
            // re-adding per render would stack duplicate listeners).
            //
            // A1-1 promotion (delta #11): this now clears ONLY the D3-local
            // visual selection state (mirrors clearSelection()'s body minus
            // its writeTapStore(null) call), not the full clearSelection().
            // GraphCanvas.tsx owns a SEPARATE bubble-phase document Escape
            // listener that dispatches the nav layer's reserved
            // CLEAR_SELECTION action directly (selection-only, filter
            // untouched -- lib/nav.ts). Routing THIS listener's Escape
            // through the full clearSelection() -> writeTapStore(null) ->
            // opts.onSelect(null, null) would instead resolve via
            // resolveCanvasTapAction's background-tap branch to HOME
            // (lib/nav.ts:112-135) and silently wipe the nav filter too --
            // see lib/nav.ts's CLEAR_SELECTION comment for why Esc is
            // deliberately narrower than a real background tap. The
            // (idempotent) local reset below is a synchronous belt-and-
            // suspenders visual clear; GraphCanvas's inbound wiring
            // (`setSelection('node', null)` on CLEAR_SELECTION) achieves
            // the same result via the React round-trip regardless. The
            // handler is stored on the module-level __escapeKeydownHandler
            // so __vendorRender's returned dispose() (same delta) can
            // remove it on unmount instead of leaking past it forever (the
            // S2 fix-round-1 finding 2 known limitation).
            __escapeKeydownHandler = function (e) {
                if (e.key !== 'Escape') return;
                selectedNodeId = null; selectedClusterId = null; selectedSessionId = null; selectedNodeIds = null;
                updateHighlighting();
            };
            document.addEventListener('keydown', __escapeKeydownHandler);

            // Keep the viewBox AND the zoom transform in sync with the
            // container's actual size. Updating viewBox alone stretches
            // coordinate space but leaves content in its old location;
            // re-running fitToContent after resize re-centers the frame.
            if (typeof ResizeObserver !== 'undefined') {
                var ro = new ResizeObserver(function () {
                    if (!svg) return;
                    var r = container.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return;
                    var effH = effectiveCanvasHeight(r.height);
                    svg.attr('viewBox', [0, 0, r.width, r.height].join(' '));
                    if (currentData && storedZoomBehavior) {
                        // Keep frameWorldBBox/refitView's notion of canvas
                        // size current -- this is the second (of two)
                        // fitToContent call sites, and a resize between
                        // clicks would otherwise leave lastCanvasDims stale.
                        lastCanvasDims = { w: r.width, h: effH };
                        fitToContent(
                            currentData.nodes || [],
                            r.width, effH,
                            storedZoomBehavior,
                            function (bb) { contentBBox = bb; }
                        );
                    }
                });
                ro.observe(container);
                // A1-1 promotion (delta #11): module-level handle so this
                // specific instance can be disconnected on container swap
                // or dispose() -- see the var declaration's comment above.
                __resizeObserverHandle = ro;
            }
            // Glow filter for cluster label hover
            var defs = svg.append('defs');
            var glowFilter = defs.append('filter').attr('id', 'label-glow')
                .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
            glowFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '3').attr('result', 'blur');
            var glowMerge = glowFilter.append('feMerge');
            glowMerge.append('feMergeNode').attr('in', 'blur');
            glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

            // Star anatomy defs (checkpoint-A iteration 2 — glyph-only, no
            // halo): four spike variants are <use>-referenced so 479+ stars
            // cost 4 path defs, not 479 paths. All four variants are now
            // real paths (waists widened so arms survive small sizes
            // without a backing disc); v0 is no longer a null/no-op.
            var starDefs = [
                'M0,-1.3 L0.5,-0.5 L1.3,0 L0.5,0.5 L0,1.3 L-0.5,0.5 L-1.3,0 L-0.5,-0.5 Z',
                'M0,-2 L0.6,-0.6 L2,0 L0.6,0.6 L0,2 L-0.6,0.6 L-2,0 L-0.6,-0.6 Z',
                'M0,-3 L0.42,-0.42 L3,0 L0.42,0.42 L0,3 L-0.42,0.42 L-3,0 L-0.42,-0.42 Z',
                'M-1.4,-1.4 L0,-0.55 L1.4,-1.4 L0.55,0 L1.4,1.4 L0,0.55 L-1.4,1.4 L-0.55,0 Z',
            ];
            starDefs.forEach(function (dPath, i) {
                defs.append('path').attr('id', 'star-v' + i).attr('d', dPath);
            });

            var root = svg.append('g').attr('class', 'graph-root');
            root.append('g').attr('class', 'nebula');
            root.append('g').attr('class', 'hulls');
            root.append('g').attr('class', 'links');
            root.append('g').attr('class', 'nodes');
            // Rethink R2.5 (comment corrected, T7 review): knot hit-targets
            // live in their own layer above '.nodes'. Everything below
            // ('.nebula', '.hulls', '.links' when re-enabled, '.nodes') is
            // pointer-events:none today — including circle.page and
            // use.star-spikes, which cannot intercept events regardless of
            // fill-opacity/visiblePainted, so they don't "swallow" hover —
            // but painting knot-hits here stays correct if '.hulls'/'.links'
            // are ever re-enabled with real hit-testing. Watermark icons and
            // hull/group-label captions above this layer can still partially
            // occlude a knot's center (known T11 territory).
            root.append('g').attr('class', 'knot-hits');
            root.append('g').attr('class', 'watermarks');
            root.append('g').attr('class', 'hull-labels');
            // Per-page page-title labels for featured starfield singletons.
            // Drawn above hull-labels so they remain visible when overlapping.
            root.append('g').attr('class', 'singleton-labels');
        } else {
            svg.select('.graph-root').selectAll('*').remove();
            svg.select('defs').selectAll('radialGradient[id^="nebula-grad-"]').remove();
            svg.attr('viewBox', [0, 0, width, height].join(' '));
            var root = svg.select('.graph-root');
            root.append('g').attr('class', 'nebula');
            root.append('g').attr('class', 'hulls');
            root.append('g').attr('class', 'links');
            root.append('g').attr('class', 'nodes');
            root.append('g').attr('class', 'knot-hits');
            root.append('g').attr('class', 'watermarks');
            root.append('g').attr('class', 'hull-labels');
            // Was missing from the re-render branch — every re-render
            // silently dropped the layer, so page-title labels (and the
            // retired singleton labels before them) only existed on the
            // very first render.
            root.append('g').attr('class', 'singleton-labels');
        }

        var root = svg.select('.graph-root');

        // Zoom (scroll only — no click-drag pan)
        // contentBBox is set by fitToContent after layout
        var contentBBox = null;

        var zoomBehavior = d3.zoom()
            .scaleExtent([0.05, 6])
            .on('zoom', function (event) {
                var t = event.transform;
                // Clamp pan to the world rect visible at the MIN_ZOOM_RATIO
                // zoom-out floor — i.e., contentBBox expanded by 1/MIN_ZOOM_RATIO
                // around its own center — rather than to contentBBox itself.
                // Invariant: pan may reach everything visible at the
                // MIN_ZOOM_RATIO floor, at any zoom.
                //
                // Scaled expanded-rect edges in screen coords:
                //   left  = ex * t.k + t.x
                //   right = (ex + bw2) * t.k + t.x
                // Constraints:
                //   left  <= 0         (rect left edge at or before canvas left)
                //   right >= width     (rect right edge at or past canvas right)
                //
                // This formula is uniform at every zoom on the TIGHT axis --
                // where the expanded rect is exactly as big as (or bigger
                // than) the canvas, minTx/minTy <= maxTx/maxTy and the plain
                // clamp is correct, collapsing to centered right at the
                // MIN_ZOOM_RATIO floor. But the two axes are rarely tight
                // together (aspect-ratio mismatch), and the Y axis in
                // particular ALWAYS has slack relative to raw canvas height
                // (effectiveCanvasHeight reserves search-bar space, so the
                // expanded rect's height is invariant = effectiveCanvasHeight,
                // permanently less than raw `height`). On a slack axis
                // minTx > maxTx (no t.x satisfies both edge constraints at
                // once), and naively nesting Math.max/Math.min always
                // resolves to minTx/minTy regardless of t.x -- pinning
                // content to one edge instead of centering it (verified via
                // screenshot: without this branch the compendium sat
                // visibly right/bottom-shifted at the 50% zoom floor).
                // Detect that case and center explicitly instead.
                if (contentBBox) {
                    var cx = contentBBox.x + contentBBox.w / 2;
                    var cy = contentBBox.y + contentBBox.h / 2;
                    var bw2 = contentBBox.w / MIN_ZOOM_RATIO;
                    var bh2 = contentBBox.h / MIN_ZOOM_RATIO;
                    var ex = cx - bw2 / 2;
                    var ey = cy - bh2 / 2;

                    var maxTx = -ex * t.k;
                    var minTx = width - (ex + bw2) * t.k;
                    t.x = (minTx > maxTx) ? (minTx + maxTx) / 2
                                          : Math.max(minTx, Math.min(maxTx, t.x));

                    var maxTy = -ey * t.k;
                    var minTy = height - (ey + bh2) * t.k;
                    t.y = (minTy > maxTy) ? (minTy + maxTy) / 2
                                          : Math.max(minTy, Math.min(maxTy, t.y));
                }
                root.attr('transform', t);
                updateLabelLOD(t.k);
                updateZoomIndicator(t.k);
                updateLabelScale(t.k);
                // R6.2: edge chips depend on the just-applied transform
                // (world->screen), so this must come after updateLabelScale,
                // not before.
                updateEdgeChips();
            });
        svg.call(zoomBehavior);
        // d3-zoom's own dblclick-zoom conflicts with the app's dblclick
        // (clear + refit) handler above. zoomBehavior is a fresh d3.zoom()
        // instance every render, so svg.call(zoomBehavior) re-attaches its
        // internal 'dblclick.zoom' listener each time -- this disable must
        // be re-applied after every attach, not just once at construction.
        svg.on('dblclick.zoom', null);
        storedZoomBehavior = zoomBehavior;
        ensureZoomIndicator(container, function () { return storedZoomBehavior; });
        ensureEdgeChipLayer(container);
        // mountDevTunerOnce() call deleted here (header comment delta #4).

        // Pre-measure label dimensions so Phase 1.75 non-SC repel uses
        // accurate text widths (variable-width font means char-based
        // estimate is ~10-15% off, causing rare label overlaps in the
        // rendered output even though the bbox math claims clearance).
        clusters.forEach(function (c) {
            if (c.name) measureLabelDims(c.name, svg);
        });

        // ── Phase 1: Compute layout synchronously ──
        computeLayout(nodes, clusters, validLinks, width, height);

        // Assign galaxy colors after layout (uses centroid positions).
        // CSS custom properties may not be injected yet on first render
        // (Dash callback latency), so retry until real stops are found.
        assignClusterColors(clusters, nodes);
        (function retryColors(attempt) {
            var stops = getGalaxyStops();
            var hasRealStops = getComputedStyle(document.documentElement).getPropertyValue('--galaxy-0').trim();
            if (!hasRealStops && attempt < 15) {
                setTimeout(function () {
                    assignClusterColors(clusters, nodes);
                    if (svg) {
                        // circle.page fill is static 'currentColor' (checkpoint-A) —
                        // no re-assignment needed here; cluster color still drives
                        // hull labels / markers / nebula below.
                        svg.selectAll('text.hull-label').attr('fill', function (d) {
                            return labelColor(clusterColor(d.cluster.id));
                        });
                        svg.selectAll('.hull-label-marker').attr('fill', function (d) {
                            return clusterColor(d.cluster.id);
                        });
                        updateNebulaColors();
                        updateWatermarkColors();
                    }
                    retryColors(attempt + 1);
                }, 200);
            }
        })(0);

        // ── Phase 2: Render static elements ──

        // Links — TEMPORARILY DISABLED pending bullet-9 revisit (styling direction undecided).
        // Downstream selections (hover/selection opacity updates, drawClusterLinks) operate
        // on `line.cluster-link` and become no-ops when nothing is rendered. Re-enable by
        // uncommenting the block below.
        // root.select('.links').selectAll('line.cluster-link')
        //     .data(validLinks).enter().append('line')
        //     .attr('class', 'cluster-link')
        //     .attr('stroke', mutedColor())
        //     .attr('stroke-opacity', LINK_OPACITY)
        //     .attr('stroke-width', function (d) { return Math.max(0.3, d.weight * d.weight * 5); });
        var linkAll = root.select('.links').selectAll('line.cluster-link');

        // Star decorations: glyph only (checkpoint-A iteration 2 — halo
        // removed). Deterministic variant per page id so stars don't
        // reshuffle between renders. Decoration and anchor are both
        // pointer-events:none (stale comment corrected, T7 review) --
        // interaction lives at the svg level (Delaunay arming + delegated
        // handlers), not on either element here.
        root.select('.nodes').selectAll('use.star-spikes')
            .data(nodes, function (d) { return d.id; })
            .enter().append('use')
            .attr('class', 'star-spikes')
            .attr('href', function (d) { return '#star-v' + starVariant(d.id); })
            .attr('fill', 'currentColor')
            .attr('opacity', starGlyphOpacity)
            .attr('pointer-events', 'none');

        // Nodes
        root.select('.nodes').selectAll('circle.page')
            .data(nodes, function (d) { return d.id; })
            .enter().append('circle')
            .attr('class', function (d) {
                // kind discriminator from the backend graph payload (cluster
                // / singleton / unclustered). Lets CSS target singletons for
                // the lighter LOD treatment without changing the JS rendering
                // path.
                return d.kind === 'singleton'
                    ? 'page singleton'
                    : (d.kind === 'unclustered' ? 'page unclustered' : 'page');
            })
            .attr('r', function (d) {
                // Screen-clamped star radius (rethink R1.1); singletons
                // read slightly smaller inside pageDotRadius itself.
                return pageDotRadius(d, currentZoomK);
            })
            // All page nodes: opaque theme-ink dots (white on dark themes,
            // black on light themes) so every star reads independent of
            // cluster color. fill: 'currentColor' lets CSS drive the color
            // via the circle.page rule in theme.css, where var(--ink)
            // flips automatically on theme switch. Cluster identity now
            // lives in nebula tint + labels, not the star color
            // (checkpoint-A iteration — was a singleton-only special case).
            .attr('fill', 'currentColor')
            // Invisible anchor (checkpoint-A iter 2): the glyph in
            // use.star-spikes is the visible star. fill-opacity 0 (NOT
            // fill:none) so 'visiblePainted' hit-testing still works and
            // the verify rig still measures the anchor radius.
            .attr('fill-opacity', 0)
            .attr('stroke', 'none')
            .attr('opacity', 1.0)
            // Rethink R2.1: hit-testing moved to the svg-level Delaunay
            // lookup (updateArmedDot / disarmDot, wired on the svg pointer
            // handlers). Dots no longer own click/hover handlers -- let
            // pointer events pass through to the svg so the armed branch
            // in svg.on('click', ...) fires first, background click second.
            .attr('pointer-events', 'none')
            .attr('cx', function (d) { return d.x; })
            .attr('cy', function (d) { return d.y; });

        // Hulls + labels
        drawHulls(root, nodes, clusters);
        drawGroupLabels(root, clusters, nodes);

        // Singleton labels intentionally not drawn -- nodes alone (now
        // opaque white) carry the "hover/click for details" affordance.
        // Was: drawSingletonLabels(root, nodes);
        // The drawSingletonLabels function and its updateSingletonLabel*
        // helpers are kept in the file for now in case the labels are
        // brought back; they're inert until called.

        // Page titles for ALL dots (singletons included) — revealed past
        // PAGE_TITLE_LOD_K_MIN, collision-culled (audit V3).
        drawPageTitleLabels(root, nodes);

        // Nebula clouds behind clusters
        drawNebula(root, clusters, nodes);

        // Watermark icons behind super-cluster groups
        drawWatermarks(root, clusters);

        // Position links at cluster centroids
        drawClusterLinks(root, linkAll, nodes, clusters, validLinks);

        // ── Phase 3: Fit zoom to content ──
        lastCanvasDims = { w: width, h: effectiveCanvasHeight(height) };
        // Rethink R4.3: expanding a group used to re-render straight through
        // fitToContent, snapping the camera back to fit — expansion was
        // invisible at near zoom. preserveView re-applies the prior
        // transform (re-clamped) instead.
        var prevTransform = (opts && opts.preserveView && svg)
            ? d3.zoomTransform(svg.node()) : null;
        fitToContent(nodes, width, effectiveCanvasHeight(height), zoomBehavior,
            function (bbox) { contentBBox = bbox; });
        if (prevTransform) {
            svg.call(zoomBehavior.transform, prevTransform);
        }
        rebuildDelaunay(nodes);

        // Noise filter is now applied at render input (see render() entry),
        // so no post-render visibility patch is needed.
    }

    // ── Draw singleton page-title labels ─────────────────────────────

    function drawSingletonLabels(root, nodes) {
        var singletonNodes = (nodes || []).filter(function (n) {
            return n.kind === 'singleton' && n.x != null && n.y != null;
        });
        var sel = root.select('.singleton-labels').selectAll('text.singleton-label')
            .data(singletonNodes, function (d) { return d.id; });
        sel.exit().remove();
        var enterSel = sel.enter().append('text')
            .attr('class', 'singleton-label')
            .attr('text-anchor', 'middle')
            .attr('font-style', 'italic')
            .attr('pointer-events', 'none')
            .attr('fill', function () {
                // Use the same contrast helper that hull-labels rely on so
                // singleton text is readable on both light and dark themes.
                return bgLuminance() > 0.5 ? '#222222' : '#e8e8e8';
            });
        // Enter + update share positioning + label text. font-size and
        // opacity are deliberately not set here -- updateSingletonLabelScale
        // and updateSingletonLabelLOD own those, so zoom-driven updates
        // don't get clobbered on the next render() call.
        enterSel.merge(sel)
            .attr('x', function (d) { return d.x; })
            .attr('y', function (d) { return d.y - NODE_RADIUS * 2.6; })
            .text(function (d) {
                var label = (d.label || '').trim();
                return label.length > 24 ? label.slice(0, 23) + '...' : label;
            });
        // Apply current zoom-driven scale + LOD so freshly-rendered labels
        // don't pop in at fit-zoom defaults before the next zoom event.
        updateSingletonLabelScale(currentZoomK);
        updateSingletonLabelLOD(currentZoomK);
    }

    // ── Page-title labels (near-zoom disclosure, audit V3) ───────────
    // One title per page dot, revealed past PAGE_TITLE_LOD_K_MIN and
    // collision-culled as the lowest-priority label class. Rendered into
    // the .singleton-labels layer (same z-slot the retired singleton
    // labels used); all opacity control lives in updatePageTitleLabels.
    function drawPageTitleLabels(root, nodes) {
        if (!SANDBOX_SECTION_GATES.lodNicety) return;  // S2 sandbox-bar gate (header comment delta #8)
        var data = (nodes || []).filter(function (n) {
            return n.x != null && n.y != null && (n.label || '').trim();
        });
        var sel = root.select('.singleton-labels').selectAll('text.page-title-label')
            .data(data, function (d) { return d.id; });
        sel.exit().remove();
        sel.enter().append('text')
            .attr('class', 'page-title-label')
            .attr('text-anchor', 'middle')
            .attr('font-style', 'italic')
            .attr('pointer-events', 'none')
            .attr('fill', function () {
                return bgLuminance() > 0.5 ? '#222222' : '#e8e8e8';
            })
            .style('opacity', 0)
            .merge(sel)
            .attr('x', function (d) { return d.x; })
            .attr('y', function (d) { return d.y - NODE_RADIUS * 2.6; })
            .text(function (d) {
                var label = (d.label || '').trim();
                return label.length > 32 ? label.slice(0, 31) + '…' : label;
            });
    }

    // Called from runLabelCull with the kept-boxes state so titles slot
    // into whatever space cluster labels and captions left over.
    function updatePageTitleLabels(kept, collides) {
        if (!svg) return;
        var ratio = (fitZoom > 0) ? (currentZoomK / fitZoom) : 1;
        var sel = svg.selectAll('text.page-title-label');
        if (sel.empty()) return;
        if (ratio < PAGE_TITLE_LOD_K_MIN) {
            sel.style('opacity', 0);
            return;
        }
        var fade = Math.min(
            1, (ratio - PAGE_TITLE_LOD_K_MIN) / PAGE_TITLE_LOD_FADE_RANGE);
        var op = PAGE_TITLE_BASE_OPACITY * fade;
        var scale = clampedScale(currentZoomK, 'singletonLabel');
        var vw = window.innerWidth, vh = window.innerHeight;
        var items = [];
        sel.attr('font-size',
                 (BASE_SINGLETON_LABEL_FONT_SIZE * scale) + 'px')
            .each(function (d) {
                items.push({
                    el: this,
                    score: (d && typeof d.outlier_score === 'number')
                        ? d.outlier_score : 0,
                });
            });
        items.sort(function (a, b) { return b.score - a.score; });
        items.forEach(function (it) {
            var t = d3.select(it.el);
            var r = screenBBoxOf(it.el);
            // Off-viewport titles are hidden without claiming space.
            if (!r || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) {
                t.style('opacity', 0);
                return;
            }
            if (collides(r)) {
                t.style('opacity', 0);
            } else {
                t.style('opacity', op);
                kept.push(r);
            }
        });
    }

    // Scale singleton label font size with zoom (mirrors updateLabelScale's
    // contract for cluster labels). Pure attr update -- no DOM rebuild.
    function updateSingletonLabelScale(zoomK) {
        if (!svg) return;
        var scale = clampedScale(zoomK, 'singletonLabel');
        var lblSize = BASE_SINGLETON_LABEL_FONT_SIZE * scale;
        svg.selectAll('text.singleton-label').attr('font-size', lblSize + 'px');
    }

    // Fade singleton labels by outlier_score rank with zoom. The K most-
    // outlier-like singletons stay visible across zoom levels; weaker
    // ones fade out first as the user zooms out. Visible-rank-count
    // scales with (zoomRatio ^ SINGLETON_LOD_POWER), so at fit zoom
    // (ratio=1) all labels show; at half zoom, ~25% show; etc.
    function updateSingletonLabelLOD(currentK) {
        if (!svg) return;
        var ratio = (fitZoom > 0) ? (currentK / fitZoom) : 1;
        // Snapshot all singleton-label nodes paired with their outlier_score
        // (datum bound via .data() in drawSingletonLabels).
        var rankList = [];
        svg.selectAll('text.singleton-label').each(function (d) {
            rankList.push({
                el: this,
                score: (d && typeof d.outlier_score === 'number') ? d.outlier_score : 0,
            });
        });
        if (rankList.length === 0) return;
        rankList.sort(function (a, b) { return b.score - a.score; });

        var total = rankList.length;
        var visibleCount = Math.ceil(total * Math.pow(Math.max(0, ratio), SINGLETON_LOD_POWER));
        var fadeSpan = Math.max(1, Math.ceil(total * SINGLETON_LOD_FADE_RANGE));
        rankList.forEach(function (item, rank) {
            var op;
            if (rank < visibleCount) {
                op = SINGLETON_LABEL_BASE_OPACITY;
            } else if (rank < visibleCount + fadeSpan) {
                var t = (rank - visibleCount) / fadeSpan;
                op = SINGLETON_LABEL_BASE_OPACITY * (1 - t);
            } else {
                op = 0;
            }
            d3.select(item.el).style('opacity', op);
        });
    }

    // Rethink R5: SC membership = a small screen-constant color marker
    // before the label's first line. The geometric pill discs painted
    // ~230px circles with 10px text at near zoom and their raw
    // clusterColor fill made arbitrary topics scream (palette luck).
    function applySCMarker(g, textEl) {
        var bbox;
        try { bbox = textEl.node().getBBox(); } catch (e) { return; }
        if (!bbox || !bbox.width) return;
        var d = g.datum();
        // Same clamped factor the text's font-size carries, so the marker
        // stays screen-constant alongside its label. The x/y offsets carry
        // it too — a fixed world offset shrinks on screen while the radius
        // holds, which made the marker graze its own text bbox at moderate
        // zooms (verify caught ~0.5px intrusions across every SC label).
        var s = clampedScale(currentZoomK, 'scLabel');
        g.select('circle.hull-label-marker').remove();
        g.insert('circle', 'text.hull-label')
            .attr('class', 'hull-label-marker')
            .attr('cx', bbox.x - 8 * s)
            .attr('cy', bbox.y + Math.min(bbox.height, 12 * s) / 2 + 2 * s)
            .attr('r', 4 * s)
            .attr('fill', clusterColor(d.cluster.id))
            .attr('pointer-events', 'none');
    }

    // ── Draw hulls ──────────────────────────────────────────────────

    // Painted gap between a group caption's baseline and the topmost member
    // node, in screen px (scaled alongside the caption font).
    var GROUP_LABEL_GAP = 14;

    function groupLabelText(d) {
        // "▸/▾" is the expand/collapse affordance — nothing else signals
        // the caption is clickable (design audit §2.5).
        if (!d.collapsed) return '▾ ' + d.label;
        var counts = d.members.length >= 2
            ? d.members.length + ' topics · ' + d.pages + 'p'
            : d.pages + 'p';
        return '▸ ' + d.label + ' (' + counts + ')';
    }

    function drawGroupLabels(root, clusters, nodes) {
        // One caption per casual/binge group (batch C C1). Collapsed: the
        // only label over the dense mass, "▸ label (N topics · Mp)", click
        // to expand. Expanded: "▾ label" header above the members, click to
        // collapse back. Recurrent/declared groups never collapse and get
        // no group caption — their members keep normal cluster labels.
        //
        // Captions are screen-constant (SCALE_THRESHOLDS.groupLabel) and
        // render in the UI sans (theme.css .group-label); the decorative
        // constellation font is reserved for supercluster names. The old
        // geometric 15px attr painted at ~8px at fit zoom — unreadable by
        // construction (design audit §2).
        var byGroup = {};
        clusters.forEach(function (c) {
            if (c.group_id == null) return;
            if (c.group_tier !== 'casual' && c.group_tier !== 'binge') return;
            if (!byGroup[c.group_id]) {
                byGroup[c.group_id] = {
                    id: c.group_id, label: c.group_label || 'group',
                    tier: c.group_tier, members: [], pages: 0,
                };
            }
            byGroup[c.group_id].members.push(c);
            byGroup[c.group_id].pages += (c.page_ids || []).length;
        });
        // Single-cluster groups caption too — an unlabeled collapsed clump
        // reads as noise (7 of skaniti's 8 collapsed groups had no caption).
        var data = Object.keys(byGroup).map(function (k) { return byGroup[k]; });
        if (!data.length) return;

        var nodePos = {};
        nodes.forEach(function (n) { if (n.x != null) nodePos[n.id] = n; });
        var groupScale = clampedScale(currentZoomK, 'groupLabel');
        data.forEach(function (g) {
            var sx = 0, cnt = 0, minY = Infinity;
            g.members.forEach(function (c) {
                (c.page_ids || []).forEach(function (pid) {
                    var n = nodePos[pid];
                    if (n) { sx += n.x; cnt++; if (n.y < minY) minY = n.y; }
                });
            });
            g.x = cnt ? sx / cnt : 0;
            g.minY = (minY === Infinity ? 0 : minY);
            g.y = g.minY - GROUP_LABEL_GAP * groupScale;
            g.collapsed = !expandedGroups[g.id];
        });

        root.select('.hull-labels').selectAll('g.group-label-group')
            .data(data, function (d) { return d.id; })
            .enter().append('g')
            .attr('class', function (d) {
                return 'group-label-group' + (d.collapsed ? '' : ' expanded');
            })
            .attr('cursor', 'pointer')
            .style('pointer-events', 'bounding-box')
            .on('click', function (event, d) {
                event.stopPropagation();
                toggleGroupExpansion(d.id, !expandedGroups[d.id]);
            })
            .on('mouseenter', function (event, d) {
                showLinesTooltip(event, [d.label,
                    d.members.length + ' topics · ' + d.pages + 'p']);
            })
            .on('mouseleave', hideTooltip)
            .append('text')
            .attr('class', 'group-label')
            .attr('x', function (d) { return d.x; })
            .attr('y', function (d) { return d.y; })
            .attr('data-group-min-y', function (d) { return d.minY; })
            .attr('text-anchor', 'middle')
            // .style, not .attr — CSS rules would override the attribute
            .style('font-size',
                   (BASE_GROUP_LABEL_FONT_SIZE * groupScale) + 'px')
            .text(groupLabelText);

        positionGroupCaptions(currentZoomK);
    }

    function drawHulls(root, nodes, clusters) {
        var hullData = clusters.map(function (cluster) {
            var pageSet = {};
            cluster.page_ids.forEach(function (pid) { pageSet[pid] = true; });
            var points = nodes
                .filter(function (n) { return pageSet[n.id] && n.x != null; })
                .map(function (n) { return [n.x, n.y]; });
            return { cluster: cluster, points: points };
        }).filter(function (d) { return d.points.length >= 2; });

        // Hull boundary rendering commented out — may bring back with different styling
        // root.select('.hulls').selectAll('path.hull')
        //     .data(hullData, function (d) { return d.cluster.id; })
        //     .enter().append('path')
        //     .attr('class', 'hull')
        //     .attr('d', function (d) { return paddedHullPath(d.points, HULL_PADDING); })
        //     .attr('fill', function (d) { return clusterColor(d.cluster.id); })
        //     .attr('fill-opacity', HULL_OPACITY)
        //     .attr('stroke', function (d) { return clusterColor(d.cluster.id); })
        //     .attr('stroke-opacity', HULL_STROKE_OPACITY)
        //     .attr('stroke-width', 1.5)
        //     .attr('cursor', 'pointer')
        //     .on('click', function (event, d) { event.stopPropagation(); selectCluster(d.cluster); });

        // Wrapped labels with glow hover. Collapsed-group members suppress
        // their per-cluster labels (unreadable at pack density); the single
        // group label from drawGroupLabels stands in for the whole mass.
        var labelData = hullData.filter(function (d) {
            return !isCollapsedCluster(d.cluster);
        });
        var labelGroups = root.select('.hull-labels').selectAll('g.hull-label-group')
            .data(labelData, function (d) { return d.cluster.id; })
            .enter().append('g')
            .attr('class', 'hull-label-group')
            .style('pointer-events', 'bounding-box')
            .attr('cursor', 'pointer')
            .on('click', function (event, d) { event.stopPropagation(); selectCluster(d.cluster, { frame: true }); });

        // Compute initial label positions (centroid x, top of cluster y)
        var labelPositions = [];
        labelData.forEach(function (d) {
            // Horizontal anchor = centroid x
            var lx = 0;
            d.points.forEach(function (p) { lx += p[0]; });
            lx /= d.points.length;
            // Vertical anchor tracks the ACTUAL cluster top. Using the
            // 10th-percentile y-value (instead of minY) stays close to the
            // visible cluster mass while ignoring lone outlier nodes that
            // Phase 2 sometimes spreads far above the centroid.
            var ys = d.points.map(function (p) { return p[1]; })
                              .sort(function (a, b) { return a - b; });
            var effectiveTop = ys[Math.floor(ys.length * 0.1)];
            var LABEL_TO_CLUSTER_GAP = 16;  // px from label bottom to cluster top
            var name = d.cluster.name || d.cluster.id || '';
            var words = name.split(/\s+/);
            var lines = [], cur = '';
            // Rethink R5: pill retired, so wrap width no longer needs to
            // fit inside a fixed-radius circle — flat limit for all labels.
            var isSC = !!d.cluster.super_cluster;
            var WRAP_LIMIT = 18;
            for (var w = 0; w < words.length; w++) {
                if (cur.length + words[w].length + 1 > WRAP_LIMIT && cur.length > 0) { lines.push(cur); cur = words[w]; }
                else { cur = cur ? cur + ' ' + words[w] : words[w]; }
            }
            if (cur) lines.push(cur);
            var lineH = 12;
            // For collision math: SC pills are circles of fixed radius, so
            // their AABB is a square 2*r on a side regardless of text width.
            // Non-SC labels still size to their text bbox.
            var maxLineLen = 0;
            lines.forEach(function (l) { if (l.length > maxLineLen) maxLineLen = l.length; });
            var estW = isSC ? 2 * SC_PILL_RADIUS : maxLineLen * 6;
            var estH = isSC ? 2 * SC_PILL_RADIUS : lines.length * lineH;
            // Anchor by the label's BOTTOM, not its center. For the rendered
            // text (see line ~1438): pos.y is the vertical center of the
            // tspan stack, so to pin the BOTTOM of the last line at
            // effectiveTop - LABEL_TO_CLUSTER_GAP we solve:
            //   last_tspan_baseline = effectiveTop - gap - descent(≈2px)
            //   last_tspan_baseline = pos.y + (L-1) * lineH/2
            //   ⇒  pos.y = effectiveTop - gap - 2 - (L-1) * (lineH/2)
            // This means wrapped (multi-line) labels grow UPWARD from the
            // cluster instead of being centered around a fixed anchor —
            // so the gap between cluster top and label bottom stays constant.
            var anchorY = effectiveTop - LABEL_TO_CLUSTER_GAP - 2 - (lines.length - 1) * (lineH / 2);
            labelPositions.push({
                datum: d,
                x: lx, y: anchorY,
                anchorX: lx, anchorY: anchorY,
                w: estW, h: estH,
                lines: lines, lineH: lineH,
                clusterTopY: effectiveTop,   // consumed by updateLabelScale on zoom
            });
        });

        // ── Watermark no-go zones (projection illusion is binary) ────
        // Any label overlapping a watermark + SC-name bbox must be ejected.
        // Collected here so the AABB loop below treats them as static
        // obstacles, then enforced as a hard post-loop pass.
        var watermarkBBoxes = [];

        // ── Radial label push from super-cluster centroid ────────────
        // Direction: SC centroid → cluster centroid (from node positions).
        // Each label is placed along that ray at a jittered distance.
        // This fans labels outward in the direction of their parent cluster
        // (per the wireframe: direction follows the cluster, not the label).

        var superClusters = currentData && currentData.super_clusters || [];
        if (superClusters.length > 0) {
            var scGroups = {};
            labelPositions.forEach(function (lp) {
                var sc = lp.datum.cluster.super_cluster;
                if (sc) {
                    if (!scGroups[sc]) scGroups[sc] = [];
                    scGroups[sc].push(lp);
                }
            });

            // Compute centroids from actual node positions
            var allClusterCentroids = computeClusterCentroids(clusters, nodes);

            // SC centroid = average of ALL SC members' cluster centroids.
            // MUST match drawWatermarks' calculation (which uses all members)
            // so the watermark no-go bbox aligns with where the watermark is
            // actually drawn. Using scGroups (labelData-filtered, >=2 pages)
            // would skew the centroid toward members with more pages —
            // historically caused a 100+px mismatch and hard-eject overshoots.
            var scCentroids = {};
            var scFullGroups = {};
            clusters.forEach(function (c) {
                if (!c.super_cluster) return;
                if (!scFullGroups[c.super_cluster]) scFullGroups[c.super_cluster] = [];
                scFullGroups[c.super_cluster].push(c);
            });
            for (var scKey in scFullGroups) {
                var fullMembers = scFullGroups[scKey];
                var cx = 0, cy = 0, cnt = 0;
                fullMembers.forEach(function (c) {
                    var cc = allClusterCentroids[c.id];
                    if (cc) { cx += cc.x; cy += cc.y; cnt++; }
                });
                if (cnt > 0) scCentroids[scKey] = { x: cx / cnt, y: cy / cnt };
            }

            // Populate watermark no-go zones using the same SC centroids.
            for (var wscKey in scCentroids) {
                watermarkBBoxes.push(
                    computeWatermarkBBox(wscKey, scCentroids[wscKey])
                );
            }

            // ── RADIAL ANCHOR for SC member pills ─────────────────
            // Override the N-anchor (computed above for all clusters) with
            // a position OUTSIDE each SC-member cluster on the side AWAY
            // from the SC center. Routes pills out of the watermark zone
            // by construction — the eject and the spring agree everywhere
            // instead of fighting on the south side (which was the failure
            // mode of the all-clusters-anchor-north policy).
            //
            // Geometry per cluster:
            //   u  = normalize(cluster_centroid - SC_centroid)
            //   r  = max projection of any cluster node onto u (outer edge)
            //   lh = abs(ux)*w/2 + abs(uy)*h/2  (label half-extent on u)
            //   anchor = cluster_centroid + u * (r + GAP + lh)
            //
            // Fallback: when |cluster - SC| is below MIN_RADIAL_DIST the
            // direction is dominated by node-jitter noise; keep the
            // N-anchor those clusters already inherited (rare; happens
            // for solo-SCs and very compact super-clusters).
            var MIN_RADIAL_DIST = 25;  // px
            var RADIAL_GAP = 14;       // px between cluster outer edge and label
            labelPositions.forEach(function (lp) {
                var sc = lp.datum.cluster.super_cluster;
                if (!sc) return;
                var scC = scCentroids[sc];
                var ccent = allClusterCentroids[lp.datum.cluster.id];
                if (!scC || !ccent) return;
                var dxr = ccent.x - scC.x;
                var dyr = ccent.y - scC.y;
                var distR = Math.sqrt(dxr * dxr + dyr * dyr);
                if (distR < MIN_RADIAL_DIST) return;  // keep N-anchor
                var ux = dxr / distR;
                var uy = dyr / distR;
                // Cluster outer extent along u = max projection of any
                // node onto u, plus node radius.
                var rmax = 0;
                lp.datum.points.forEach(function (p) {
                    var px = p[0] - ccent.x;
                    var py = p[1] - ccent.y;
                    var proj = px * ux + py * uy;
                    if (proj > rmax) rmax = proj;
                });
                rmax += NODE_RADIUS;
                // SC pills are circles of fixed radius (SC_PILL_RADIUS),
                // so the half-extent along ANY direction u is just the
                // radius — i.e., lp.w / 2 (since lp.w = 2 * SC_PILL_RADIUS
                // for SC members per the labelPositions setup).
                var labelHalf = lp.w / 2;
                var anchorDist = rmax + RADIAL_GAP + labelHalf;
                lp.anchorX = ccent.x + ux * anchorDist;
                lp.anchorY = ccent.y + uy * anchorDist;
                lp.x = lp.anchorX;
                lp.y = lp.anchorY;
            });
        }

        // AABB collision avoidance (all labels)
        // Label placement policy (post shrinkwrap-pill rewrite):
        //   • All labels (SC pills AND non-SC) are PINNED to their shrinkwrap
        //     anchor (centroid-x, 10th-percentile-top-y - gap). Spring 1.0
        //     snaps them back every iteration.
        //   • Label-label collision push still runs, but the 1.0 spring
        //     effectively cancels it within one iter — collisions are
        //     deferred work (see plan: "worry about collisions later").
        //   • Watermarks are static obstacles — pushed away from by ALL labels
        //     during the loop, then hard-ejected post-loop.
        var LABEL_ITERS = 80;
        var WATERMARK_PUSH_STR = 0.9;  // stronger than any label-label push
        for (var li = 0; li < LABEL_ITERS; li++) {
            for (var ai = 0; ai < labelPositions.length; ai++) {
                var a = labelPositions[ai];
                var aIsPill = !!a.datum.cluster.super_cluster;
                for (var bi = ai + 1; bi < labelPositions.length; bi++) {
                    var b = labelPositions[bi];
                    var bIsPill = !!b.datum.cluster.super_cluster;
                    // Skip entirely if neither is a pill — both are pinned.
                    if (!aIsPill && !bIsPill) continue;
                    var pad = 6;
                    var overlapX = (a.w / 2 + b.w / 2 + pad) - Math.abs(a.x - b.x);
                    var overlapY = (a.h / 2 + b.h / 2 + pad) - Math.abs(a.y - b.y);
                    if (overlapX > 0 && overlapY > 0) {
                        var dx2 = a.x - b.x || 0.1;
                        var dy2 = a.y - b.y || 0.1;
                        var len = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
                        var pushX = (overlapX / 2 + 1) * (dx2 / len);
                        var pushY2 = (overlapY / 2 + 1) * (dy2 / len);
                        if (aIsPill && bIsPill) {
                            // Share the push 50/50
                            a.x += pushX * 0.7;  a.y += pushY2 * 0.7;
                            b.x -= pushX * 0.7;  b.y -= pushY2 * 0.7;
                        } else if (aIsPill && !bIsPill) {
                            // Pill 'a' absorbs full push; non-SC 'b' stays planted
                            a.x += pushX * 1.1;  a.y += pushY2 * 1.1;
                        } else {
                            // bIsPill && !aIsPill — mirror of above
                            b.x -= pushX * 1.1;  b.y -= pushY2 * 1.1;
                        }
                    }
                }

                // Push label out of any watermark no-go zone.
                // Uses rectRectOverlap; direction is always "away from watermark center".
                for (var wi = 0; wi < watermarkBBoxes.length; wi++) {
                    var wm = watermarkBBoxes[wi];
                    var aBox = {
                        minX: a.x - a.w / 2, maxX: a.x + a.w / 2,
                        minY: a.y - a.h / 2, maxY: a.y + a.h / 2,
                    };
                    var wmHit = rectRectOverlap(aBox, wm, 0);
                    if (wmHit.overlap) {
                        // Separate along the shorter axis of penetration.
                        var lenW = Math.sqrt(wmHit.dx * wmHit.dx + wmHit.dy * wmHit.dy) || 1;
                        var pushAx, pushAy;
                        if (wmHit.overlapX < wmHit.overlapY) {
                            pushAx = (wmHit.overlapX + 1) * (wmHit.dx / lenW);
                            pushAy = 0;
                        } else {
                            pushAx = 0;
                            pushAy = (wmHit.overlapY + 1) * (wmHit.dy / lenW);
                        }
                        a.x += pushAx * WATERMARK_PUSH_STR;
                        a.y += pushAy * WATERMARK_PUSH_STR;
                    }
                }

                // Spring 1.0: both pills and non-SC labels snap back to their
                // shrinkwrap anchor every iteration. Watermark ejection is
                // handled by the hard-eject pass below.
                var springStr = 1.0;
                a.x += (a.anchorX - a.x) * springStr;
                a.y += (a.anchorY - a.y) * springStr;
            }
        }

        // Hard-eject pass: any label still overlapping a watermark bbox after
        // the AABB loop gets teleported outward along the shortest-axis ray
        // until fully clear. The projection illusion is binary — soft push
        // is best-effort; this is the invariant enforcement.
        for (var hi = 0; hi < labelPositions.length; hi++) {
            var lp = labelPositions[hi];
            for (var wi2 = 0; wi2 < watermarkBBoxes.length; wi2++) {
                var wm2 = watermarkBBoxes[wi2];
                var safety = 20;
                while (safety-- > 0) {
                    var lpBox = {
                        minX: lp.x - lp.w / 2, maxX: lp.x + lp.w / 2,
                        minY: lp.y - lp.h / 2, maxY: lp.y + lp.h / 2,
                    };
                    var hit = rectRectOverlap(lpBox, wm2, 2);
                    if (!hit.overlap) break;
                    var lenH = Math.sqrt(hit.dx * hit.dx + hit.dy * hit.dy) || 1;
                    if (hit.overlapX < hit.overlapY) {
                        lp.x += (hit.overlapX + 2) * (hit.dx / lenH);
                    } else {
                        lp.y += (hit.overlapY + 2) * (hit.dy / lenH);
                    }
                }
            }
        }

        // Render-time pill ring override retired: pills now use the
        // shrinkwrap anchors set up above (centroid-x, top-y). Cluster ring
        // placement lives in Phase 1.5a; label positions follow page nodes.
        labelGroups.each(function (d, idx) {
            var pos = labelPositions[idx];
            var el = d3.select(this).append('text')
                .attr('class', 'hull-label')
                .attr('text-anchor', 'middle')
                .attr('font-size', '10px')
                .attr('font-weight', '600')
                .attr('pointer-events', 'none')
                .attr('opacity', 0.7)
                .attr('fill', labelColor(clusterColor(d.cluster.id)))
                .style('transition', 'opacity 0.15s ease')
                // Store layout meta for updateLabelScale to reposition tspans
                // when font-size changes with zoom.
                .attr('data-cluster-top-y', pos.clusterTopY != null ? pos.clusterTopY : pos.y)
                .attr('data-line-count', pos.lines.length)
                // For SC pills: store the RADIAL anchor center so updateLabelScale
                // can re-center tspans without applying the N-anchor formula
                // (which would yank the pill north of its cluster).
                .attr('data-anchor-y', pos.anchorY != null ? pos.anchorY : pos.y);

            var startY = pos.y - (pos.lines.length - 1) * pos.lineH / 2;
            for (var li2 = 0; li2 < pos.lines.length; li2++) {
                el.append('tspan')
                    .attr('x', pos.x)
                    .attr('y', startY + li2 * pos.lineH)
                    .text(pos.lines[li2]);
            }
        });

        // Super-cluster (and SC-like, e.g. _unclustered) labels: add a
        // small screen-constant color marker before the first line so they
        // read as a deliberate grouping rather than a plain cluster caption
        // (rethink R5 — see applySCMarker for the pill-disc retirement rationale).
        labelGroups.each(function (d) {
            if (!isSuperClusterLike(d.cluster)) return;
            var g = d3.select(this);
            var textEl = g.select('text.hull-label');
            if (textEl.empty()) return;

            applySCMarker(g, textEl);
            textEl.attr('fill', labelColor(clusterColor(d.cluster.id))).attr('opacity', 0.95);
        });

        // Hover: debounced glow + dim (avoids flicker on quick mouse-overs)
        var hoverTimer = null;
        labelGroups.on('mouseenter', function (event, d) {
            var self = this;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(function () {
                var hoveredId = d.cluster.id;
                // Glow hovered label
                d3.select(self).select('text.hull-label')
                    .attr('opacity', 1).attr('filter', 'url(#label-glow)');
                // Rethink R2.4: brighten the hovered cluster, dim only its
                // own SC's sibling labels. The global 0.3 dim belongs to
                // SELECTION (updateHighlighting), not hover — hovering used
                // to darken the whole canvas with no findable focus.
                var pageIds = {};
                (d.cluster.page_ids || []).forEach(function (pid) { pageIds[pid] = true; });
                svg.selectAll('use.star-spikes')
                    .filter(function (n) { return pageIds[n.id]; })
                    .attr('opacity', 1);
                var hoveredSC = d.cluster.super_cluster || null;
                svg.selectAll('g.hull-label-group').each(function (other) {
                    if (other.cluster.id === hoveredId) return;
                    if (hoveredSC && other.cluster.super_cluster === hoveredSC) {
                        d3.select(this).select('text.hull-label').attr('opacity', 0.6);
                    }
                });
            }, 150);
        }).on('mouseleave', function () {
            clearTimeout(hoverTimer);
            d3.select(this).select('text.hull-label')
                .attr('opacity', 0.7).attr('filter', null);
            // Restore: if click selection active, defer to it; otherwise reset all
            if (selectedNodeId || selectedClusterId || selectedSessionId || (selectedNodeIds && selectedNodeIds.length)) {
                updateHighlighting();
            } else {
                // Restore glyph opacity via the shared muted formula (same
                // one the render chain uses) — NOT a flat 1, since resting
                // state is visit-count-scaled and muted by 0.8.
                svg.selectAll('use.star-spikes').attr('opacity', starGlyphOpacity);
                svg.selectAll('g.hull-label-group').each(function () {
                    d3.select(this).select('text.hull-label').attr('opacity', 0.7);
                });
            }
        });
    }

    // ── Draw links between cluster centroids ─────────────────────────

    function drawClusterLinks(root, linkSel, nodes, clusters) {
        var centroids = computeClusterCentroids(clusters, nodes);
        linkSel
            .attr('x1', function (d) { var c = centroids[d.source]; return c ? c.x : 0; })
            .attr('y1', function (d) { var c = centroids[d.source]; return c ? c.y : 0; })
            .attr('x2', function (d) { var c = centroids[d.target]; return c ? c.x : 0; })
            .attr('y2', function (d) { var c = centroids[d.target]; return c ? c.y : 0; })
            .attr('display', function (d) { return (centroids[d.source] && centroids[d.target]) ? null : 'none'; });
    }

    // ── Selection ────────────────────────────────────────────────────

    function selectNode(d) {
        selectedNodeId = d.id; selectedClusterId = null; selectedSessionId = null; selectedNodeIds = null;
        writeTapStore({ id: d.id, label: d.label, type: 'node' });
        updateHighlighting();
    }

    function selectCluster(cluster, opts) {
        selectedClusterId = cluster.id; selectedNodeId = null; selectedSessionId = null; selectedNodeIds = null;
        writeTapStore({ id: cluster.id, label: cluster.name, type: 'cluster', page_ids: cluster.page_ids });
        updateHighlighting();
        if (opts && opts.frame) {
            frameWorldBBox(clusterWorldBBox(cluster), { minRatio: 1.6, maxRatio: 2.0 });
        }
    }

    function clearSelection() {
        selectedNodeId = null; selectedClusterId = null; selectedSessionId = null; selectedNodeIds = null;
        writeTapStore(null); updateHighlighting();
    }

    function updateHighlighting() {
        if (!svg || !currentData) return;
        var highlightIds = {};
        if (selectedNodeId) {
            var node = currentData.nodes.find(function (n) { return n.id === selectedNodeId; });
            if (node && node.parent_id) {
                currentData.nodes.forEach(function (n) {
                    if (n.parent_id === node.parent_id) highlightIds[n.id] = true;
                });
            } else { highlightIds[selectedNodeId] = true; }
        } else if (selectedClusterId) {
            var cluster = currentData.clusters.find(function (c) { return c.id === selectedClusterId; });
            if (cluster) cluster.page_ids.forEach(function (pid) { highlightIds[pid] = true; });
        } else if (selectedNodeIds && selectedNodeIds.length > 0) {
            selectedNodeIds.forEach(function (nid) { highlightIds[nid] = true; });
        } else if (selectedSessionId) {
            currentData.nodes.forEach(function (n) {
                if (n.session_ids && n.session_ids.indexOf(selectedSessionId) >= 0) {
                    highlightIds[n.id] = true;
                }
            });
        }
        var has = Object.keys(highlightIds).length > 0;
        svg.selectAll('circle.page')
            .attr('opacity', function (d) { return has ? (highlightIds[d.id] ? 1 : 0.15) : 1; })
            .attr('r', function (d) {
                var r = pageDotRadius(d, currentZoomK);
                return d.id === selectedNodeId ? r * 1.8 : r;
            });

        // Glyph-layer selection emphasis (T7 review fix): the R2.4 hover
        // handler only brightens a hovered cluster's stars and defers to
        // updateHighlighting on mouseleave when a selection is active —
        // but until this call was added, nothing here ever touched
        // use.star-spikes, so a hovered-then-abandoned glyph stayed stuck
        // at opacity 1. This is also where the Task-8 selection semantics
        // belong: member stars bright, rest dimmed. The R4 selection dim
        // lives here, NOT on hover.
        svg.selectAll('use.star-spikes')
            .attr('opacity', function (d) {
                if (!has) return starGlyphOpacity(d);
                return highlightIds[d.id] ? 1 : 0.15;
            });

        // Build set of related cluster IDs (clusters containing highlighted nodes)
        var relatedClusters = {};
        if (has) {
            currentData.clusters.forEach(function (c) {
                var match = c.page_ids.some(function (pid) { return highlightIds[pid]; });
                if (match) relatedClusters[c.id] = true;
            });
        }

        // Dim unrelated cluster labels — dim, don't delete (design audit
        // §4.5): 0.1 text over a full-strength marker read as anonymous
        // color blobs; 0.35 keeps neighbors legible for orientation, and
        // the marker dims WITH its text so the pair stays coherent.
        svg.selectAll('g.hull-label-group').each(function (d) {
            var g = d3.select(this);
            var text = g.select('text.hull-label');
            var marker = g.select('.hull-label-marker');
            if (!has) {
                text.attr('opacity', 0.7);
                if (!marker.empty()) marker.attr('opacity', 0.95);
            } else {
                var related = relatedClusters[d.cluster.id];
                text.attr('opacity', related ? 1 : 0.35);
                if (!marker.empty()) marker.attr('opacity', related ? 0.95 : 0.3);
            }
            // Rethink R4.1: the selected cluster's label glows so a click's
            // result is visible even after the camera settles -- selection
            // isn't just a data-store write, it's a findable thing on screen.
            text.attr('filter', d.cluster.id === selectedClusterId ? 'url(#label-glow)' : null);
        });

        // Dim unrelated cluster links
        svg.selectAll('line.cluster-link')
            .attr('stroke-opacity', function (d) {
                if (!has) return LINK_OPACITY;
                return (relatedClusters[d.source] || relatedClusters[d.target]) ? LINK_OPACITY : 0.03;
            });

        // Dim unrelated nebula clouds
        svg.selectAll('path.nebula-cloud')
            .attr('opacity', function (d) {
                if (!has) return 1;
                var mids = d.memberIds || [d.clusterId];
                for (var i = 0; i < mids.length; i++) {
                    if (relatedClusters[mids[i]]) return 1;
                }
                return 0.15;
            });
    }

    // ── Tooltip ──────────────────────────────────────────────────────
    //
    // Two content modes share the #node-tooltip card (visual styling in
    // style.css .node-tooltip):
    //   showTooltip      — rich per-page card: icon+title row / domain /
    //                      stat line / page-cluster-supercluster granularity
    //                      table (cells stay in place, dim dash when a
    //                      level is absent — no flavor text).
    //                      DOM is built with createElement + textContent
    //                      only: page titles are untrusted web content.
    //   showLinesTooltip — plain joined lines for SC watermarks, group
    //                      captions, and knot-hit targets (nt-lines class
    //                      restores pre-line whitespace).
    // 2026-07-16 redesign replaced the old URL-slug lines, which for wiki
    // pages were near-copies of the title itself (three redundant lines
    // per card); the hostname is the only informative bit of the URL the
    // label doesn't already carry.

    var lastTipNodeId = null;   // rebuild page-card DOM only on node change

    function tipHostnames(urls) {
        var seen = [];
        (urls || []).forEach(function (u) {
            var h;
            try { h = new URL(u).hostname.replace(/^www\./, ''); }
            catch (e) { return; }
            if (h && seen.indexOf(h) < 0) seen.push(h);
        });
        return seen;
    }

    // Strip a trailing "- Wikipedia"-style site suffix, but only when it
    // matches one of the page's own hostnames — never guess.
    function tipCleanTitle(label, hosts) {
        var m = /^(.*?)\s*[-–—|·]\s*([^-–—|·]+)$/.exec(label || '');
        if (!m || m[1].length < 3) return label;
        var tail = m[2].trim().toLowerCase().replace(/\s+/g, '');
        if (!tail) return label;
        for (var i = 0; i < hosts.length; i++) {
            if (hosts[i].toLowerCase().indexOf(tail) >= 0) return m[1];
        }
        return label;
    }

    function tipRelTime(iso) {
        if (!iso) return null;
        var then = Date.parse(iso);
        if (isNaN(then)) return null;
        var days = Math.floor((Date.now() - then) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 14) return days + ' days ago';
        if (days < 61) return Math.round(days / 7) + ' wk ago';
        if (days < 700) return Math.round(days / 30.44) + ' mo ago';
        return Math.round(days / 365.25) + ' yr ago';
    }

    // Where the page "lives": cluster + constellation membership, nulls
    // where the page has none (singleton/unclustered) — the tooltip table
    // shows absence itself; no flavor text.
    function pageTipHome(d) {
        var none = { cluster: null, sc: null, icon: null };
        if (!d.parent_id || d.kind === 'singleton' || d.kind === 'unclustered') return none;
        var cs = (currentData && currentData.clusters) || [];
        for (var i = 0; i < cs.length; i++) {
            if (cs[i].id === d.parent_id) {
                return {
                    cluster: cs[i].name || null,
                    sc: cs[i].super_cluster || null,
                    icon: cs[i].super_cluster_icon || null,
                };
            }
        }
        return none;
    }

    function buildPageTip(tip, d) {
        tip.textContent = '';
        tip.classList.remove('nt-lines');
        var hosts = tipHostnames(d.page_urls);
        var home = pageTipHome(d);

        var titleRow = document.createElement('div');
        titleRow.className = 'nt-title-row';
        var iconDef = home.icon && __mountedIcons
            && __mountedIcons[home.icon];  // was window.__superClusterIcons (header comment delta #5)
        if (iconDef) {
            // The constellation's own watermark icon, from the same
            // manifest the canvas draws from.
            var svgNS = 'http://www.w3.org/2000/svg';
            var iconSvg = document.createElementNS(svgNS, 'svg');
            iconSvg.setAttribute('class', 'nt-sc-icon');
            iconSvg.setAttribute('viewBox', iconDef.viewBox || '0 0 24 24');
            iconSvg.setAttribute('aria-label', home.sc || '');
            iconDef.paths.forEach(function (pd) {
                var p = document.createElementNS(svgNS, 'path');
                p.setAttribute('d', pd);
                p.setAttribute('vector-effect', 'non-scaling-stroke');
                iconSvg.appendChild(p);
            });
            titleRow.appendChild(iconSvg);
        }
        var title = document.createElement('div');
        title.className = 'nt-title';
        title.textContent = tipCleanTitle(d.label, hosts);
        titleRow.appendChild(title);
        tip.appendChild(titleRow);

        if (hosts.length) {
            var domain = document.createElement('div');
            domain.className = 'nt-meta';
            domain.textContent = hosts.length > 1
                ? hosts[0] + ' +' + (hosts.length - 1) + ' more'
                : hosts[0];
            tip.appendChild(domain);
        }

        var bits = [];
        var v = d.visit_count || 1;
        bits.push(v + (v === 1 ? ' visit' : ' visits'));
        var caps = (d.capture_ids || []).length;
        if (caps > 1) bits.push(caps + ' captures');
        var rel = tipRelTime(d.first_visited_at);
        if (rel) bits.push((v > 1 ? 'first visited ' : 'visited ') + rel);
        var meta = document.createElement('div');
        meta.className = 'nt-meta';
        meta.textContent = bits.join(' · ');
        tip.appendChild(meta);

        // Granularity table: PAGE | CLUSTER | SUPERCLUSTER. Cells stay in
        // place when empty (dim dash) — absence is the at-a-glance signal
        // for how deep this page sits in the hierarchy.
        var grid = document.createElement('div');
        grid.className = 'nt-grid';
        ['page', 'cluster', 'supercluster'].forEach(function (h) {
            var th = document.createElement('div');
            th.className = 'nt-th';
            th.textContent = h;
            grid.appendChild(th);
        });
        [title.textContent, home.cluster, home.sc].forEach(function (val) {
            var td = document.createElement('div');
            td.className = 'nt-td' + (val ? '' : ' nt-empty');
            td.textContent = val || '—';
            grid.appendChild(td);
        });
        tip.appendChild(grid);
    }

    // Cursor-relative placement with viewport clamping: flip to the other
    // side of the cursor instead of running off the right/bottom edge.
    // Must run AFTER content + display:block so offsetWidth/Height are real.
    function positionTooltip(tip, event) {
        var pad = 8;
        var x = event.pageX + TOOLTIP_OFFSET;
        var y = event.pageY + TOOLTIP_OFFSET;
        if (x + tip.offsetWidth + pad > window.innerWidth) {
            x = event.pageX - TOOLTIP_OFFSET - tip.offsetWidth;
        }
        if (y + tip.offsetHeight + pad > window.innerHeight) {
            y = event.pageY - TOOLTIP_OFFSET - tip.offsetHeight;
        }
        tip.style.left = Math.max(pad, x) + 'px';
        tip.style.top = Math.max(pad, y) + 'px';
    }

    function showTooltip(event, d) {
        if (!SANDBOX_SECTION_GATES.tooltip) return;  // S2 sandbox-bar gate (header comment delta #8)
        var tip = document.getElementById('node-tooltip');
        if (!tip) return;
        // updateArmedDot calls this on every mousemove while armed; only
        // rebuild the card when the hovered node actually changes.
        if (lastTipNodeId !== d.id) {
            buildPageTip(tip, d);
            lastTipNodeId = d.id;
        }
        tip.style.display = 'block';
        positionTooltip(tip, event);
    }

    function hideTooltip() {
        if (!SANDBOX_SECTION_GATES.tooltip) return;  // S2 sandbox-bar gate (header comment delta #8)
        var tip = document.getElementById('node-tooltip');
        if (tip) tip.style.display = 'none';
        lastTipNodeId = null;
    }

    // Rethink R2.5: shared card-style tooltip for SC watermarks, group
    // captions, and knot-hit targets — plain joined lines, no visit/session
    // page-derived fields (those are showTooltip's per-page concern).
    function showLinesTooltip(event, lines) {
        if (!SANDBOX_SECTION_GATES.tooltip) return;  // S2 sandbox-bar gate (header comment delta #8)
        var tip = document.getElementById('node-tooltip');
        if (!tip) return;
        lastTipNodeId = null;
        tip.classList.add('nt-lines');
        tip.textContent = lines.join('\n');
        tip.style.display = 'block';
        positionTooltip(tip, event);
    }

    function writeTapStore(value) {
        // was: window.dash_clientside.set_props('d3-tap-node', {data: value})
        // (header comment delta #3) -- now calls opts.onSelect(kind, id).
        if (typeof __onSelectCallback === 'function') {
            __onSelectCallback(value ? value.type : null, value ? value.id : null);
        }
    }

    // ── Palette observer ─────────────────────────────────────────────
    //
    // Recolor the live graph when the theme/palette changes. Two guards here
    // (plus a source-side guard in app.py) prevent the 2026-06-11 loading-hang
    // storm, where this observer's callback was the profiler's hot path:
    //
    //   1. ONE observer for the page lifetime. It was previously re-created on
    //      every __d3GraphRender (see boot, below) with NO disconnect, so each
    //      re-render leaked another observer on #dynamic-theme-css and every
    //      theme write then fired ALL of them. The callback reads the
    //      module-level `currentData`/`svg` by reference, so a single
    //      persistent observer stays correct across re-renders.
    //   2. requestAnimationFrame-coalesced. The recolor runs assignClusterColors
    //      (O(clusters^2)) + a full SVG repaint; on the 744-cluster account a
    //      burst of style mutations turned that into a main-thread storm that
    //      kept the loader curtain up and grew working-set via repeated paints
    //      (JS heap stayed flat). Coalescing caps it at one recolor per frame.
    //
    // The matching source-side guard -- skipping no-op #dynamic-theme-css
    // writes so identical CSS never mutates the node -- is in app.py's
    // theme-styles-dummy clientside callback.

    var __paletteObserver = null;
    var __recolorScheduled = false;

    function recolorForPalette() {
        __recolorScheduled = false;
        if (!currentData || !svg) return;
        assignClusterColors(currentData.clusters || [], currentData.nodes || []);
        // circle.page fill is static 'currentColor' (checkpoint-A) — no
        // re-assignment needed; CSS var(--ink) already flips with theme.
        // Hull recoloring commented out — hull boundaries disabled
        svg.selectAll('text.hull-label').attr('fill', function (d) {
            return labelColor(clusterColor(d.cluster.id));
        });
        svg.selectAll('.hull-label-marker').attr('fill', function (d) {
            return clusterColor(d.cluster.id);
        });
        updateNebulaColors();
        updateWatermarkColors();
    }
    // S2 module export (header comment delta #6) -- no window.__d3* dev
    // alias existed for this in Dash (it was only ever wired indirectly
    // via observePaletteChanges' MutationObserver below, never called
    // directly), so none is added here; recolor() is a plain export.
    __vendorRecolor = recolorForPalette;

    function observePaletteChanges(retries) {
        if (__paletteObserver) return;  // single observer — never accumulate
        var styleEl = document.getElementById('dynamic-theme-css');
        if (!styleEl) {
            // Style element may not exist yet — retry a few times
            if ((retries || 0) < 20) {
                setTimeout(function () { observePaletteChanges((retries || 0) + 1); }, 200);
            }
            return;
        }
        __paletteObserver = new MutationObserver(function () {
            if (__recolorScheduled) return;  // coalesce a burst into one repaint
            __recolorScheduled = true;
            requestAnimationFrame(recolorForPalette);
        });
        __paletteObserver.observe(styleEl, { childList: true, characterData: true, subtree: true });
    }

    // ── Boot ─────────────────────────────────────────────────────────

    // S2 de-Dash DELETE (header comment delta #2): the boot latch
    // (`BOOT_USER_STATE_TIMEOUT_MS`, `__bootLatch`, and the two-latch
    // stash/timeout/apply-profile dance that used to live inside
    // `window.__d3GraphRender` below) is removed -- it existed purely to
    // race a `/_user_state` fetch against the first paint, and that fetch
    // no longer exists. Replaced by a direct exported entry (header
    // comment delta #1).
    //
    // Was: `window.__d3GraphRender = function (data) {...}`, the sole
    // trigger a Dash clientside callback used (mirroring a hidden
    // `#d3-graph-json` store element into this call -- that mirror lived
    // in app.py, not this file). GraphA1.tsx calls this directly instead.
    // A1-1 promotion (delta #11): disconnects/removes the two per-mount
    // artifacts the `if (!svg)` block creates that the S2 fix-round-1
    // "known limitation" (task-S2-report.md) had no handle to reach --
    // shared by the container-swap guard below (an implicit teardown of
    // the OLD container's handlers) and __vendorRender's returned dispose()
    // (an explicit teardown on final unmount). Safe to call more than once
    // (each branch nulls its own handle after use).
    function teardownContainerHandlers() {
        if (__resizeObserverHandle) {
            __resizeObserverHandle.disconnect();
            __resizeObserverHandle = null;
        }
        if (__escapeKeydownHandler) {
            document.removeEventListener('keydown', __escapeKeydownHandler);
            __escapeKeydownHandler = null;
        }
    }

    __vendorRender = function (container, data, opts) {
        // S2 fix-round-1 (review finding 2): container-changed guard. The
        // internal render()'s `if (!svg)` block (Dash-verbatim, untouched
        // here -- vendor :3684-3746) only (re)builds svg + its click/
        // dblclick/pointermove/pointerleave handlers + ResizeObserver the
        // FIRST time `svg` is null; unlike ensureZoomIndicator/
        // ensureEdgeChipLayer (which self-heal via a `document.body.
        // contains(...)` check), it has no DOM-containment check. Without
        // this guard, remounting against a fresh container (React
        // unmount/remount -- e.g. navigating away from and back to
        // /sandbox/graph-a1) would see `svg` still non-null (pointing at
        // the FIRST, now-detached, container) and silently skip creating a
        // new <svg> in the new container: blank canvas, no error.
        // Detecting the swap and nulling `svg` here forces that block to
        // rebuild svg/handlers/ResizeObserver against the NEW container on
        // the render() call below. `storedZoomBehavior`/`lastCanvasDims`
        // are reset too for the same reason, though render() unconditionally
        // reassigns both on every call regardless -- this only matters if a
        // post-swap render() call bails early (empty data).
        //
        // `rawData` is ALSO reset to null here, and this one is load-bearing,
        // not defensive: applyTunerSnapshot's tail (`if (rawData)
        // render(rawData)`, see the comment below) is why __tunerInitialized
        // exists at all -- it only stays a no-op because `rawData` is still
        // null the one time applyTunerSnapshot runs per mount. Resetting
        // __tunerInitialized without also resetting `rawData` would resurrect
        // exactly the "spurious extra re-render" that guard was written to
        // prevent, on every remount -- applyTunerSnapshot would find the
        // PREVIOUS mount's `rawData` still set and synchronously re-render
        // the (about-to-be-superseded) old data into the new container
        // first, immediately followed by this function's own correct
        // render(data, opts) call below. Nulling `rawData` here keeps the
        // "only fires while null" invariant true across remounts too.
        //
        // A1-1 RESOLVES the S2 fix-round-1 "known limitation" noted here
        // previously (task-S2-report.md "Fix round 1"): the OLD container's
        // ResizeObserver instance and document-level Escape keydown
        // listener now DO have module-level handles (delta #11, see
        // teardownContainerHandlers above), so a container swap tears down
        // the outgoing container's copies before the `if (!svg)` block
        // below builds fresh ones for the new container.
        if (__mountedContainer && __mountedContainer !== container) {
            teardownContainerHandlers();
            svg = null;
            storedZoomBehavior = null;
            lastCanvasDims = null;
            rawData = null;
            __tunerInitialized = false;
        }
        __mountedContainer = container;
        __onSelectCallback = (opts && opts.onSelect) || null;
        __mountedIcons = (opts && opts.icons) || null;
        // Tuner values initialize from opts.tunerSnapshot ?? GRAPH_DEFAULTS
        // exactly once per mount -- applyTunerSnapshot's own tail
        // (`if (rawData) render(rawData)`) would otherwise force a second,
        // visually-reshuffling re-render on every later render() call if
        // this ran unconditionally. (The container-changed guard above
        // resets __tunerInitialized so a NEW mount's tunerSnapshot isn't
        // silently ignored -- finding 2's second half.)
        if (!__tunerInitialized) {
            applyTunerSnapshot((opts && opts.tunerSnapshot) || GRAPH_DEFAULTS);
            __tunerInitialized = true;
        }
        render(data, opts);
        // No setTimeout(observePaletteChanges, 300) call here -- the
        // palette MutationObserver is exported as recolor() instead
        // (header comment delta #6) and this sandbox leaves it unwired.

        // A1-1 promotion (delta #11): return a dispose handle so a React
        // (or any other) caller can tear down this mount's ResizeObserver +
        // Escape listener on FINAL unmount (as opposed to a remount, which
        // the container-swap guard above already covers). Only tears down
        // if this call's container is STILL the mounted one -- a caller
        // that disposes an old mount after a newer one has already swapped
        // in must not rip out the NEW mount's handlers.
        return function dispose() {
            if (__mountedContainer !== container) return;
            teardownContainerHandlers();
        };
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3GraphRender = __vendorRender;
    }

    /**
     * Set the noise-toggle state and, if a dataset has already been
     * rendered, re-run the full force layout with noise either included or
     * filtered out. Task A1-3 (header comment delta #14): `show` now
     * DRIVES `__showNoise` directly (previously unused -- state came from
     * the `#noise-toggle-json` DOM mirror render() read regardless of what
     * this function's caller passed). `__showNoise` is written FIRST,
     * unconditionally, before the `rawData` guard -- a caller invoking this
     * before the first render() (e.g. GraphCanvas.tsx applying a session
     * preference ahead of data arriving) still records the intended state,
     * so the eventual first render() picks it up rather than silently
     * defaulting to __showNoise's own `true` default. Re-rendering (not
     * just flipping visibility) trades a one-time layout recompute for a
     * visually honest result -- previously the toggle only flipped
     * visibility, which left _unclustered nodes participating in the force
     * sim and shoving nearby nebulae into positions that read as inorganic
     * when noise was hidden.
     *
     * @param {boolean} show - true to show noise (_unclustered nodes), false to hide
     */
    __vendorToggleNoise = function (show) {
        __showNoise = !!show;
        if (!rawData) return;
        render(rawData);
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3ToggleNoise = __vendorToggleNoise;
    }

    // DEBUG: read current selection state (used to diagnose why graph
    // initially renders dimmed). Safe to leave; minimal overhead.
    __vendorDebugGetSelection = function () {
        return {
            selectedNodeId: selectedNodeId,
            selectedClusterId: selectedClusterId,
            selectedSessionId: selectedSessionId,
            selectedNodeIds: selectedNodeIds,
        };
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3DebugGetSelection = __vendorDebugGetSelection;
    }

    __vendorSetSelection = function (type, id) {
        selectedNodeId = null;
        selectedClusterId = null;
        selectedSessionId = null;
        selectedNodeIds = null;
        if (type === 'nodes' && Array.isArray(id)) {
            selectedNodeIds = id;
        } else if (id && type === 'node') {
            var isCluster = currentData && currentData.clusters &&
                currentData.clusters.some(function (c) { return c.id === id; });
            if (isCluster) {
                selectedClusterId = id;
            } else {
                selectedNodeId = id;
            }
        } else if (id && type === 'session') {
            selectedSessionId = id;
        }
        updateHighlighting();
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3SetSelection = __vendorSetSelection;
    }

    /**
     * Look up page IDs for a cluster by its slug.
     * Returns an array of page ID strings, or empty array if not found.
     */
    __vendorGetClusterPages = function (clusterId) {
        if (!currentData || !currentData.clusters) return [];
        var c = currentData.clusters.find(function (cl) { return cl.id === clusterId; });
        return c ? c.page_ids : [];
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3GetClusterPages = __vendorGetClusterPages;
    }

    /**
     * Whether a node with the given ID exists anywhere in the currently
     * loaded graph data -- unlike __d3GetClusterPages, this is NOT scoped
     * to a specific cluster, so it's the right check for "is this node on
     * the map at all" regardless of which cluster(s) cite it.
     * @param {string} nodeId - graph node id (slugified page title)
     * @returns {boolean}
     */
    __vendorHasNode = function (nodeId) {
        if (!currentData || !currentData.nodes) return false;
        return currentData.nodes.some(function (n) { return n.id === nodeId; });
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3HasNode = __vendorHasNode;
    }

    /**
     * Highlight nodes and smoothly zoom-to-fit them in the visible area.
     * @param {string[]} nodeIds - array of node IDs to highlight and frame
     * @param {number} visibleH - effective viewport height (canvas minus search bar)
     */
    __vendorFrameNodes = function (nodeIds, visibleH) {
        if (!nodeIds || !nodeIds.length) return;

        // Set selection first (highlight). Calls the module binding
        // directly, not window.__d3SetSelection -- that global doesn't
        // exist in production builds (header comment delta #7).
        __vendorSetSelection('nodes', nodeIds);

        // Compute bounding box of the target nodes
        if (!currentData || !svg || !storedZoomBehavior) return;
        var targets = currentData.nodes.filter(function (n) {
            return nodeIds.indexOf(n.id) >= 0 && n.x != null && n.y != null;
        });
        if (!targets.length) return;

        var container = __mountedContainer;  // was getElementById('d3-graph-container') (header comment delta #1)
        if (!container) return;
        var canvasW = container.offsetWidth;
        if (!visibleH) visibleH = container.offsetHeight;

        var PAD = 80;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        targets.forEach(function (n) {
            if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        });
        minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
        var bw = maxX - minX, bh = maxY - minY;
        if (bw <= 0 || bh <= 0) return;

        var scale = Math.min(canvasW / bw, visibleH / bh, 3);
        var mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
        // Offset vertically so content centers in the visible area (top portion)
        var yOffset = visibleH / 2;
        var transform = d3.zoomIdentity
            .translate(canvasW / 2 - mx * scale, yOffset - my * scale)
            .scale(scale);

        svg.transition().duration(600).call(storedZoomBehavior.transform, transform);
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3FrameNodes = __vendorFrameNodes;
    }
})();

// S2 module exports -- see the header comment (delta #7) for the naming
// convention and the dev-only window.__d3* re-attachment these pair with.
export {
    __vendorRender as render,
    __vendorRecolor as recolor,
    __vendorSetSelection as setSelection,
    __vendorToggleNoise as toggleNoise,
    __vendorFrameNodes as frameNodes,
    __vendorGetClusterPages as getClusterPages,
    __vendorHasNode as hasNode,
    __vendorDebugGetSelection as debugGetSelection,
    __vendorResetTunerToDefaults as resetTunerToDefaults,
    __vendorApplyTunerOverrides as applyTunerOverrides,
    __vendorExpandedGroups as expandedGroups,
};
