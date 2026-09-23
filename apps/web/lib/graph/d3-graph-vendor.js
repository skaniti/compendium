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
//  10. Remounting against a new container (React unmount + remount of the
//      S2-era sandbox route's GraphA1 component, e.g. leaving and
//      returning to /sandbox/graph-a1 at the time -- GraphCanvas.tsx's
//      center panel is the real, and only, consumer today) silently
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
//      one of the six keys item 8's prose (five) and item 9 (`knot`,
//      added separately) together establish, and not gated at any
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
//      not one of the six keys item 8's prose (five) and item 9
//      (`knot`, added separately) together establish, and its sole
//      call site (`render()`, inside the `if (!svg)` block, ~:4035) is
//      unconditional --
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
//      REVERSED by user ruling 2026-08-10, P1 (Task V3, task-V3-report.md,
//      item 27 below): the composed "PLUS" behavior this delta shipped is
//      REJECTED -- selection wins outright, exactly matching Dash's ACTUAL
//      wired dispatch this comment already described (not the "PLUS"
//      intent the comment apologized for never finishing). See item 27 for
//      the corrected precedence; the `filterDimNodeIds` module var and
//      `setFilterDim`/`__d3SetFilterDim` plumbing themselves are unchanged
//      -- only updateHighlighting()'s union-vs-precedence rule moved.
//
// Task group B (batch 03 boot & tuner state, decision C) -- task-B-report.md:
//  16. `TUNER_TYPO_VERSION`/`TUNER_FOG_VERSION` (:662/:674) were duplicated
//      literals -- this file's own `var`s, byte-identical to lib/graph/
//      constants.ts's own exported constants of the same name (S-group
//      triage finding). Both are now imported from constants.ts (see the
//      top-of-file import list) instead of re-declared here; the values
//      are unchanged (3 / 2). constants.ts is the single source both this
//      file's `applyTunerSnapshot` AND lib/graph/tuner-snapshot.ts's
//      `resolveTunerSnapshot` (a pure TS port of this function's own
//      gating semantics, run once at the React mount boundary before
//      first paint instead of mutating these live module vars after an
//      already-painted mount -- decision C's "no boot latch" requirement)
//      read from. `resolveEffectiveSlot`/`applyTunerSnapshot` themselves
//      are UNCHANGED and remain the dead code header comment delta #4
//      already documents (no `/_user_state` fetch exists in this app to
//      ever call them with real data) -- this delta is the version-stamp
//      import only.
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
// Task group W (batch 03 Web Worker force sim, the stutter fix) --
// task-W-report.md. The largest de-Dash delta of the batch: the
// synchronous force-layout section that used to block the main thread for
// ~600ms now runs off-thread. Numbered surgically, function by function:
//  17. `computeLayout(nodes, clusters, validLinks, width, height)` --
//      SOURCE :3018-3447, this file's prior :3210-3639 -- is DELETED from
//      this file. Its math (Phase 1 cluster-centroid sim, Phase 1.5b/1.5a/
//      1.75 super-cluster passes, Phase 1.6 tier-collapse packing, Phase 2
//      per-cluster page-node sims) now lives in lib/graph/sim-layout.ts's
//      `SimEngine`, ported byte-faithfully (see that file's own header
//      comment for the phase-by-phase mapping) but restructured so Phase
//      2 ticks INCREMENTALLY instead of running to convergence in one
//      blocking loop -- lib/graph/sim.worker.ts drives that incremental
//      loop inside a dedicated Web Worker, paced via `setTimeout` (not
//      `requestAnimationFrame` -- a worker isn't guaranteed one), posting
//      `tick`/`end` messages per lib/graph/sim-protocol.ts's locked
//      shape. This file's OWN copies of `hashId`/`mulberry32`/
//      `estimateLabelLines`/`estimateLabelBBox`/`estimateClusterShrinkwrap`/
//      `computeWatermarkBBox`/`rectCircleOverlap`/`rectRectOverlap`/
//      `isCollapsedCluster` are UNCHANGED and NOT deleted -- they're still
//      called by main-thread-only rendering code (drawHulls, drawWatermarks,
//      fitToContent's fog-aware padding, etc.) that has nothing to do with
//      layout computation. sim-layout.ts carries its own copies of the
//      same pure functions rather than importing them from here, since a
//      Web Worker can't import from a module that closes over `svg`/
//      `document` at its top level (this file's IIFE does, even though
//      these specific helper functions don't happen to touch either) --
//      two byte-identical copies, one per thread, is the actual seam.
//  18. `updatePageDotScale(zoomK)` (:1600-1617, unchanged call sites) now
//      ALSO sets `circle.page`'s `cx`/`cy` from the bound datum's current
//      `d.x`/`d.y` (previously only set once at creation, :4265-4266 in
//      the deleted inline flow) -- alongside its existing `use.star-
//      spikes` `transform: translate(d.x,d.y) scale(s)` re-application,
//      which ALREADY read `d.x`/`d.y` fresh on every call. This is the
//      "existing per-tick attr update machinery" task-W-brief.md's W2
//      step names: reused as-is for the new live-tick paint path (item 19
//      below) instead of writing a second position-painting code path,
//      since this function already existed, already re-reads positions
//      off the datum every call (zoom/arm/disarm already called it before
//      W2), and only needed the one missing `cx`/`cy` line to also cover
//      circles.
//  19. `render()`'s body after the (unchanged) SVG/zoom/root setup and
//      the (unchanged) `measureLabelDims` pre-pass is restructured into:
//      (a) `buildSimStartPayload(...)` assembles a lib/graph/sim-
//      protocol.ts `SimStartPayload` from `nodes`/`clusters`/`validLinks`/
//      `width`/`height` plus the CURRENT (possibly tuner-overridden)
//      NODE_RADIUS/PAGE_SPREAD_MULT/NEBULA_RADIUS_MULT/NEBULA_MIN_RADIUS/
//      SC_LABEL_TOP_PAD module vars, `labelDimsCache` (the just-completed
//      DOM measurement pass -- see sim-protocol.ts's `labelDims` field
//      comment for why the worker needs this forwarded rather than
//      re-measuring blind), and `expandedGroups`; (b) a lazily-created,
//      render()-call-persistent `__simClient` (lib/graph/useWorkerSim.ts's
//      `createWorkerSim`) is `.start()`-ed with it -- superseding any
//      still-running PRIOR sim (re-layout triggers: graphVersion bump,
//      noise toggle, tuner change all re-invoke `render()`, and
//      `createWorkerSim`'s own `.start()` termination-on-restart is what
//      makes this "no overlapping sims, no orphaned workers" rather than
//      something this file has to track); (c) `handleSimTick`/
//      `handleSimEnd` write each message's positions onto the SAME
//      `nodes` array's `.x`/`.y` (`writePositionsIntoNodes`) and paint --
//      the FIRST tick synchronously creates the `circle.page`/`use.star-
//      spikes` elements (the old inline "Nodes"/"star decorations" block,
//      unchanged, extracted into `paintPageDots(root, nodes)`) and fires
//      the NEW `opts.onFirstPaint` callback (vendor.d.ts; task group W's
//      W3 step wires this to the loader's render-complete signal instead
//      of render()'s own synchronous return); every LATER tick re-applies
//      positions via item 18's extended `updatePageDotScale`, rAF-batched
//      (`scheduleSimPaint`/`flushSimPaintNow`) so a burst of same-frame
//      tick messages coalesces into one paint, never a React re-render
//      (there isn't one to re-enter -- this file has no React state to
//      begin with); `rebuildDelaunay(nodes)` also re-runs on every paint,
//      not just at settle, so hover/click targeting tracks the
//      currently-displayed (still-moving) dot positions -- "zoom/pan/
//      select/hover must stay fully interactive during settle" is
//      otherwise satisfied for free, since none of the zoom/pointer/
//      Escape wiring moved; only Delaunay rebuilding needed to follow the
//      live positions explicitly. `window.requestAnimationFrame` is read
//      through a feature-detected `__rafSchedule`/`__rafCancel` pair
//      (falls back to `setTimeout(cb, 16)`) rather than called bare,
//      since jsdom -- lib/graph/d3-graph-vendor.remount.test.ts's
//      environment, which exercises this file unmocked -- implements no
//      `requestAnimationFrame` at all (verified: `"requestAnimationFrame"
//      in new JSDOM(...).window` is false); (d) the `end` message runs
//      item (c)'s paint immediately (not rAF-deferred, and cancels any
//      still-pending rAF-batched one) THEN `finishRenderAfterSettle(ctx)`
//      -- the OLD post-computeLayout tail (assignClusterColors +
//      retryColors, drawHulls, drawGroupLabels, drawPageTitleLabels,
//      drawNebula, drawWatermarks, drawClusterLinks, `fitToContent` +
//      `preserveView` restore, `rebuildDelaunay`), copied verbatim into
//      its own function, called once per settled run instead of inline
//      once per render() call -- these all read FINAL, settled positions
//      off `nodes`/cluster centroids derived from them (drawHulls'
//      convex hulls, computeClusterCentroids' node-position averaging,
//      etc. were never written to tolerate mid-settle, still-moving
//      positions), so they correctly wait for `end` rather than running
//      per-tick. `preserveView`'s prior-transform capture
//      (`d3.zoomTransform(svg.node())`) moved EARLIER -- right where the
//      worker starts, not at settle -- so it still captures "the
//      transform active when this render() call began" (unchanged
//      semantics) rather than whatever the user panned/zoomed to DURING
//      the several-second settle window that now elapses before
//      `finishRenderAfterSettle` runs.
//  20. `vendor.d.ts`'s `GraphRenderOptions` gains `onFirstPaint?: () =>
//      void` (item 19c). `lib/vendor/vendor.d.ts`'s
//      `Window.__compendiumGraphRendered` TODO(W3) is resolved:
//      components/GraphCanvas.tsx's mount effect now sets it from this
//      callback instead of from render()'s own synchronous return --
//      see that file's own comment for the full W3 writeup.
//
// Task group W fix round 1 (review finding + acceptance-bar follow-up,
// task-W-report.md's "Fix round 1" section):
//  21. `dispose()` (the function `__vendorRender` returns, item 19b's
//      `.start()`-owning wrapper) now also stops the sim run, not just
//      the container/Escape/ResizeObserver handlers -- previously, a
//      final unmount left the worker ticking against a DETACHED svg
//      (painting into nowhere at up to 60Hz) until it settled, then
//      still ran the full settle-end `finishRenderAfterSettle` tail for
//      no one. Calls `__simClient.stop()`, deliberately NOT
//      `__simClient.dispose()` -- `.dispose()` permanently no-ops the
//      controller, and render()'s `if (!__simClient) { __simClient =
//      createWorkerSim(...); }` guard (item 19b) would then never
//      recreate it on a later remount, since `__simClient` itself would
//      still be non-null (just permanently inert) -- silently breaking
//      every future mount in that container's lifetime. `.stop()`
//      preserves the persistent-singleton design: same controller
//      instance -- lib/graph/useWorkerSim.ts's `stop()` posts
//      `{type: "stop"}` (sim.worker.ts's `handleStop` clears its
//      scheduled frame, halting the tick loop) and locally suppresses
//      callback delivery on this side, but does NOT terminate the
//      worker; the worker thread itself keeps idling, inert, until the
//      next `.start()` -- which is what actually calls `.terminate()`
//      on it (via `teardownWorker()`, same as `.dispose()`). Also
//      cancels any pending
//      `__simRafHandle` (a rAF-batched per-tick paint or settle-chunk
//      callback already queued before dispose() ran) and nulls
//      `__simRunCtx`, so a straggler that somehow still fired would find
//      `handleSimTick`/`handleSimEnd`/`flushSimPaintNow`'s own `if (!ctx)
//      return;` guards already tripped -- belt-and-suspenders on top of
//      `.stop()`'s own suppression, and specifically what makes a
//      post-dispose `onFirstPaint` (which lives on `ctx.opts`)
//      impossible. The container-swap guard (item 1/S2 fix-round-1,
//      earlier in `__vendorRender`) needed no equivalent fix: a swap
//      falls through to the SAME call's own `render()` -> `.start()`,
//      which already supersedes (terminates) any prior run as part of
//      its normal contract -- there was never a detached-worker gap on
//      that path.
//  22. `finishRenderAfterSettle` (item 19d) -- measured at ~120-160ms as
//      ONE synchronous block against the real dataset (356 clusters, 802
//      nodes; task-W-report.md's instrumented per-call breakdown), itself
//      exceeding the spec's 100ms-long-task acceptance bar even though
//      the force simulation it follows now costs ~0ms main-thread time --
//      is split into 3 chunks at natural draw boundaries, chained via a
//      new `scheduleSettleChunk`/`__simRafHandle` pair (rAF, so a user
//      input arriving between chunks gets its own turn rather than being
//      starved): (1) colors + hulls + labels, (2) nebula + watermarks +
//      links, (3) fit-to-content + Delaunay rebuild (the single largest
//      remaining atom at ~52ms measured, still comfortably under the
//      ~60ms per-chunk ceiling on its own). Draw order and end state are
//      unchanged -- same calls, same arguments, same relative sequence,
//      only rAF yield points inserted between the 3 groups; z-order was
//      never JS-call-order-dependent to begin with (fixed by each
//      group's `.nebula`/`.hulls`/`.watermarks`/etc position in the SVG,
//      set up once at mount). A stale chunk (the run was disposed, or
//      superseded by a newer render() call, between two chunks) no-ops
//      via the same `__simRunCtx` identity check `handleSimTick`/
//      `handleSimEnd` already use. `flushPendingSettleChunk` (dev/test-
//      only, `window.__d3FlushSettleChunk`) synchronously drains every
//      still-pending chunk in one call, so
//      lib/graph/d3-graph-vendor.remount.test.ts's several tests that
//      assert on the fully-settled DOM right after `render()` returns
//      can force the now-multi-frame tail to completion deterministically
//      instead of needing fake timers or real animation-frame waits.
//
// Batch 03 final whole-branch review fix (task-finalfix-report.md):
//  23. `dispose()` (item 11a's returned teardown handle) tore down the
//      container's ResizeObserver + document Escape listener via
//      `teardownContainerHandlers()` but left `svg` (and the rest of the
//      per-mount state the container-swap guard resets, item 10) alone.
//      GraphCanvas.tsx's mount effect disposes on EVERY `hasNodes`
//      true->false transition, not just final unmount (it re-mounts on
//      the next true, against the SAME container div -- `hasNodes` only
//      gates whether a payload has any nodes, the container itself is
//      unconditionally rendered). A window round trip through zero nodes
//      and back therefore disposed, then re-rendered into the SAME,
//      never-swapped container: the container-swap guard's own
//      `__mountedContainer !== container` check saw no change and
//      stayed skipped, `svg` was still non-null from before dispose(),
//      and render()'s `if (!svg)` block -- the ONLY construction site
//      for the click/dblclick/pointermove/pointerleave handlers, the
//      Escape listener, and the ResizeObserver alike -- never ran again.
//      Net effect: resize-refit and Escape-listener reconstruction were
//      permanently dead for that mount until a full page reload, even
//      though `render()` itself kept "succeeding" on every later call.
//      Fix: `dispose()` now performs the SAME `svg`/`storedZoomBehavior`/
//      `lastCanvasDims`/`rawData`/`__tunerInitialized` reset the
//      container-swap guard already does, so the next `render()` call --
//      same container or a new one -- always hits a fresh `if (!svg)`
//      block. Deliberately does NOT touch the DOM itself, though: an
//      existing test (d3-graph-vendor.remount.test.ts's "unmount
//      mid-settle...") disposes with no later render() call and expects
//      the last-rendered content to stay exactly as it was, and a swap's
//      OLD container is simply abandoned either way, so neither path
//      needs an immediate DOM change. The orphaned `<svg>` a SAME-
//      container reuse would otherwise leave behind is instead removed
//      lazily, in `__vendorRender` itself, right before the (untouched)
//      internal render()'s `if (!svg)` block -- without that, a
//      disposed-then-reused container would stack a second `<svg>`
//      instead of the old one being replaced. See
//      lib/graph/d3-graph-vendor.remount.test.ts's "dispose() then
//      render() into the SAME container" test for the regression check.
//
// Task V1 (batch 03 vision-review fix loop, task-V1-report.md) -- P1 vision
// pass findings F1 (selection dim absent on Next) and F2 (noise-ON layout
// diverges cross-app):
//  24. F1's regressing commit was Group W's async-worker refactor (items
//      17-19 above), NOT this file's own selection/highlighting code
//      (updateHighlighting(), delta #15's union rewrite -- item 15 -- both
//      verified correct by direct live DOM inspection). The regression is a
//      TIMING bug in components/GraphCanvas.tsx: two call sites called
//      vendor.setSelection()/setFilterDim() SYNCHRONOUSLY right after
//      vendor.render() returned, an invariant ("render() returning means
//      the DOM is ready") that held when render() was still fully
//      synchronous (pre-Group-W) but Group W silently broke: paintPageDots
//      -- the ONLY site that creates circle.page/use.star-spikes -- now
//      only runs from the worker's first `tick` message, strictly AFTER
//      render() returns. Fix: both call sites now fire from `onFirstPaint`
//      (this file's own "DOM now exists" signal, item 19c) instead -- see
//      GraphCanvas.tsx's own comments at both sites for the full writeup
//      and the CDP evidence trail. No change was needed in THIS file --
//      updateHighlighting()/setSelection()/setFilterDim() were never
//      broken, only called too early by their React-side callers.
//  25. F2 -- investigated, NO code defect found in this file or
//      lib/graph/sim-layout.ts (documented here per items 12/13's
//      established "no code change" precedent, since the vision pass's own
//      brief expected a fix). Root-caused to `#d3-graph-container`
//      rendering at a genuinely different pixel WIDTH on Next vs Dash in
//      the vision-pass's test environment (950px vs ~990px at an identical
//      1600x900 viewport, traced further to a `panel_left_width`/
//      `panel_right_width` preference-application difference between the
//      two apps -- Dash's rendered panel widths did not reflect the shared
//      backend's currently-stored preference the way Next's correctly did;
//      a cross-app/test-session-state discrepancy, not a graph-canvas
//      defect, and Dash is read-only per this task's brief either way).
//      Phase 1's force layout is genuinely, provably sensitive to this
//      class of width delta at noise-ON's ~356-cluster scale (not at
//      noise-OFF's ~83-cluster scale, matching the vision pass's own
//      observation that only the noise-ON state diverges) -- but this
//      sensitivity is INHERITED, not port-introduced: Dash's own vendored
//      source carries a 2026-04-28 "SCRUNCH FIX" comment (this file's
//      computeLayout equivalent, now lib/graph/sim-layout.ts) already
//      documenting that Phase 1's absolute-pixel force constants
//      (forceCenter, distanceMax 300) produce viewport-dependent layouts.
//      Proof (task-V1-report.md): substituting Dash's REAL measured
//      container width into a captured live-Next SimStartPayload and
//      replaying it through lib/graph/sim-layout.ts's SimEngine in Node
//      reproduced Dash's actual live-browser settled positions to
//      floating-point precision, for every landmark cluster checked --
//      confirming the ported algorithm is byte-faithful and the width
//      delta alone fully explains the observed divergence. No fix belongs
//      in this file: forcing width-insensitivity here would itself be a
//      deviation from the byte-faithful port this whole batch maintains,
//      and would drift Next away from matching Dash's real (also
//      width-sensitive) behavior at a MATCHED width, which is the only
//      layout-fidelity contract in scope. The faint noise-item label class
//      the vision pass also flagged as absent (state 04) is a downstream
//      consequence of the same width-driven position/collision-cull
//      differences (text.singleton-label's LOD + collision culling reads
//      final settled positions), not a separate missing code path.
//
// Task V2 (batch 03 vision-review fix loop, task-V2-report.md) -- P1
// vision pass finding F5 (knot expand loses its frame on Next):
//  26. `toggleGroupExpansion` (:3740) used to call `frameWorldBBox`
//      SYNCHRONOUSLY, right after kicking off `render(rawData,
//      {preserveView:true})` -- correct for Dash, whose render() is fully
//      synchronous (item 17 predates the port), so by the time Dash's own
//      toggleGroupExpansion reaches frameWorldBBox, render()'s own
//      preserveView restore has already run and the frame is the last
//      word. Group W's async worker relayout (items 17-19) broke that
//      ordering here: this file's render() only kicks off the worker and
//      returns immediately, so the synchronous frameWorldBBox call (a)
//      read groupWorldBBox against STALE, pre-relayout positions and (b)
//      started a transition that finishRenderAfterSettle's OWN
//      preserveView restore (item 19d/22, running seconds later once the
//      worker actually settles) unconditionally overwrote -- confirmed
//      live via temporary instrumentation (task-V2-report.md): the
//      transition genuinely reached the correct ~260%-zoom frame, then
//      was snapped back to the pre-click transform once settle-end ran.
//      Fix: the group id is threaded through render()'s opts as
//      `frameGroupId` (only ever set by toggleGroupExpansion); the
//      synchronous frameWorldBBox call is gone, and
//      finishRenderAfterSettle's own chunk 3 applies it instead, AFTER
//      its preserveView restore -- same net order as Dash's synchronous
//      path, reproduced explicitly because this run's settle is async.
//      Inherits the exact same dispose()/supersession safety the
//      preserveView restore already had (same scheduleSettleChunk/
//      __simRunCtx-identity-guarded closure), so a dispose() or a
//      superseding render() mid-expand-settle drops the frame the same
//      way it already dropped the restore. Collapse was never broken --
//      toggleGroupExpansion only ever framed on `expanding`, and Dash's
//      own "collapsing never moves the camera" contract (the function's
//      own comment, unchanged) held on Next both before and after this
//      fix.
//
// Task V3 item 1 (post-P1-rulings fix batch, task-V3-report.md) -- user
// ruling 2026-08-10, P1, dimming precedence:
//  27. `updateHighlighting()` (:5221) no longer unions `filterDimNodeIds`
//      into `highlightIds` unconditionally -- delta #15's "PLUS" union is
//      REJECTED (see that item's own updated text above). The
//      selectedNodeId/selectedClusterId/selectedNodeIds/selectedSessionId
//      if/else-if chain now decides `hasSelection` FIRST; the filter-dim
//      layer only runs when `!hasSelection`, matching Dash's actual wired
//      dispatch (app.py ~:3040: node selected -> setSelection('node', ..);
//      else highlightIds present -> setSelection('nodes', highlightIds);
//      else session -> setSelection('session', ..); else clear -- a
//      selection, once present, always wins outright over any filter).
//      `filterDimNodeIds`/`setFilterDim`/`__d3SetFilterDim` (delta #15's
//      plumbing) are UNCHANGED -- GraphCanvas.tsx still drives the filter
//      layer independently of setSelection, exactly as before; only the
//      precedence inside updateHighlighting() moved. No-selection behavior
//      (filter dim alone) is byte-identical to pre-V3.
//
// Task V3 item 3 (post-P1-rulings fix batch, task-V3-report.md) -- user bug,
// tutorial replays on every refresh:
//  28. Root cause (CDP-instrumented, live-reproduced): `render(data, opts)`
//      (:4239) stores `opts` onto the run's `__simRunCtx.opts` (:4586),
//      which `handleSimTick`/`handleSimEnd`'s `!ctx.paintedOnce` branch
//      reads to fire `ctx.opts.onFirstPaint()` -- the ONLY signal
//      components/GraphCanvas.tsx's mount effect uses to set
//      `window.__compendiumGraphRendered = true`, which
//      components/CompendiumLoader.tsx's `tryDismiss()` polls (alongside
//      `window.__compendiumLoader`) before ever calling `.dismiss()` --
//      the ONLY path that reaches `finishDismiss()`'s
//      `window.__compendiumLoaderOnSeen()` persist call. `__vendorToggleNoise`
//      (:5936) and `applyTunerSnapshot`'s tail (:1525) BOTH re-render via a
//      single-argument `render(rawData)` -- `opts` omitted BY DESIGN,
//      meaning "re-run the SAME render with whatever's already
//      configured" -- but the omitted `opts` overwrote `__simRunCtx.opts`
//      with `undefined`, silently dropping `onFirstPaint` for the run that
//      actually wins the race to paint first. Live-reproduced:
//      GraphCanvas.tsx seeds `showNoise` from `useState(false)` then
//      corrects it from the session's real (async-fetched) preference
//      (its own :290-293) -- when that correction lands with the noise
//      pref genuinely true (a real user's actual persisted setting, not
//      the `false` placeholder) AFTER the mount effect's own render() call
//      has already set `rawData`, the noise-sync effect's
//      `toggleNoiseRef.current?.(showNoise)` (:686) fires
//      `__vendorToggleNoise`'s `render(rawData)` tail, which creates a NEW
//      `__simRunCtx` (fresh `paintedOnce: false`, `opts: undefined`) and
//      restarts the (shared, singleton) worker sim -- ITS first tick wins
//      `paintedOnce`/paints the dots, with no `onFirstPaint` to call.
//      `window.__compendiumGraphRendered` never becomes true;
//      `tryDismiss()`'s own ~10s MAX_TRIES ceiling then gives up silently
//      (task-A1-4-report.md's fallback, never designed to be the ONLY
//      path); the seen-flag PATCH never fires; next refresh replays
//      first-run again, forever, deterministically for any user whose
//      persisted `show_noise` preference differs from the `false` seed
//      default. Fix: `render(data, opts)` (:4239) now falls back to the
//      CURRENT run's own `onFirstPaint` (read off `__simRunCtx.opts`
//      before it's overwritten) whenever a caller omits `opts` entirely --
//      deliberately NOT the full opts object (see the fix's own comment
//      at :4251 for why `frameGroupId`/`preserveView` are excluded).
//      Idempotent with an already-fired `onFirstPaint` (the flag write and
//      the selection/filter reapply are both safe no-ops on a second
//      call, matching this codebase's established "apply whatever already
//      exists" idiom elsewhere). No test existed for the opts-omitted
//      re-render path before this fix -- see
//      d3-graph-vendor.remount.test.ts's new discriminating test.
//      GENERALIZED by batch 03 V4 item 2 (item 31 below): this fallback
//      only ever covered a caller that omitted `opts` ENTIRELY --
//      toggleGroupExpansion's knot-expand call passes a REAL but SPARSE
//      opts object that never carried `onFirstPaint` either (the same
//      class of gap, previously unfixed and unnoticed since
//      GraphCanvas.tsx's onFirstPaint side effects are idempotent no-ops
//      when nothing changed). See item 31 for the generalized mechanism
//      that now covers both shapes for `onFirstPaint` and the two new
//      settle-lifecycle callbacks alike; the omitted-opts fallback itself
//      (the specific case this item's own text above describes) is
//      unchanged in behavior, only broadened.
//
// SC watermark nameplate glide fix (visual-debug repro
// logs/visual-debug/sc-watermark-zoom-jump/01-repro/), both apps:
//  29. SC watermark nameplates (R6 deconfliction pass, :3673-3797 in this
//      file's own numbering) teleported hundreds of screen px on a single
//      zoom tick -- reproduced identically in Dash and here (this bug
//      predates the port; the pass is untouched by any port-specific
//      delta above). Root cause, evidence-confirmed via temporal CDP
//      captures: the resolver's output displacement is a DISCONTINUOUS
//      function of zoom k, via two independent cliffs. (a) The
//      3-body-pinch cycle-detection down-only fallback (the pass's own
//      "Convergence" comment, above) chains a plate below the whole
//      already-placed field the instant a pinch closes -- measured
//      moving `technology` 2665 world units (~557 screen px) in one 2%
//      wheel notch, symmetric in both zoom directions. (b) The icon-fade
//      `display:none` flip (iconOpacity <= 0.05, zoom ratio ~1.775, R6.1)
//      discretely shrinks a measured footprint the instant it crosses the
//      fade threshold, collapsing displacement ~657 px in one tick. Both
//      are real, unavoidable cliffs in the resolver's TARGET -- not a bug
//      in the resolver itself -- but applying that target memorylessly
//      and instantly via `setAttribute('transform', ...)`, as the pass
//      always has, renders every cliff as a user-visible teleport. Fix:
//      temporal glide of the APPLICATION only -- the resolver and its
//      targets stay byte-unchanged; a new module-level `__wmGlide` state
//      map (keyed by each watermark's `data-sc` keyword) exponentially
//      approaches each target from its previously-applied offset (time
//      constant `WM_GLIDE_TAU_MS`, screen-space snap epsilon
//      `WM_GLIDE_SNAP_PX`), continuing across a self-scheduling rAF loop
//      (`wmGlideStep`) after the last zoom tick until every keyword
//      converges. Final rest positions are exactly the stateless
//      resolver's output -- idempotence-by-construction (the pass's own
//      long-standing contract, stated in its "Idempotent by construction"
//      sentence above) is preserved, since the glide state is
//      display-layer only and decays a fresh delta toward a fresh target
//      every draw, never accumulating error. Two secondary fixes ride
//      along with the glide itself: `wmGlideReset()` clears the state map
//      on drawWatermarks' own `!__mountedIcons`/`!superClusters.length`
//      early-return paths (every watermark just got torn down on those
//      paths too -- without this, a keyword that later reappears would
//      glide from a stale offset the same way an unpruned single-keyword
//      disappearance would); and `wmGlideStep()` re-triggers
//      `scheduleLabelCull()` the moment a glide finishes converging,
//      since the existing zoom-tick-driven debounced cull (90ms after the
//      last zoom tick) can fire before a slower glide has actually
//      settled, freezing cull/caption decisions against positions up to
//      a full plate-height stale. This change lives ENTIRELY inside the
//      shared vendored region (new module-level state +
//      `wmGlideStepOffset`/`wmGlideReset`/`wmGlideStep` functions, plus
//      edits confined to `drawWatermarks`'s body, :3368-3960 in this
//      file's own numbering) and touches none of the numbered-delta edit
//      sites above -- including its own rAF scheduling, which is a
//      SELF-CONTAINED feature-detected pair (`__wmRafSchedule`/
//      `__wmRafCancel`, declared alongside the rest of this delta's
//      module state) rather than the file's existing task-group-W
//      `__rafSchedule`/`__rafCancel` (a Next-only De-Dash delta itself --
//      explorer's copy of this shared region has neither binding, so a
//      mirrored call to them would throw ReferenceError there the first
//      time a glide actually goes unconverged). It is to be mirrored
//      VERBATIM into explorer's own `frontend/dash/assets/d3_graph.js`
//      (same shared region, byte-identical apart from line offsets), with
//      TWO insertion-site adjacency differences, both caused by earlier,
//      unrelated De-Dash deltas already having reworded the exact line
//      this delta's new code sits next to -- the INSERTED lines
//      themselves are unaffected either way, only where they land:
//        - The top-of-drawWatermarks rAF-cancel block above sits below
//          this file's Next-only delta #8 `SANDBOX_SECTION_GATES.watermark`
//          gate line, whereas explorer's drawWatermarks has no such gate,
//          so the identical inserted lines land at the function's
//          opening, right before `var layer = ...` (explorer :2963-2965).
//        - `wmGlideReset()`'s call site restructures the `!__mountedIcons`
//          early-return (above) from a bare `return;` into a `{ }` block --
//          that line is itself delta #5's rename target (`was
//          window.__superClusterIcons`), so explorer's copy reads `if
//          (!window.__superClusterIcons) return;` (explorer :2967) with
//          different wording at the same site; the mirror session applies
//          the identical bare-return-to-block restructure to THAT
//          differently-worded condition, not a literal text match against
//          this file's `__mountedIcons` spelling. The sibling
//          `!superClusters.length` early return a few lines below is
//          shared, unedited-by-any-delta text -- portable as-is, no
//          special-casing needed there.
//      Parity is restored once mirrored; until then this is a deliberate,
//      documented divergence from vendored base 4bb0a648.
//      Follow-up (2026-08-10, after the explorer mirror landed @ 378b6cd):
//      explorer's design-verify `overlaps` check caught a delta-#29
//      omission this repo's suite could not (no settled-overlap harness
//      here) -- group captions never re-dodged after glide convergence,
//      because positionGroupCaptions only runs inside a zoom pass, BEFORE
//      that pass's drawWatermarks repaint, so a gesture ending mid-glide
//      froze captions against a mid-flight plate. Fixed explorer-side
//      first (same session), reverse-mirrored here: wmGlideStep's
//      convergence branch now calls positionGroupCaptions(currentZoomK)
//      before scheduleLabelCull() (captions settle before the cull's
//      obstacle pass reads their rects). The hunk is byte-identical in
//      both repos; the shared region is back in parity.
//
// Batch 03 graph fix wave V4, item 1 (P1 gate, user-ruled) -- interim zoom
// clamp:
//  30. render() recreates the zoom behavior EVERY cycle with the ABSOLUTE
//      default `scaleExtent([0.05, 6])` (below) -- the fit-relative clamp
//      (`[fitZoom * MIN_ZOOM_RATIO, fitZoom * 4]`) only lands once
//      fitToContent actually runs, inside finishRenderAfterSettle's chunk 3
//      (item 22), several seconds later at real dataset scale. During that
//      settle window the wide-open extent let a user zoom far enough that
//      the zoom indicator's %-readout (currentZoomK / fitZoom * 100) could
//      read into the thousands of percent. Fix: `fitZoom` is a module var
//      that persists across render() calls (see the "Zoom" section's own
//      comment on `contentBBox` above the zoom behavior below) -- when
//      `svg` is non-null when THIS cycle started (captured as
//      `__priorFitZoomForClamp` before the svg/if-else branch runs, since
//      by the time the zoom behavior is built `svg` has already been
//      (re)assigned either way), the freshly created behavior's
//      scaleExtent is seeded from whatever `fitZoom` currently holds
//      instead of the wide-open absolute default. Fix round 1 (F3
//      reviewer finding): `svg` non-null means a prior render() call for
//      this mount has STARTED, not necessarily that it has SETTLED -- a
//      re-render issued before the mount's very first cycle finishes
//      settling still seeds from `fitZoom`'s `1` module-init default
//      (a BOUNDED `[0.5, 4]` interim extent, not the wide-open absolute
//      one), self-correcting the moment THIS cycle's own fitToContent
//      runs, same as any other cycle. The very first render ever for a
//      mount -- and the first render after a container swap or
//      dispose(), both of which null `svg` (items 10/11/23) -- has no
//      prior render at all to seed from and keeps the original absolute
//      bounds until its own first fitToContent lands, same as before this
//      fix.
//
// Batch 03 graph fix wave V4, item 2 (P1 gate, user-ruled) -- settle
// lifecycle callbacks:
//  31. Two ADDITIVE GraphRenderOptions callbacks (vendor.d.ts): `
//      onRenderCycleStart` fires synchronously at the top of every REAL
//      render() cycle (past the empty-payload guard -- GraphCanvas.tsx
//      never actually calls render() with an empty payload on the initial
//      mount path, only via a LATER graphVersion-bump re-render into an
//      already-mounted container, see that guard's own reasoning); `
//      onSettleEnd` fires once finishRenderAfterSettle's chunk 3 completes
//      -- after its fitToContent call and after INITIATING (not waiting
//      out) a knot-expand's item-26 frame transition, which deliberately
//      keeps animating past the signal. components/GraphCanvas.tsx's new
//      settle veil (batch 03 V4 item 3) raises/drops on these two signals.
//      Carry-through: item 28's opts-omitted fallback (`if (!opts &&
//      __simRunCtx && __simRunCtx.opts && __simRunCtx.opts.onFirstPaint)`)
//      only covered a caller that dropped `opts` ENTIRELY
//      (__vendorToggleNoise's and applyTunerSnapshot's own `render(rawData)`
//      tails) -- toggleGroupExpansion's knot-expand call
//      (`render(rawData, {preserveView, frameGroupId})`) passes a REAL,
//      merely SPARSE opts object that never carried onFirstPaint either
//      (a pre-existing, harmless gap: GraphCanvas's onFirstPaint side
//      effects are idempotent no-ops when nothing actually changed, so it
//      went unnoticed), and would silently drop the two new callbacks the
//      same way. Fix generalizes item 28's mechanism: whenever the CURRENT
//      run's own opts (`__simRunCtx.opts`, the previous cycle's, read
//      BEFORE it's overwritten below) exist, this cycle's onFirstPaint/
//      onRenderCycleStart/onSettleEnd are backfilled from them for any of
//      the three NOT already present on this call's own opts (`opts
//      omitted entirely` and `opts present but missing these keys` both
//      resolve the same way: `Object.assign({}, carried, opts)`, so an
//      explicitly-passed callback always wins over a carried one). Still
//      deliberately NOT the full opts object either way --
//      `frameGroupId`/`preserveView` must never leak across an unrelated
//      later re-render, exactly as item 28's original text already
//      explained. Empty/error-domain resolution: GraphCanvas.tsx never
//      calls render() for those two domains at all (the empty-state and
//      error effects set their own signals directly, independent of any
//      vendor callback) -- see that component's own comments for the
//      wrapper-visible resolution that keeps a settle veil from being
//      stranded if a real cycle happened to be mid-settle when the canvas
//      raced into one of those domains.
//
// SC layout separation (spec: the 2026-08-10 sc-layout-separation plan
// (private), spec.md; decisions 2026-08-10 + 2026-09-11):
//  32. Nameplates no longer leave their SC. (a) P3: SCALE_THRESHOLDS.scName
//      k_min 1.00 -> 0.75 (TUNER_TYPO_VERSION 3 -> 4) and LOD-faded names
//      get display:none like R6.1's icons. (b) applyScLayoutSeparation
//      (called from handleSimEnd after writePositionsIntoNodes, before any
//      paint/fit) rigidly translates whole SC member-sets until every
//      painted plate's estimated 0.5x-floor footprint (lib/graph/
//      sc-separation.ts, same constants drawWatermarks paints with) is
//      disjoint, per-SC budget SC_SEPARATION_BUDGET_RATIO x
//      scOverlayGeometry().maxReach; computeFitBBox is fitToContent's bbox
//      math factored out so the floor k is derived from the real fit.
//      Unresolvable pairs mark the smaller plate overflow with a computed
//      exile onset kExile (record: __scLayout / dev __d3ScLayoutReport).
//      (c) drawWatermarks: every plate records data-anchor-x/y (anchored
//      translate) + data-plate-cx/cy/hw/hh (footprint geometry); overflow
//      plates below their kExile are centered on a peripheral point --
//      ring placement lives in `placeExiledPlates` (sc-separation.ts): slot
//      swap on clipped leaders, radial viewport clamp -- with a
//      g.watermark-leader (dot at the anchor + straight leader clipped to
//      the plate rect) in a leader sub-layer painted beneath the plates;
//      dot carries the nameplate's hover/click. The glide's anchor now
//      comes from data-anchor-x/y so anchored<->exiled transitions animate
//      through the unchanged delta-#29 machinery; updateLeaderEnd keeps the
//      leader on the moving plate each frame. Exile onset is computed
//      against every other painted plate; exiled plates yield in the R6
//      order.
//      (d) sim-layout.ts Phase 1.5b seeds SC groups apart by
//      footprint as well as fog halo (payload.scSeparation). The R6
//      resolver and delta-#29 glide are unchanged and now act only as a
//      safety net. Dev/test-only hooks: __d3ScLayoutReport, __d3ScLayout,
//      __d3ScLayoutRemeasure, __d3SetScSeparationOptions, __d3ZoomTo (same
//      class as delta #30's __d3GetZoomScaleExtent).
//      (e) 2026-09-13 user direction, three follow-ups. Leader + anchor
//      dot are opaque white (`#ffffff`, not the SC's nebula color -- all
//      eight palettes are dark), dot outline removed. SC icons no longer
//      fade on zoom-in: `ICON_LOD_FADE_ON_ZOOM_IN` gates the R6.1 fade off
//      by default, so only the name fades (on zoom-out) and the icon
//      persists at every zoom-in level; ICON_LOD_FADE_START/END stay
//      tuner-exposed but inert while the switch is false. Exile placement
//      defaults to the cloud periphery and may leave the viewport
//      (`SC_EXILE_CLAMP_MODE`), with the pre-existing radial viewport
//      clamp kept as an opt-in `'viewport'` mode. Dev hooks
//      __d3SetScSeparationOptions / __d3GetScSeparationOptions extended
//      accordingly (exileClampMode, exileMarginPx).
//  (f) 2026-09-13 user report (fit/floor cropping exiled plates): fit bbox
//      = content bbox ∪ plates exiled at fit (+ SC_FIT_EXILE_MARGIN_PX),
//      fixed-point in remeasureScLayout; ring perimeter = unpadded content
//      bbox (cloudBBox); fit bbox expanded symmetrically about the content
//      center, so a one-sided exile can't push the nebula off-center at
//      100% (Task 9).
//  33. Almagest graph tuner (spec: the 2026-09-13 almagest-graph-tuner
//      plan, private): `renderScName` seam (text by default,
//      generator path glyphs under a dev preview), tier breakpoints and
//      SC_NAME_CHAR_WIDTH read from the generator, dev hook
//      `__d3SetAlmagestPreview`. Batch A (the 2026-09-13 graph-interaction-
//      followups plan, private) adds a dev-only tier-tint debug aid on top
//      (`__almagestTierTint`, dev hook `__d3SetAlmagestTierTint`).
//
// Graph interaction follow-ups (spec: the 2026-09-13 graph-interaction-
// followups plan (private), spec.md; decision: controller, 2026-09-13),
// Batch B -- starfield parallax:
//  34. `fitToContent` records the transform it just applied as
//      `__fitTransform` (module var), INCLUDING the canvas center it fit
//      about (`cx: canvasW / 2, cy: canvasH / 2` -- fix review C1), and
//      does so BEFORE calling `zoomBehavior.transform` (fix review I1 --
//      that call dispatches 'zoom' synchronously, so recording after it,
//      the original shipped order, made the fit tick's own onViewChange
//      fire against the stale PRIOR fit). The `'zoom'` handler, after the
//      manual pan clamp and the existing updateLabelLOD/updateZoomIndicator/
//      updateLabelScale/updateEdgeChips calls, fires the new
//      `GraphRenderOptions.onViewChange` callback (vendor.d.ts) with
//      `{x, y, k, fitX, fitY, fitK, cx, cy}` -- the just-clamped transform
//      plus the most recent fit's own transform and canvas center (or the
//      same tick's x/y/k plus the CURRENT canvas center when no fit has
//      run yet). Every transform path (wheel, drag, scaleBy/scaleTo,
//      __d3ZoomTo) funnels through this one handler, so this fires for
//      all of them alike. Included in the opts-carry-forward set (delta
//      #28/#31) as of fix review I2 -- an opts-omitted internal re-render
//      (toggleNoise/applyTunerSnapshot's `render(rawData)` tails) would
//      otherwise silently drop onViewChange for that cycle, same bug class
//      delta #28 originally fixed for onFirstPaint, leaving
//      components/Starfield.tsx frozen on the pan/zoom state from before
//      the toggle. lib/graph/view-bus.ts's `publishView` is
//      components/GraphCanvas.tsx's wiring; components/Starfield.tsx
//      subscribes and pans its mount at a parallax factor of
//      `((cx - fitX) * (1 - fitK/k) + (x - fitX) * (fitK/k))` -- the
//      `cx`/`fitK`/`k` correction term (fix review C1) makes a pure zoom
//      about the canvas center (no real world-space pan -- e.g. the
//      zoom-indicator's scaleBy/scaleTo, __d3ZoomTo, or a real ctrl+wheel
//      notch, all of which anchor on `cx`/`cy` by default) report zero
//      parallax offset instead of the apparent screen-space `x`/`y` shift
//      zooming about a fixed point produces; the original shipped formula
//      (`(x - fitX) * (fitK/k)`, no correction term) moved the stars on a
//      pure zoom, which was wrong. `__fitTransform` is reset to null under
//      the SAME `svg`-null gate as delta #30's `__priorFitZoomForClamp` (a
//      genuine first-ever mount, or the first render after a container
//      swap/dispose) -- without it, a stale PRIOR mount's fit transform
//      would leak into a fresh mount's very first 'zoom' tick as a
//      nonsense parallax reference point.
//
// Graph interaction follow-ups, Batch C (decision: user, 2026-09-13) --
// wheel mapping: plain wheel pans, Ctrl/Cmd+wheel zooms:
//  35. zoomBehavior gains a `.filter()`: a 'wheel' event only drives its
//      own zoom when `ctrlKey`/`metaKey` is set (trackpad pinch arrives as
//      a ctrlKey wheel event, so this doubles as pinch-to-zoom); every
//      OTHER event type falls back to d3-zoom's own unmodified default
//      (`!event.ctrlKey && !event.button`), since `.filter()` replaces the
//      default outright rather than composing with it -- click-drag pan
//      and touch/pinch are unaffected. A new `svg.on('wheel.pan', ...)`
//      listener (registered right after `svg.call(zoomBehavior)`, same
//      re-attach-every-render treatment as the existing
//      `dblclick.zoom`-disable line beside it) claims the plain-wheel case
//      the filter just excluded: `zoomBehavior.translateBy(svg, -dx*mult/k,
//      -dy*mult/k)`, `deltaMode`-aware (0/1/2 px/line/page) so the pan
//      distance is sane across devices. `translateBy` dispatches the same
//      'zoom' event as every other transform path, so the existing manual
//      pan clamp inside `.on('zoom', ...)` applies to wheel-pan
//      identically -- no separate clamp needed. The zoom-indicator's +/-
//      buttons and `__d3ZoomTo` (both `scaleBy`/`.transform`, never
//      'wheel' events) are unaffected by the filter. Fixes the "Zoom
//      (scroll only — no click-drag pan)" comment above the zoom setup,
//      stale before this change too (click-drag pan already worked via
//      d3-zoom's own default). Fix review C2: zoomBehavior also gains a
//      `.wheelDelta()` restating d3-zoom's own default formula but
//      clamping its exponent to [-0.5, 0.5] -- unclamped, a real mouse's
//      Ctrl+wheel notch (deltaY ~100, same magnitude a plain wheel pan
//      tick delivers) fed through the default's ctrlKey*10 pinch
//      multiplier zoomed ~4x per notch; the cap bounds a single event to
//      at most a ~1.41x (2^0.5) change, matching the zoom-indicator's own
//      per-click step feel. A genuine trackpad pinch's small per-tick
//      deltaY rarely reaches the cap.
//
//  36. Nameplate LOD fit scale (spec docs/project-plans/2026-09-23-151626-
//      nameplate-lod-fit-scale/, decided 2026-09-23): plates were
//      fit-ratio-clamped to a FIXED 100px icon / 22px name at 100%
//      regardless of canvas size, so a small canvas (laptop: 771x401
//      container) shrank the nebula to fit fixed-px plates. Now
//      `plateFitScale = clamp(min(w, h) / SC_PLATE_FIT_REF_PX,
//      SC_NAME_FIT_FLOOR_PX / BASE_SC_NAME_FONT_SIZE, 1)` (pure
//      `plateFitScaleFor`; module var beside `fitZoom`) is written at the
//      four places that know the canvas -- render() right before the
//      sim-start payload is built (so the worker's Phase-1.5b seed sees it),
//      applyScLayoutSeparation, remeasureScLayout, fitToContent, all from
//      the SAME search-bar-adjusted dims -- and multiplies the BASE plate
//      sizes at three seams: drawWatermarks (icon, name, icon->name pad),
//      scFootprintParams
//      (so sc-separation.ts's estimator, the separation pass, the exile
//      pre-pass and the fit-inclusion loop follow with no signature change)
//      and computeFitBBox's plate padding. clampedScale, the bands,
//      MIN_ZOOM_RATIO, the 100% definition (k === fitZoom), frameWorldBBox,
//      the interim clamp seed, the exile ring, leaders/dots and edge chips
//      are untouched; other label classes are not scaled. Exposed on the
//      `__scLayout` record (`plateFitScale`) for tests and the acceptance
//      harness; REF/FLOOR are typo-gated tuner keys (TUNER_TYPO_VERSION 5),
//      live-tunable via __d3ApplyTunerOverrides.
//
// Everything else below -- indentation, Dash CSS class names
// (hull-label, watermark, group-label, sc-edge-chip, etc.), function
// bodies not listed above -- is unedited (computeLayout excepted -- item
// 17 deletes it; see lib/graph/sim-layout.ts for its replacement). Spot-
// diff any other large untouched region (e.g. fitToContent, :3454-3987 in
// the original source numbering) against the source path above to
// confirm.
// =====================================================================

import { GRAPH_DEFAULTS, TUNER_TYPO_VERSION, TUNER_FOG_VERSION } from "./constants";
import { plateFootprintAtRatio, plateRect, rectsOverlap, solveSeparation, computeExileRatio, clipSegmentToRect, placeExiledPlates } from './sc-separation';
import { layoutLine, faceForPx, averageAdvanceEm } from '../almagest/runtime';
import { getGenerator } from '../almagest/generator';
import d3 from "./d3";
// Task group W (header comment delta #17): the force-layout pipeline's
// main-thread client -- see that file's own header comment for why this
// is a plain factory, not a React hook, despite the filename.
import { createWorkerSim } from "./useWorkerSim";

// Outer module-scope bindings the IIFE below assigns into (plain
// `name = value`, no `var`/`let`/`const` inside the IIFE -- see delta #7
// above) so `export` statements at EOF, which must live at module top
// level, can see them. Each pairs with one of the original "10
// window.__d3* dev aliases" plus the two new hooks (`render`, `recolor`)
// delta #1/#6 introduce, plus `__vendorSetFilterDim` (delta #15, A1-3 --
// an 11th dev alias, `window.__d3SetFilterDim`). Naming: `render`/
// `recolor` get the brief's specified names; the rest keep their `__d3*`
// alias's suffix, camelCased, so the module export and the dev-console
// global are trivially cross-referenced.
var __vendorRender;
var __vendorRecolor;
var __vendorSetSelection;
var __vendorSetFilterDim;
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
    // Delta #32: SC layout separation (spec: the 2026-08-10 sc-layout-
    // separation plan, private). Budget = fraction of an SC's
    // scOverlayGeometry().maxReach (its fog reach, the closest thing to a
    // hull radius) that the post-settle correction may translate the whole
    // member-set by; measured in screen px at the 0.5x floor. Starting
    // value from the spec; re-set from __d3ScLayoutReport distributions.
    var SC_SEPARATION_BUDGET_RATIO = 0.5;
    // Final fix wave (Important #2, controller-ruled): floor on the per-SC
    // shift budget, screen px at the zoom floor (~one plate half-width).
    // Reach-scaled budgets starve exactly the small SCs whose nameplates
    // dominate their hulls (real data 2026-09-11: 21- and 15-page SCs got
    // ~25px budgets against ~150px plates and exiled at the default fit
    // view); the user's stated preference is that the supercluster moves
    // with its label.
    var SC_SEPARATION_BUDGET_MIN_PX = 60;
    var SC_EXILE_MARGIN_PX = 16;           // gap between cloud perimeter and an exiled plate's near edge (screen px)
    var SC_FIT_EXILE_MARGIN_PX = 12;       // 2026-09-13: fit (100%) includes every plate exiled AT fit, plus this screen-px margin
    var SC_EXILE_CLAMP_MODE = 'periphery';  // 'periphery' (2026-09-13 user direction: exiled plates stay on the cloud perimeter and may leave the viewport) | 'viewport' (radial clamp inside the viewport minus SC_EXILE_VIEWPORT_MARGIN_PX; the behavior shipped 2026-09-11)
    var SC_EXILE_VIEWPORT_MARGIN_PX = 28;  // same clearance updateEdgeChips uses
    var __scLayout = null;                 // per-layout separation record (see applyScLayoutSeparation / remeasureScLayout)
    var __scShiftW = {};                   // final fix wave: per-SC cumulative correction-pass shift, WORLD units (keyword -> number), written by applyScLayoutSeparation's movement phase, cleared at its top; remeasureScLayout reports shiftPx = __scShiftW[kw] * kFloor at whatever floor is current
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
    // World-space content bounds from the most recent fitToContent call --
    // the live zoom handler's pan-clamp reads it (render()'s `if
    // (contentBBox) {...}` pan-clamp block). Module-level (header comment
    // delta #19's finishRenderAfterSettle paragraph) rather than a
    // render()-local: promoted alongside lastCanvasDims/fitZoom/
    // currentZoomK below when the post-settle tail that used to set it
    // moved out of render()'s own closure.
    var contentBBox = null;
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

    // Task group W (header comment delta #19): the Web Worker sim client
    // (lib/graph/useWorkerSim.ts), created once and reused across every
    // render() call for this mount's lifetime -- `.start()` supersedes
    // any prior run itself, so this file doesn't need to track "is a sim
    // currently running." `__simRunCtx` holds the CURRENT run's
    // render()-local state (`nodes`/`root`/`opts`/etc) for
    // handleSimTick/handleSimEnd to read -- always reassigned at the TOP
    // of render(), same "module var read fresh each time" idiom
    // `currentData`/`rawData` already use in this file. `__simRafHandle`
    // is the pending rAF-scheduled callback for the CURRENT run --
    // whichever of scheduleSimPaint (per-tick, during ticking) or
    // scheduleSettleChunk (finishRenderAfterSettle's chunked tail, after
    // `end`) is active; the two never overlap in time (ticking has always
    // stopped by the time settle-chunking starts), so one handle safely
    // covers both. Cancelled whenever a settle chunk finishes, a
    // superseding render() call makes it stale, or final unmount disposes
    // it (fix round 1 below), so a leftover handle can never paint/draw
    // against a `__simRunCtx` that has already moved on.
    var __simClient = null;
    var __simRunCtx = null;
    var __simRafHandle = null;
    // Task group W fix round 1 (chunking finishRenderAfterSettle below):
    // the callback + the ctx it was scheduled for, for whichever settle
    // chunk `__simRafHandle` currently refers to -- stashed here (not just
    // closed over inside the rAF callback) so flushPendingSettleChunk can
    // invoke it immediately instead of waiting for the rAF/timeout to
    // fire. Dev/test-only escape hatch (window.__d3FlushSettleChunk,
    // wired below near the other window.__d3* aliases) for deterministic
    // synchronous "fast forward the settle tail to completion" in tests,
    // now that it spans multiple animation frames instead of one call.
    var __simPendingChunkFn = null;
    var __simPendingChunkCtx = null;

    // Sandbox-bar section gates (delta #8) -- single boolean per gated
    // concept, checked via early-return at the top of that concept's
    // entry function. Promotion flipped them on section-by-section across
    // A1-2 waves 1-6, each cited on its own key below: wave 1 flipped
    // `nebula` (task-A1-2-w1-brief.md), wave 2 flipped `watermark`, wave 3
    // flipped both `knot` and `edgeChip`, wave 5 flipped `lodNicety`, and
    // wave 6 flipped `tooltip` (wave 4 confirmed a different, gate-less
    // surface -- item 12 below, nothing here to flip). All six keys are
    // `true` now -- every section this scheme covers has been promoted.
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
    var plateFitScale = 1;  // delta #36: canvas-derived nameplate scale at fit; stays 1 until a canvas size is known
    var currentZoomK = 1;  // most recent zoom transform.k; used by updateLabelScale
    var zoomIndicatorPctEl = null;  // span inside the upper-right zoom indicator
    var edgeChipLayerEl = null;  // HTML overlay div holding the R6.2 edge chips
    // Header comment delta #34: the transform fitToContent last established,
    // plus the canvas center (`cx`/`cy`) it was centered on (fix review C1)
    // -- recorded BEFORE calling `zoomBehavior.transform` (fix review I1;
    // that call dispatches 'zoom' SYNCHRONOUSLY, so recording after it would
    // make the fit tick's own onViewChange fire against the stale PRIOR
    // reference point) -- the reference point onViewChange's fitX/fitY/fitK/
    // cx/cy report, so Starfield.tsx's parallax offset is measured from
    // "how far the graph has panned since it was last fit," not from an
    // arbitrary origin, and a pure zoom about that same center reports zero
    // pan. null until the first fitToContent call for this mount/remount.
    var __fitTransform = null;

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
        scName:  { k_min: 0.75, k_max: 2.00 },  // was 1.00 until 2026-09-11 (P3, delta #32): screen-constant names grew their WORLD footprint as zoom shrank, which is what made side-by-side nameplates collide at the floor
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
    // Delta #36 (spec docs/project-plans/2026-09-23-151626-nameplate-lod-fit-
    // scale/): plate size at fit tracks the CANVAS. The two BASE_SC_* values
    // above are the FULL-SIZE ceiling -- any canvas whose smaller side is
    // >= SC_PLATE_FIT_REF_PX paints exactly today's 100px icon / 22px name
    // at 100%; smaller canvases scale both down together (one shared scale,
    // so the plate keeps its proportions) until the name would drop below
    // SC_NAME_FIT_FLOOR_PX painted, where the floor holds and the fit
    // absorbs the rest, as it always did. Both tuner-exposed (typo-gated,
    // TUNER_TYPO_VERSION 5). Other label classes are NOT scaled (decision
    // record #4).
    var SC_PLATE_FIT_REF_PX = 640;
    var SC_NAME_FIT_FLOOR_PX = 12;
    /** Delta #36: pure. `w`/`h` are the fit's own canvas dims -- `h` already
     *  search-bar-adjusted by the caller (effectiveCanvasHeight), exactly the
     *  pair fitToContent receives. Returns 1 for a degenerate canvas or a
     *  floor at/above the base (nothing to scale). */
    function plateFitScaleFor(w, h) {
        if (!(w > 0) || !(h > 0)) return 1;
        var floorRatio = BASE_SC_NAME_FONT_SIZE > 0 ? SC_NAME_FIT_FLOOR_PX / BASE_SC_NAME_FONT_SIZE : 0;
        if (!(floorRatio < 1)) return 1;
        var s = Math.min(w, h) / SC_PLATE_FIT_REF_PX;
        if (!(s < 1)) return 1;
        return s < floorRatio ? floorRatio : s;
    }
    // Almagest optical tiers (theme.css @font-face; fonts/almagest/README.md
    // §3). Chosen by PAINTED px, not CSS px: SC names are screen-clamped via
    // scName, so painted = nameFontSize * currentZoomK. Metrics are frozen
    // across the three faces, so a swap never moves a glyph.
    // Delta #33 (review fix): the hand-typed ALMAGEST_DISPLAY_MIN_PX /
    // ALMAGEST_MID_MIN_PX breakpoints are gone -- almagestFace defers the
    // whole tier decision to lib/almagest/runtime's faceForPx, which reads
    // the generator's TIERS.*.min directly, so the vendor no longer needs
    // its own copies of those numbers at all (grepped: nothing else in the
    // file read either name).
    var __almagestPreview = null;  // AlmagestParams while the dev tuner previews, else null
    // Batch A (spec: the 2026-09-13 graph-interaction-followups plan,
    // private): dev-only debug aid, off by default and never set outside
    // the NODE_ENV-gated window.__d3SetAlmagestTierTint hook below --
    // removable in full by deleting this flag, TIER_TINT, the hook, and the
    // two renderScName reads of __almagestTierTint.
    var __almagestTierTint = false;
    var TIER_TINT = { Display: '#ff7a59', Mid: '#4fc3f7', Text: '#c5e17a' };  // orange / sky / lime -- distinct on every dark palette
    function almagestFace(paintedPx) {
        // faceForPx (lib/almagest/runtime) is the single source for the
        // tier decision, including its own float-noise epsilon -- see that
        // module's comment for why 1e-6 (not this file's former 0.01,
        // which contradicted the runtime's own breakpoint test).
        var face = faceForPx(paintedPx, __almagestPreview || undefined);
        return '"Almagest ' + face + '", "Georgia", serif';
    }
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
    var ICON_LOD_FADE_ON_ZOOM_IN = false;  // 2026-09-13 user direction: SC icons persist at every zoom-in level; the R6.1 zoom-in fade below stays in the code behind this switch. ICON_LOD_FADE_START/END keep their tuner exposure but are inert while this is false.

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
    //
    // Batch 03 Task group B (header comment delta #16): this value now
    // comes from the `TUNER_TYPO_VERSION` import above (lib/graph/
    // constants.ts) instead of a locally-declared `var` -- the two had
    // been duplicated literals (S-group triage finding) since Task S1
    // transcribed GRAPH_DEFAULTS from this same file; constants.ts is now
    // the single source both this file and lib/graph/tuner-snapshot.ts
    // (the TS port of this function's own gating semantics, used at the
    // React mount boundary -- see that module's header comment) read from.

    // Fog schema version for saved tuner profiles -- same precedent as
    // TUNER_TYPO_VERSION above, scoped to the two nebula-size knobs. T3
    // (2026-07-14) re-baselined the fog to NEBULA_RADIUS_MULT 9; profiles
    // saved before that pin mult 16-20, which doubles the rendered fog and
    // defeats fitToContent's fog-aware padding (NEBULA_FIT_CORE) -- the
    // cloud balloons back out past the pad the fit computed for it.
    // applyTunerSnapshot therefore applies NEBULA_RADIUS_MULT/
    // NEBULA_MIN_RADIUS only from snapshots stamped with the CURRENT fog
    // version; HULL_PADDING is not part of the T3 re-baseline and stays
    // ungated. Re-saving a profile from the tuner re-stamps it. Also now
    // imported from constants.ts (delta #16, see the TYPO_VERSION comment
    // above for the full unification rationale) instead of a local `var`.

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
    // Task A1-3 (header comment delta #15): a SECOND, independent highlight
    // set -- NavProvider's filterHighlightIds (diary-window filter dimming),
    // written exclusively by the new setFilterDim(nodeIds) export. Kept
    // deliberately separate from the four selection vars above (which
    // updateHighlighting()'s pre-existing branches remain mutually
    // exclusive over) rather than routed through selectedNodeIds -- doing
    // that would silently CLOBBER a concurrent node/cluster selection
    // instead of layering both (the A1-1-ratified gap). null/empty means
    // "no filter active, this layer dims nothing" (mirrors NavState's own
    // [] "no highlights" representation, lib/nav.ts).
    var filterDimNodeIds = null;
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
            if (typeof snap.SC_PLATE_FIT_REF_PX === 'number') SC_PLATE_FIT_REF_PX = snap.SC_PLATE_FIT_REF_PX;
            if (typeof snap.SC_NAME_FIT_FLOOR_PX === 'number') SC_NAME_FIT_FLOOR_PX = snap.SC_NAME_FIT_FLOOR_PX;
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

    // Almagest arrives lazily: the first draw requests the TTF and measures
    // SC names in the fallback face, so caption placement is computed against
    // the wrong rects until the next zoom tick (observed 2026-09-11: captions
    // parked on top of SC names for as long as the view stayed still). Treat
    // a font arrival as a zero-delta zoom tick. 'loadingdone' fires once per
    // font batch, so this runs a handful of times per page life.
    if (typeof document !== 'undefined' && document.fonts &&
        typeof document.fonts.addEventListener === 'function') {
        document.fonts.addEventListener('loadingdone', function () {
            if (!svg || !(currentZoomK > 0)) return;
            // Mirror the zoom handler's post-transform calls (.on('zoom', ...)
            // above), placement-affecting ones only: updateLabelLOD re-derives
            // hull-label opacity and (re)schedules the collision cull, which
            // reads SC-name screen bboxes as obstacles -- those bboxes just
            // changed width/height now that Almagest replaced the fallback
            // face. updateLabelScale repositions group captions + redraws
            // watermarks against the now-correct metrics. updateEdgeChips
            // stays last, same as the zoom handler (R6.2: depends on the
            // transform/centroids updateLabelScale just refreshed). Skipped:
            // updateZoomIndicator (UI text only, not placement) and the
            // transform assignment itself (this is a zero-delta tick).
            updateLabelLOD(currentZoomK);
            updateLabelScale(currentZoomK);
            updateEdgeChips();
        });
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
        })
            // Task group W (header comment delta #18): re-apply position on
            // every call, not just at creation -- reused as the live-tick
            // paint path once the force sim moved to a Web Worker (item 19).
            // Harmless before W2 too: cx/cy already equalled d.x/d.y in the
            // old synchronous-layout world, this just re-asserts the same
            // value every zoom/arm/disarm call instead of leaving it as a
            // one-time-only assignment.
            .attr('cx', function (d) { return d.x; })
            .attr('cy', function (d) { return d.y; });
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

    /** Delta #32 (Task 5): point the plate's leader line at the plate's
     *  CURRENT footprint edge (the plate moves during the glide; the dot
     *  never does). No-op for plates without a leader. */
    function updateLeaderEnd(plateEl) {
        if (!plateEl || !svg) return;
        var kw = plateEl.getAttribute('data-sc');
        if (!kw) return;
        var leader = svg.select('.graph-root').select('.watermarks').select('.watermark-leaders')
            .selectAll('g.watermark-leader').filter(function () { return this.getAttribute('data-sc') === kw; });
        if (leader.empty()) return;
        var m = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(plateEl.getAttribute('transform') || '');
        if (!m) return;
        var tx = parseFloat(m[1]), ty = parseFloat(m[2]);
        var cx = tx + parseFloat(plateEl.getAttribute('data-plate-cx') || '0');
        var cy = ty + parseFloat(plateEl.getAttribute('data-plate-cy') || '0');
        var hw = parseFloat(plateEl.getAttribute('data-plate-hw') || '0');
        var hh = parseFloat(plateEl.getAttribute('data-plate-hh') || '0');
        var line = leader.select('line.watermark-leader-line');
        var x1 = parseFloat(line.attr('x1')), y1 = parseFloat(line.attr('y1'));
        // Review fix (Task 5 follow-up): at the START of an anchored->exiled
        // glide the plate rect still CONTAINS the anchor (x1,y1) -- clipping
        // a segment from a point INSIDE the rect toward its own center exits
        // on the FAR side, drawing the leader straight through the plate for
        // the first few frames. Zero-length (dot-only) leader while the
        // anchor is still inside the rect; clipSegmentToRect only makes
        // sense once the anchor is genuinely outside it.
        if (Math.abs(x1 - cx) <= hw && Math.abs(y1 - cy) <= hh) {
            line.attr('x2', x1).attr('y2', y1);
            return;
        }
        var end = clipSegmentToRect(x1, y1, cx, cy, { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh });
        line.attr('x2', end.x).attr('y2', end.y);
    }

    /** Delta #32 (Task 5): shared "is this SC actually painted" test --
     *  previously duplicated between applyScLayoutSeparation's scKeys
     *  filter (Task 3) and drawWatermarks' per-keyword loop guard. A
     *  keyword is painted only when it has a super_clusters entry with an
     *  icon_id AND that icon has actually mounted (__mountedIcons, was
     *  window.__superClusterIcons -- header comment delta #5). Returns
     *  `{ sc, icon }` or null. */
    function paintedScEntry(keyword) {
        if (!currentData) return null;
        var superClusters = currentData.super_clusters || [];
        var sc = null;
        for (var i = 0; i < superClusters.length; i++) {
            if (superClusters[i].keyword === keyword) { sc = superClusters[i]; break; }
        }
        if (!sc || !sc.icon_id || !__mountedIcons) return null;
        var icon = __mountedIcons[sc.icon_id];
        if (!icon) return null;
        return { sc: sc, icon: icon };
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
        // Delta #33 (review fix): `.supercluster-label`, not `text.
        // supercluster-label` -- a dev preview renders the name as a <g>
        // (renderScName), and this pass only calls computedOpacity/
        // screenBBoxOf, both of which work on either tag.
        svg.selectAll('.supercluster-label, text.group-label').each(function () {
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
        // Delta #33 (review fix): `.supercluster-label`, not `text.
        // supercluster-label` -- see runLabelCull's own comment above for
        // why the tag prefix must not gate a preview <g> out of this pass.
        svg.selectAll('.supercluster-label').each(function () {
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
    // Soft chars per wrapped SC-name line. Almagest averages 0.83em per
    // glyph (caps-only, frozen across tiers), so 12 chars ≈ 10em, about the
    // width 14 chars filled in the previous mixed-case face. Shared by
    // wrapLabelLines (drawWatermarks) and computeWatermarkBBox's estimate so
    // layout and paint agree.
    var SC_NAME_LINE_BUDGET = 12;
    // Per-char width for computeWatermarkBBox's SC-name estimate at its 30px
    // reference size: Almagest advances average 0.83em (caps-only, identical
    // across tiers), so 30 * 0.83 ≈ 25. Both constants also ride the sim
    // worker payload (scNameLineBudget / scNameCharWidth) so the worker's
    // mirror of computeWatermarkBBox (sim-layout.ts) estimates the same rect.
    // Delta #33: derived from the generator's average A-Z advance at the
    // estimator's 30px reference size (was the hand-typed 25 = 0.83em x 30).
    var SC_NAME_CHAR_WIDTH = Math.round(averageAdvanceEm() * 30 * 100) / 100;

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
        // Per-char width: module-scope SC_NAME_CHAR_WIDTH (face-dependent).

        var nameText = (scKeyword || '').slice(0, 36);
        var lines = estimateLabelLines(nameText, SC_NAME_LINE_BUDGET);
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
     * @param {number} perLineBudget  soft char budget per line — callers pass SC_NAME_LINE_BUDGET
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

    /** Delta #33: one place that paints an SC name. Default = the <text>
     *  element the R6 era always drew. With a dev preview active
     *  (__almagestPreview), a <g class="supercluster-label"> of one <path>
     *  per glyph laid out by lib/almagest/runtime -- same class, and every
     *  consumer (runLabelCull, positionGroupCaptions' obstacle re-add) only
     *  selects `.supercluster-label` and calls computedOpacity/screenBBoxOf
     *  on it, both of which a <g> satisfies just as well as a <text>
     *  (collectObstacleRects measures the enclosing g.watermark instead, so
     *  it never looks at this element's tag at all).
     *  `opts`: { x, y, fontPx, paintedPx, opacity }. y is the visual top of
     *  line 0 (the text uses dominant-baseline: hanging); glyph paths are
     *  y-up with baseline 0 and cap height CAP, so
     *  each line is translated to (x - advance*s/2, y + CAP*s + i*1.15*fontPx)
     *  and scaled (s, -s) with s = fontPx / UPEM. */
    function renderScName(g, lines, opts) {
        if (!__almagestPreview) {
            var labelEl = g.append('text')
                .attr('class', 'supercluster-label')
                .attr('x', opts.x)
                .attr('y', opts.y)
                // dominant-baseline="hanging" anchors y at the visual top of
                // the glyph rather than the baseline, so the padding between
                // icon bottom and label top stays exactly the caller's pad
                // (SC_LABEL_TOP_PAD * iconScale) at any font size.
                .attr('dominant-baseline', 'hanging')
                // Use .style() not .attr() — inline style overrides the
                // theme.css `.supercluster-label { font-size: 30px }` rule;
                // SVG presentation attributes do not.
                .style('font-size', opts.fontPx + 'px')
                // Tier by painted size (= world font size x zoom); re-evaluated every zoom tick since this draw reruns then.
                .style('font-family', almagestFace(opts.paintedPx))
                .style('opacity', opts.opacity)
                // Delta #32 (mirrors R6.1's icon rule): once the LOD fade has
                // effectively completed, drop the text out of bbox/hit-testing
                // entirely -- opacity:0 text still reserves its footprint in
                // screenBBoxOf, so the R6 resolver and collectObstacleRects
                // kept denying that space for a name that was not painted.
                .style('display', opts.opacity > 0.05 ? null : 'none');
            if (__almagestTierTint) {
                // Batch A debug aid: tint by the same face the font-family
                // above just picked, so the color always matches what's
                // actually painted.
                var tintFace = faceForPx(opts.paintedPx, __almagestPreview || undefined);
                labelEl.style('fill', TIER_TINT[tintFace]);
            }
            lines.forEach(function (line, i) {
                labelEl.append('tspan').attr('x', opts.x).attr('dy', i === 0 ? 0 : '1.15em').text(line);
            });
            return labelEl;
        }
        var gen = getGenerator();
        var s = opts.fontPx / gen.UPEM;
        var face = faceForPx(opts.paintedPx, __almagestPreview);
        var grp = g.append('g')
            .attr('class', 'supercluster-label')
            .attr('data-almagest-preview', '1')
            .style('opacity', opts.opacity)
            .style('display', opts.opacity > 0.05 ? null : 'none');
        lines.forEach(function (line, i) {
            var laid = layoutLine(line, face, __almagestPreview);
            var lineG = grp.append('g').attr('transform',
                'translate(' + (opts.x - laid.advance * s / 2) + ',' + (opts.y + gen.CAP * s + i * 1.15 * opts.fontPx) + ') scale(' + s + ',' + (-s) + ')');
            laid.glyphs.forEach(function (gl) {
                // Review fix: theme.css's `.watermark path { stroke: var(--ink) }`
                // rule matches these glyph paths too (they live inside
                // g.watermark) -- a CSS presentation attribute loses to it, so
                // the hairline stroke must be killed with .style(), not .attr().
                // Batch A debug aid: tint overrides the default ink fill so
                // the preview path glyphs match the <text> branch's tint.
                lineG.append('path').attr('d', gl.d).attr('fill', __almagestTierTint ? TIER_TINT[face] : 'var(--ink)')
                    .style('stroke', 'none')
                    .attr('transform', 'translate(' + gl.x + ',0)');
            });
        });
        return grp;
    }

    // Delta #29 module state: nameplate glide (see the big comment block
    // above the application pass inside drawWatermarks below for the full
    // design rationale -- this is just the state it needs). Carries the R6
    // deconfliction pass's APPLIED displacement between one zoom tick's
    // drawWatermarks() call and the next, and between rAF frames that
    // happen entirely outside of any draw call at all. Must live here, at
    // the enclosing IIFE's true module scope -- NOT declared inside
    // drawWatermarks alongside WM_PAD below, which is harmless to
    // redeclare on every call since it's a constant literal never read
    // outside that one function. This object is the ONLY thing
    // remembering "where the plate is actually painted" from one call to
    // the next -- redeclaring it inside drawWatermarks would reset it to
    // empty on every single call and erase the glide before it ever moved
    // anything.
    // Keyed by each watermark's `data-sc` keyword, which is stable across
    // redraws even though the `g.watermark` DOM node itself is torn down
    // and rebuilt every call (layer.selectAll('*').remove() below).
    //   offsets: applied world-space {x,y} actually painted, per keyword
    //   targets: resolver's latest target world-space {x,y}, per keyword
    //   anchors: this draw's anchored (pre-deconfliction) world position,
    //            per keyword -- lets a later rAF frame compose
    //            anchor + offset without re-measuring anything
    //   lastTs:  timestamp (ms) of the last applied step, or 0 before the
    //            first ever step
    //   raf:     pending rAF id if a continuation is scheduled, else 0
    var __wmGlide = { offsets: {}, targets: {}, anchors: {}, lastTs: 0, raf: 0 };

    // Delta #29 tuning constants. Declared here, at module scope, rather
    // than alongside WM_PAD inside drawWatermarks below (a function-local
    // var, harmlessly redeclared on every call) -- wmGlideStep is a
    // SEPARATE function that runs on its own rAF cadence, entirely outside
    // any drawWatermarks() call, and needs these same two values to keep
    // its step math identical to the draw-time application pass'
    // (wmGlideStepOffset, just below, needs WM_GLIDE_SNAP_PX directly for
    // the same reason). WM_PAD itself stays put -- only the resolver above
    // reads it, and that code is untouched by this delta.
    var WM_GLIDE_TAU_MS = 90;     // exponential time constant (ms)
    var WM_GLIDE_SNAP_PX = 0.5;   // screen-space convergence epsilon (px, at the current zoom k)

    // Delta #29: a SELF-CONTAINED feature-detected rAF pair, deliberately
    // NOT the file's existing __rafSchedule/__rafCancel (defined much
    // further below, alongside the task-group-W web-worker sim glue).
    // Those two are themselves a De-Dash delta (header comment delta #19
    // area) -- Next-only, added for this port's worker-driven settle
    // chunking -- so explorer's copy of this shared region has neither
    // binding at all, and a verbatim mirror of a call to them would throw
    // ReferenceError there the first time a glide actually goes
    // unconverged. Same feature-detection shape as those helpers' own
    // jsdom fallback (jsdom implements no requestAnimationFrame at all):
    // real rAF when available, else setTimeout(cb, 16) -- just scoped
    // locally here so this pass has zero dependency on any Next-only
    // symbol and mirrors byte-for-byte into explorer.
    var __wmRafSchedule = (typeof requestAnimationFrame === 'function')
        ? function (cb) { return requestAnimationFrame(cb); }
        : function (cb) { return setTimeout(cb, 16); };
    var __wmRafCancel = (typeof cancelAnimationFrame === 'function')
        ? function (id) { cancelAnimationFrame(id); }
        : function (id) { clearTimeout(id); };

    /** Delta #29 shared step: advances `prevOffset` toward `targetOffset`
     *  by one exponential-decay step of size `alpha`, unless the two are
     *  already within WM_GLIDE_SNAP_PX of each other on screen at the
     *  given zoom k -- in which case it snaps straight to the target
     *  rather than asymptotically crawling the last fraction of a pixel
     *  forever (float noise never fully reaches 0). A missing `prevOffset`
     *  (nothing to glide FROM -- first time this keyword has ever been
     *  placed) also snaps. Used by both the draw-time application pass and
     *  the rAF continuation below so the two can never disagree about
     *  whether a given step has converged. */
    function wmGlideStepOffset(prevOffset, targetOffset, alpha, zoomK) {
        if (!prevOffset) return { offset: targetOffset, converged: true };
        var dx = targetOffset.x - prevOffset.x;
        var dy = targetOffset.y - prevOffset.y;
        var deltaScreenPx = Math.sqrt(dx * dx + dy * dy) * (zoomK || 1);
        if (deltaScreenPx <= WM_GLIDE_SNAP_PX) {
            return { offset: targetOffset, converged: true };
        }
        return {
            offset: { x: prevOffset.x + dx * alpha, y: prevOffset.y + dy * alpha },
            converged: false,
        };
    }

    /** Delta #29: fully clears the glide state maps -- used on
     *  drawWatermarks' own early-return paths below (icons not mounted
     *  yet, or zero super_clusters in the current data) where EVERY
     *  existing g.watermark just got torn down (layer.selectAll('*')
     *  .remove(), just above those checks) with nothing rebuilt in its
     *  place. Without this, a keyword that later reappears (icons finish
     *  loading, or super_clusters becomes non-empty again) would glide
     *  from whatever offset was left over instead of snapping fresh --
     *  the same class of staleness the application pass's own per-keyword
     *  pruning loop (below) already guards against for a single keyword
     *  disappearing while others stay put; this is the "all of them
     *  disappeared at once" case that loop never gets a chance to run
     *  for, since these paths return before reaching it. The
     *  screenBBoxOf-null case inside the resolver loop (a still-present
     *  element that just isn't measurable this draw) deliberately does
     *  NOT reset anything here -- that entry's prior state is still valid
     *  and correct to glide from once it becomes measurable again. */
    function wmGlideReset() {
        __wmGlide.offsets = {};
        __wmGlide.targets = {};
        __wmGlide.anchors = {};
    }

    function drawWatermarks(root, clusters) {
        if (!SANDBOX_SECTION_GATES.watermark) return;  // S2 sandbox-bar gate (header comment delta #8)

        // Delta #29: this draw call is the sole authority on where every
        // nameplate ends up -- cancel any rAF continuation still in flight
        // from a PRIOR draw so its (now-superseded) target can never win a
        // race against the fresh resolver output computed below. The
        // application pass at the end of this function reschedules its own
        // continuation if one is still needed.
        if (__wmGlide.raf) { __wmRafCancel(__wmGlide.raf); __wmGlide.raf = 0; }

        var layer = root.select('.watermarks');
        layer.selectAll('*').remove();

        if (!__mountedIcons) {  // was window.__superClusterIcons (header comment delta #5)
            wmGlideReset();  // delta #29: every watermark just got torn down above with nothing to reappear yet
            return;
        }
        var superClusters = currentData && currentData.super_clusters || [];
        if (!superClusters.length) {
            wmGlideReset();  // delta #29: same as above -- nothing left to glide toward
            return;
        }

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

        // ── Delta #32: anchors first, then exile placement for overflow plates ──
        var fpParams = scFootprintParams();
        var zoomRatio = (fitZoom > 0) ? (currentZoomK / fitZoom) : 1;
        var anchorByKw = {};
        for (var kw0 in groups) {
            var ax0 = 0, ay0 = 0, an0 = 0;
            groups[kw0].forEach(function (mc) { var cen = centroids[mc.id]; if (cen) { ax0 += cen.x; ay0 += cen.y; an0++; } });
            if (an0) anchorByKw[kw0] = { x: ax0 / an0, y: ay0 / an0 };
        }
        var exileCenter = {};
        if (__scLayout && __scLayout.plates) {
            var exItems = [];
            for (var kw1 in groups) {
                var info1 = __scLayout.plates[kw1];
                var a1 = anchorByKw[kw1];
                if (!info1 || !info1.overflow || !a1 || !(currentZoomK < info1.kExile)) continue;
                exItems.push({ key: kw1, ax: a1.x, ay: a1.y, fp: plateFootprintAtRatio(kw1, zoomRatio, fpParams) });
            }
            if (exItems.length) {
                var env = { cx: __scLayout.cloudCentroid.x, cy: __scLayout.cloudCentroid.y, bbox: __scLayout.cloudBBox, k: currentZoomK || 1, marginPx: SC_EXILE_MARGIN_PX };
                // Item 3 (2026-09-13): env.viewport only gets populated in
                // 'viewport' mode -- placeExiledPlates treats a missing
                // viewport as "no clamp" (periphery mode's default), so
                // exiled plates stay on the cloud perimeter and may leave
                // the viewport instead of being radially clamped inside it.
                if (SC_EXILE_CLAMP_MODE === 'viewport') {
                    var vpNode = svg && svg.select('.graph-root').node();
                    var vctm = vpNode && vpNode.getScreenCTM ? vpNode.getScreenCTM() : null;
                    var vrect = __mountedContainer ? __mountedContainer.getBoundingClientRect() : null;
                    if (vctm && vctm.a > 0 && vctm.d > 0 && vrect && vrect.width > 0 && vrect.height > 0) {
                        env.viewport = { a: vctm.a, d: vctm.d, e: vctm.e, f: vctm.f, left: vrect.left, top: vrect.top, width: vrect.width, height: vrect.height, marginPx: SC_EXILE_VIEWPORT_MARGIN_PX };
                    }
                }
                var placed = placeExiledPlates(exItems, env);
                exItems.forEach(function (it) { exileCenter[it.key] = { x: placed[it.key].x, y: placed[it.key].y }; });
            }
        }
        var leaderLayer = layer.append('g').attr('class', 'watermark-leaders');  // painted beneath the plates

        for (var keyword in groups) {
            var memberClusters = groups[keyword];
            var painted = paintedScEntry(keyword);
            if (!painted) continue;
            var sc = painted.sc, icon = painted.icon;

            var anchorPt = anchorByKw[keyword];
            if (!anchorPt) continue;
            var wcx = anchorPt.x, wcy = anchorPt.y;

            var color = nebulaColor(clusterColorMap[memberClusters[0].id] || fallbackColor());

            // Apply tuner-driven scaling (clamped per SCALE_THRESHOLDS)
            // using the most-recent zoom k. SC name uses its own scale,
            // independent of the icon, so they tune separately.
            var iconScale = clampedScale(currentZoomK, 'scIcon');
            var nameScale = clampedScale(currentZoomK, 'scName');
            // Delta #36: the canvas-derived plate-fit scale multiplies the
            // BASE sizes (and the icon->name pad passed to renderScName
            // below) so the whole plate scales down uniformly on small
            // canvases; the fit-ratio bands (clampedScale) apply on top,
            // unchanged, so zoom behavior around fit is exactly as before.
            var ICON_SIZE = BASE_SC_ICON_SIZE * plateFitScale * iconScale;
            var nameFontSize = BASE_SC_NAME_FONT_SIZE * plateFitScale * nameScale;

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

            // Delta #32: anchored placement is what R6 always drew; an
            // overflow plate below its kExile is instead centered on its
            // peripheral exile point. Both are recorded on the element so
            // the glide (application pass + wmGlideStep) can compose
            // anchor + offset and animate anchored<->exiled transitions.
            var fpNow = plateFootprintAtRatio(keyword, nameRatio, fpParams);
            var kInv = 1 / (currentZoomK || 1);
            var plateCxW = ICON_SIZE / 2 + ((fpNow.left + fpNow.right) / 2) * kInv;   // world offset from translate origin to footprint center
            var plateCyW = ICON_SIZE / 2 + ((fpNow.top + fpNow.bottom) / 2) * kInv;
            var plateHwW = ((fpNow.right - fpNow.left) / 2) * kInv;
            var plateHhW = ((fpNow.bottom - fpNow.top) / 2) * kInv;
            var anchoredTx = wcx - ICON_SIZE / 2, anchoredTy = wcy - ICON_SIZE / 2;
            var ex = exileCenter[keyword];
            var tx0 = ex ? ex.x - plateCxW : anchoredTx;
            var ty0 = ex ? ex.y - plateCyW : anchoredTy;

            // Rethink R6.1: past ICON_LOD_FADE_START you're inside the
            // galaxy -- the big icon fades out and the nameplate hands off
            // to an edge chip (updateEdgeChips) for wayfinding. 2026-09-13:
            // gated behind ICON_LOD_FADE_ON_ZOOM_IN (default false) -- the
            // user's rule is nothing disappears as you zoom in, so the icon
            // now just stays fully opaque; the fade math is kept, inert,
            // for the switch to flip back on.
            var iconOpacity;
            if (!ICON_LOD_FADE_ON_ZOOM_IN) iconOpacity = 1;
            else if (nameRatio <= ICON_LOD_FADE_START) iconOpacity = 1;
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
                .attr('transform', 'translate(' + tx0 + ',' + ty0 + ')')
                // Delta #32: anchored translate + footprint geometry, read
                // back by the glide (anchor source) and by updateLeaderEnd
                // (leader clipping) -- see this function's own header note.
                .attr('data-anchor-x', anchoredTx)
                .attr('data-anchor-y', anchoredTy)
                .attr('data-plate-cx', plateCxW)
                .attr('data-plate-cy', plateCyW)
                .attr('data-plate-hw', plateHwW)
                .attr('data-plate-hh', plateHhW)
                .attr('data-exiled', ex ? '1' : null)
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
                var lines = wrapLabelLines(displayName, SC_NAME_LINE_BUDGET);

                // Pad scales with the icon's clamp factor so the icon->name
                // gap stays screen-stable like the icon itself (R3.2: band
                // growth must track scIcon k_max) -- see renderScName for
                // the hanging-baseline / painted-size-tier machinery this y
                // and paintedPx feed.
                renderScName(g, lines, {
                    x: ICON_SIZE / 2,
                    y: ICON_SIZE + SC_LABEL_TOP_PAD * plateFitScale * iconScale,
                    fontPx: nameFontSize,
                    paintedPx: nameFontSize * currentZoomK,
                    opacity: nameOpacity,
                });
            }

            // Delta #32: exiled plates keep a dot at the SC's true anchor
            // and a straight leader back to the plate -- the leader lives
            // in leaderLayer (appended before any plate, so it paints
            // beneath every plate) rather than inside `g` itself, since the
            // dot must stay fixed at the anchor while `g` glides to its
            // exile position.
            if (ex) {
                var lg = leaderLayer.append('g')
                    .attr('class', 'watermark-leader')
                    .attr('data-sc', keyword);
                lg.append('line')
                    .attr('class', 'watermark-leader-line')
                    // 2026-09-13 user direction: opaque white, not the SC's
                    // nebula color -- all eight palettes are dark.
                    .attr('stroke', '#ffffff')
                    .attr('stroke-width', 1.25 * kInv)
                    .attr('x1', wcx).attr('y1', wcy)
                    .attr('x2', wcx).attr('y2', wcy);   // real end set by updateLeaderEnd below
                lg.append('circle')
                    .attr('class', 'watermark-anchor-dot')
                    .attr('cx', wcx).attr('cy', wcy)
                    .attr('r', 4 * kInv)
                    // 2026-09-13 user direction: opaque white fill, no
                    // outline (stroke-width dropped along with the color).
                    .attr('fill', '#ffffff')
                    .attr('cursor', 'pointer')
                    .style('pointer-events', 'all')
                    .on('mouseenter', (function (kw, members) {
                        return function (event) {
                            var pages = 0;
                            members.forEach(function (mc) { pages += (mc.page_ids || []).length; });
                            showLinesTooltip(event, [kw, members.length + ' topics · ' + pages + ' pages']);
                        };
                    })(keyword, memberClusters))
                    .on('mouseleave', hideTooltip)
                    .on('click', (function (kw) {
                        return function (event) {
                            event.stopPropagation();
                            frameWorldBBox(scWorldBBox(kw), { maxRatio: 1.2, minRatio: 0.6 });
                        };
                    })(keyword));
                updateLeaderEnd(g.node());
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
            wmEntries.push({ el: this, pages: +this.getAttribute('data-pages') || 0, exiled: this.getAttribute('data-exiled') === '1' ? 1 : 0 });
        });
        // Task 7: anchored plates are placed first (they hold their spot by
        // construction); exiled plates, which the viewport clamp may have
        // pulled inward, are placed last so any residual collision moves the
        // exiled plate, never an anchored one.
        wmEntries.sort(function (a, b) { return (a.exiled - b.exiled) || (b.pages - a.pages); });
        var WM_PAD = 2;
        // Delta #29's WM_GLIDE_TAU_MS / WM_GLIDE_SNAP_PX tuning constants
        // live at module scope (just above this function), not here --
        // the rAF continuation that also needs them (wmGlideStep, just
        // below this function) runs outside any drawWatermarks() call, so
        // a function-local var here would be invisible to it. See the
        // application pass below (after this resolver) for what they do.
        var wmPlaced = [];
        wmEntries.forEach(function (e) {
            var r = screenBBoxOf(e.el);
            if (!r) return;
            // Delta #29: record this draw's anchored (pre-deconfliction)
            // position before the resolver below potentially nudges it --
            // the application pass diffs the resolver's FINAL transform
            // against THIS anchor to get the target displacement to glide
            // toward, never the previously-applied (possibly still
            // mid-glide) transform.
            //
            // Delta #32: the glide's anchor is the ANCHORED translate
            // recorded at build time, not the current transform -- for an
            // exiled plate the current transform already includes the
            // exile displacement, which must glide like any other offset.
            var anchorM = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(e.el.getAttribute('transform') || '');
            var dax = e.el.getAttribute('data-anchor-x'), day = e.el.getAttribute('data-anchor-y');
            e.ax = dax != null ? parseFloat(dax) : (anchorM ? parseFloat(anchorM[1]) : 0);
            e.ay = day != null ? parseFloat(day) : (anchorM ? parseFloat(anchorM[2]) : 0);
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

        // ── Delta #29: temporal glide of the APPLICATION ──────────────────
        // The resolver above is, by design, left exactly as it was: a
        // stateless function of the current zoom k that can jump
        // discontinuously between one tick and the next. The "R6 scope
        // addition" comment above explains why -- a genuine three-body
        // pinch has no continuous escape (the cycle-detection fallback's
        // first down-only push is a real, unavoidable cliff at the instant
        // the pinch closes), and the icon-fade `display:none` flip
        // (drawWatermarks' own iconOpacity gate, above) discretely shrinks
        // a measured footprint the moment it crosses the fade threshold,
        // which is a cliff in the resolver's INPUT, not a bug in its
        // output. Live CDP capture (logs/visual-debug/sc-watermark-zoom-
        // jump/01-repro/) measured a single 2% wheel notch moving a
        // nameplate ~557 screen px on the pinch cliff and ~657 px on the
        // icon-fade cliff -- applied instantly via setAttribute as the
        // resolver loop above always has, either cliff is a user-visible
        // teleport.
        //
        // This pass does not touch WHAT the target is, only HOW FAST the
        // painted transform is allowed to move toward it: each watermark's
        // applied world-space offset from its anchor exponentially
        // approaches the resolver's target offset (time constant
        // WM_GLIDE_TAU_MS), continuing across animation frames via the
        // rAF continuation below for as long as any keyword hasn't yet
        // converged -- so a target cliff renders as a fast slide instead
        // of a jump, and a small, continuous adjustment (the common case)
        // is imperceptibly quick regardless. Idempotence-by-construction
        // is preserved: at rest (no zoom activity), every keyword's
        // applied offset settles to EXACTLY its target offset -- nothing
        // here accumulates error, because both anchors and targets are
        // recomputed from scratch every single draw (module state above)
        // and the glide only ever decays a fresh delta toward a fresh
        // target, never carries forward a stale one.
        //
        // dt is meant to model ONE ANIMATION-FRAME interval, not however
        // long has elapsed since the last draw -- clamped to 34ms (~2
        // frames) and defaulting to 17ms (~1 frame) when lastTs is unset,
        // rather than the wider [0,200]/200 this originally shipped with.
        // Live CDP micro-trace evidence (logs/visual-debug/sc-watermark-
        // zoom-jump/02-verify/micro-next.json) caught the bug the wider
        // clamp allowed: a zoom PAUSE (any gap, not just a genuinely idle
        // tab) leaves `lastTs` stale, so the next tick's dt saturated at
        // 200ms -> alpha = 1-exp(-200/90) ~= 0.89 applied in a SINGLE
        // frame -- ~92% of a 542px cliff, still visually a teleport for a
        // lone wheel notch after a pause. The rAF continuation (below) is
        // what's supposed to render the traversal across many frames; a
        // stale timestamp must never be allowed to front-load nearly the
        // whole glide into frame one. A throttled background tab (dt
        // capped low every tick, real-world time between ticks much
        // longer) just converges more slowly under this cap -- termination
        // is unaffected, since wmGlideStepOffset's snap-epsilon check has
        // no dependency on dt.
        var __wmNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var __wmDt = __wmGlide.lastTs ? Math.max(0, Math.min(34, __wmNow - __wmGlide.lastTs)) : 17;
        var __wmAlpha = 1 - Math.exp(-__wmDt / WM_GLIDE_TAU_MS);
        var __wmPresent = {};
        var __wmUnconverged = false;

        wmEntries.forEach(function (e) {
            if (e.ax === undefined || e.ay === undefined) return;  // unmeasurable this draw (screenBBoxOf returned null above) -- nothing to glide
            var keyword = e.el.getAttribute('data-sc');
            if (!keyword) return;
            __wmPresent[keyword] = true;

            var targetM = /translate\(([-\d.eE]+),\s*([-\d.eE]+)\)/.exec(e.el.getAttribute('transform') || '');
            var targetOffset = {
                x: (targetM ? parseFloat(targetM[1]) : e.ax) - e.ax,
                y: (targetM ? parseFloat(targetM[2]) : e.ay) - e.ay,
            };
            __wmGlide.anchors[keyword] = { x: e.ax, y: e.ay };
            __wmGlide.targets[keyword] = targetOffset;

            var step = wmGlideStepOffset(__wmGlide.offsets[keyword], targetOffset, __wmAlpha, currentZoomK);
            __wmGlide.offsets[keyword] = step.offset;
            if (!step.converged) __wmUnconverged = true;
            e.el.setAttribute('transform', 'translate(' + (e.ax + step.offset.x) + ',' + (e.ay + step.offset.y) + ')');
            updateLeaderEnd(e.el);
        });

        // Prune keywords absent from THIS draw (SC removed, or the
        // underlying data changed) -- otherwise a keyword that later
        // reappears would glide from a stale, unrelated offset instead of
        // snapping fresh, same as a genuinely new SC would (delta #29
        // test coverage: "pruned keyword" case).
        for (var __wmStaleKw in __wmGlide.offsets) {
            if (!__wmPresent[__wmStaleKw]) {
                delete __wmGlide.offsets[__wmStaleKw];
                delete __wmGlide.targets[__wmStaleKw];
                delete __wmGlide.anchors[__wmStaleKw];
            }
        }
        __wmGlide.lastTs = __wmNow;
        if (__wmUnconverged) {
            __wmGlide.raf = __wmRafSchedule(wmGlideStep);
        }
    }

    /** Delta #29 rAF continuation: advances every still-animating
     *  nameplate one exponential step closer to its stored target offset,
     *  then either stops (everything converged) or reschedules itself.
     *  Runs entirely BETWEEN zoom ticks -- drawWatermarks() above is the
     *  only thing that ever cancels it (see that function's own top-of-
     *  body comment for why a fresh draw must always win the race).
     *
     *  Re-resolves each keyword's element FRESH every frame by `data-sc`,
     *  rather than holding onto whichever `g.watermark` DOM node was
     *  current when this loop started: drawWatermarks() tears down and
     *  rebuilds every watermark on every call (including calls that land
     *  mid-glide), and a full render() re-render replaces even the parent
     *  `.watermarks` layer itself -- a held element reference would
     *  silently go stale and stop painting anything the moment either one
     *  fires next, with no error to signal it. */
    function wmGlideStep() {
        __wmGlide.raf = 0;
        if (!svg) return;  // mount disposed mid-glide -- nothing left to animate into
        var layer = svg.select('.graph-root').select('.watermarks');
        if (layer.empty()) return;

        var elByKeyword = {};
        layer.selectAll('g.watermark').each(function () {
            var kw = this.getAttribute('data-sc');
            if (kw) elByKeyword[kw] = this;
        });

        // dt clamped near one frame interval, same rationale (and same
        // 34ms/17ms constants) as the application pass' own __wmDt, above
        // in drawWatermarks -- a stale `lastTs` here (e.g. this rAF frame
        // firing well after the previous one, tab backgrounded/throttled)
        // must not front-load most of the remaining glide into one frame.
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var dt = __wmGlide.lastTs ? Math.max(0, Math.min(34, now - __wmGlide.lastTs)) : 17;
        var alpha = 1 - Math.exp(-dt / WM_GLIDE_TAU_MS);
        var stillUnconverged = false;

        for (var keyword in __wmGlide.targets) {
            var anchor = __wmGlide.anchors[keyword];
            var target = __wmGlide.targets[keyword];
            if (!anchor || !target) continue;
            var step = wmGlideStepOffset(__wmGlide.offsets[keyword], target, alpha, currentZoomK);
            __wmGlide.offsets[keyword] = step.offset;
            if (!step.converged) stillUnconverged = true;
            var el = elByKeyword[keyword];
            if (el) {
                el.setAttribute('transform', 'translate(' + (anchor.x + step.offset.x) + ',' + (anchor.y + step.offset.y) + ')');
                updateLeaderEnd(el);
            }
        }

        __wmGlide.lastTs = now;
        if (stillUnconverged) {
            __wmGlide.raf = __wmRafSchedule(wmGlideStep);
        } else {
            // Delta #29: the zoom-tick-driven debounced cull (scheduleLabelCull,
            // called from updateLabelLOD on every zoom event) already re-judges
            // ~90ms after the LAST zoom tick, but a glide can still be running
            // well past that window -- re-trigger it here, on the frame the
            // glide actually finishes, so cull/caption decisions get judged
            // against the FINAL, settled positions instead of a mid-glide
            // snapshot frozen up to a full plate-height early.
            //
            // Delta #29 follow-up (2026-08-10, caught by the explorer-side
            // design-verify `overlaps` check): group captions have the same
            // staleness the re-cull above guards against, but on the
            // PLACEMENT side. positionGroupCaptions dodges caption text off
            // painted watermark rects (collectObstacleRects) and only ever
            // runs inside a zoom pass (updateLabelScale) -- BEFORE that same
            // pass's drawWatermarks call repaints the plates -- so the last
            // caption dodge of a zoom gesture is judged against a mid-glide
            // watermark position, and once the glide finishes converging, a
            // settled plate can sit on top of a caption that will never
            // re-dodge (measured as settled-state group-label x watermark
            // bbox overlaps at z100/z150, the pinch-cliff band). Re-position
            // captions on the convergence frame, BEFORE scheduling the cull:
            // the cull's obstacle pass reads caption rects, so captions must
            // settle first. Watermark rest positions are untouched -- the R6
            // resolver never reads caption rects, so there is no feedback
            // loop and settled-state goldens hold.
            positionGroupCaptions(currentZoomK);
            scheduleLabelCull();
        }
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

    // ── Fit-to-content zoom ──────────────────────────────────────────

    /** Delta #32: the fit bbox (world), factored out of fitToContent so the
     *  post-settle SC separation pass (applyScLayoutSeparation) can derive
     *  the exact fit scale -- and therefore the exact 0.5x floor -- from the
     *  same bbox math the fit itself uses, never a parallel estimate. Body
     *  is byte-identical to what fitToContent inlined before; returns null
     *  where fitToContent used to early-return. */
    function computeFitBBox(nodes) {
        if (!nodes.length) return null;
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
                var lines = wrapLabelLines(kw.slice(0, 36), SC_NAME_LINE_BUDGET).length;
                // Delta #36: plate padding in the same plate-fit scale the
                // draw uses (still the pre-existing world-unit approximation).
                var bottom = cy + BASE_SC_ICON_SIZE * plateFitScale / 2 + SC_LABEL_TOP_PAD * plateFitScale
                    + lines * BASE_SC_NAME_FONT_SIZE * plateFitScale * 1.3 + 8;
                if (bottom > maxY) maxY = bottom;
                var top = cy - BASE_SC_ICON_SIZE * plateFitScale / 2 - 8;
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

        // Flat pad, applied last so it sits BEYOND the fog/watermark terms
        // above. unpadFitBBox (just below) mirrors this exact step in
        // reverse -- keep the two in sync; they're the only two places
        // these pad constants are applied to a bbox.
        minX -= HULL_PADDING + FIT_WORLD_PAD; minY -= HULL_PADDING + FIT_WORLD_PAD + 20;
        maxX += HULL_PADDING + FIT_WORLD_PAD; maxY += HULL_PADDING + FIT_WORLD_PAD;
        if (maxX - minX <= 0 || maxY - minY <= 0) return null;
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /** 2026-09-13 fit-includes-exiles fix: the UNPADDED content bbox --
     *  computeFitBBox's flat-pad step (HULL_PADDING + FIT_WORLD_PAD, +20 more
     *  on top) removed. Used as the exiled-plate ring perimeter
     *  (__scLayout.cloudBBox) so plates sit against the nebula itself rather
     *  than against the fit's own daylight margin, which is what made
     *  exiled plates float far from the cloud with long leaders (user
     *  report, 2026-09-13). Pure arithmetic inverse of computeFitBBox's own
     *  pad step -- factored out so the pad constants stay defined in one
     *  place (computeFitBBox) and applied/un-applied from exactly two call
     *  sites. */
    function unpadFitBBox(bb) {
        if (!bb) return bb;
        return {
            minX: bb.minX + HULL_PADDING + FIT_WORLD_PAD,
            minY: bb.minY + HULL_PADDING + FIT_WORLD_PAD + 20,
            maxX: bb.maxX - (HULL_PADDING + FIT_WORLD_PAD),
            maxY: bb.maxY - (HULL_PADDING + FIT_WORLD_PAD),
        };
    }

    function fitToContent(nodes, canvasW, canvasH, zoomBehavior, setContentBBox) {
        if (!nodes.length || !svg) return;
        plateFitScale = plateFitScaleFor(canvasW, canvasH);  // delta #36: same dims the fit uses
        // 2026-09-13 swoop fix: a fit is never a wheel gesture (settle,
        // resize, or an explicit refit -- the only three call sites below)
        // so the very next watermark draw should always SNAP, never glide.
        // Without this, finishRenderAfterSettle's chunk 2 (drawWatermarks,
        // via applyScLayoutSeparation's own settle-time draw) paints exile
        // placements computed at whatever currentZoomK was left over from
        // BEFORE this cycle's fit (module-init default 1 on a fresh mount,
        // or the prior render's zoom level otherwise) -- wrong relative to
        // the fit this call is about to establish. Chunk 3 (here) then
        // applies the correct transform, whose synchronous 'zoom' event
        // redraws watermarks at the right currentZoomK, but the delta-#29
        // glide (still holding chunk 2's now-stale offset) eases toward it
        // instead of snapping, so exiled plates visibly swoop as the settle
        // veil lifts (and a test reading the DOM immediately after settle,
        // with no timer advance, observes the wrong, pre-swoop position).
        wmGlideReset();
        // 2026-09-13 fit-includes-exiles fix: once a settle/resize has run
        // remeasureScLayout for THIS canvas size (settle path: handleSimEnd
        // -> applyScLayoutSeparation; resize path: the ResizeObserver calls
        // remeasureScLayout before fitToContent -- see both call sites
        // below), __scLayout.fitBBox is the content bbox already expanded to
        // include every plate exiled AT fit (plus SC_FIT_EXILE_MARGIN_PX).
        // Falling back to the plain computeFitBBox covers the pre-first-
        // settle/no-SC-separation case (no __scLayout yet, or fewer than 2
        // painted SCs -- remeasureScLayout no-ops and leaves fitBBox unset).
        var bb = (__scLayout && __scLayout.fitBBox) ? __scLayout.fitBBox : computeFitBBox(nodes);
        if (!bb) return;
        var minX = bb.minX, minY = bb.minY, maxX = bb.maxX, maxY = bb.maxY;
        var bw = maxX - minX, bh = maxY - minY;

        // Store content bounds for pan clamping
        setContentBBox({ x: minX, y: minY, w: bw, h: bh });

        var scale = Math.min(canvasW / bw, canvasH / bh);
        var mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
        var transform = d3.zoomIdentity
            .translate(canvasW / 2 - mx * scale, canvasH / 2 - my * scale)
            .scale(scale);
        // Fix review I1 (2026-09-13): record the transform just established
        // as the new parallax reference point BEFORE calling
        // `zoomBehavior.transform` below, not after -- that call dispatches
        // 'zoom' SYNCHRONOUSLY, so assigning __fitTransform afterward meant
        // the fit tick's own onViewChange fired against the PRIOR (stale)
        // reference point, and every consumer (Starfield.tsx) stayed
        // pinned to the old fit's parallax offset until the NEXT tick
        // (visibly: stars parked at half the correct delta after a resize
        // until the user's next pan/zoom). Also carries `cx`/`cy` (fix
        // review C1) -- the canvas center this fit is centered on, needed
        // by Starfield.tsx's corrected parallax formula so a pure zoom
        // about that same center (the zoom-indicator's scaleBy/scaleTo,
        // __d3ZoomTo, or a real ctrl+wheel notch, none of which move the
        // "camera" in world space) reports zero pan instead of the
        // apparent screen-space `x` shift zooming about a fixed point
        // otherwise produces.
        __fitTransform = { x: transform.x, y: transform.y, k: scale, cx: canvasW / 2, cy: canvasH / 2 };
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
    //
    // Task group W fix round 2 (task-V2-brief.md, vision-review F5):
    // Dash's own toggleGroupExpansion (frontend/dash/assets/d3_graph.js,
    // read-only) calls render() SYNCHRONOUSLY, so by the time it calls
    // frameWorldBBox below, render()'s own preserveView restore has
    // already happened and the frame is the last word -- it sticks.
    // Task group W's async worker relayout broke that ordering: this
    // render() call only KICKS OFF the worker and returns immediately, so
    // a frameWorldBBox call made HERE (a) reads a STALE, pre-relayout
    // groupWorldBBox (the worker hasn't computed the expanded layout yet)
    // and (b) starts a transition that the settle-end preserveView
    // restore (finishRenderAfterSettle, once the worker actually
    // finishes) unconditionally overwrites moments-to-seconds later --
    // confirmed live via instrumentation (task-V2-report.md): the
    // transition genuinely reached the correct 260%-zoom frame, then was
    // snapped back to the pre-click transform ~2.1s later when settle-end
    // ran. Fix: don't frame here at all -- hand the group id to render()
    // as `frameGroupId`, which finishRenderAfterSettle carries on the
    // run's ctx and applies AFTER its own preserveView restore, once
    // positions are final. Same net ordering as Dash (pin the camera,
    // THEN frame over it), just triggered by the worker's `end` message
    // instead of render() returning.
    function toggleGroupExpansion(groupId, expanding) {
        expandedGroups[groupId] = expanding;
        if (!rawData) return;
        // rawData, not currentData: render() re-assigns rawData from its argument, and currentData may be noise-filtered — passing it would corrupt the toggle's source of truth.
        render(rawData, { preserveView: true, frameGroupId: expanding ? groupId : null });
    }

    function refitView() {
        if (!currentData || !storedZoomBehavior || !lastCanvasDims) return;
        fitToContent(currentData.nodes || [], lastCanvasDims.w, lastCanvasDims.h,
            storedZoomBehavior, function () {});
    }

    // ── Task group W: Web Worker sim glue (header comment delta #19) ───
    // render()'s prior "Phase 1: Compute layout synchronously" section
    // (a single blocking `computeLayout(...)` call) is now this handful
    // of small functions: build the worker's `start` payload, hand it to
    // the persistent `__simClient`, and paint whatever `__simRunCtx`
    // (this run's render()-local state) says to paint as `tick`/`end`
    // messages arrive. See lib/graph/sim-layout.ts / sim.worker.ts /
    // useWorkerSim.ts for the worker side of this contract.

    // Feature-detected requestAnimationFrame -- jsdom (lib/graph/
    // d3-graph-vendor.remount.test.ts's environment, which runs this
    // file unmocked) implements no `requestAnimationFrame` at all.
    // Falls back to the same `setTimeout(cb, 16)` d3-timer itself uses
    // when a real one isn't available (sim.worker.ts's own header
    // comment notes the identical fallback on the worker side).
    var __rafSchedule = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
        ? function (cb) { return window.requestAnimationFrame(cb); }
        : function (cb) { return setTimeout(cb, 16); };
    var __rafCancel = (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
        ? function (id) { window.cancelAnimationFrame(id); }
        : function (id) { clearTimeout(id); };

    /** Assembles a lib/graph/sim-protocol.ts SimStartPayload from this
     *  render()'s `nodes`/`clusters`/`links`/`width`/`height` plus the
     *  CURRENT (possibly tuner-overridden) module vars/caches the worker
     *  needs but can't read itself (sim-protocol.ts's SimStartPayload
     *  field comments explain each one). `nodes`/`clusters`/`links` are
     *  trimmed to exactly the fields sim-layout.ts's pipeline reads --
     *  the richer GraphNode/GraphCluster/GraphLink objects stay
     *  main-thread-only. */
    function buildSimStartPayload(nodes, clusters, links, width, height) {
        return {
            nodes: nodes.map(function (n) { return { id: n.id, parent_id: n.parent_id }; }),
            links: links.map(function (l) { return { source: l.source, target: l.target, weight: l.weight }; }),
            clusters: clusters.map(function (c) {
                return {
                    id: c.id,
                    name: c.name,
                    page_ids: c.page_ids,
                    super_cluster: c.super_cluster,
                    group_id: c.group_id,
                    group_tier: c.group_tier,
                };
            }),
            params: {
                // Phase 1 forceManyBody strength / forceLink base distance
                // (sim-layout.ts's own header comment) -- never
                // tuner-exposed in this file either, so these two are
                // fixed literals here, matching the vendor's original
                // computeLayout inline constants exactly.
                charge: -80,
                linkDistance: 30,
                collideRadius: (NODE_RADIUS + 2) * PAGE_SPREAD_MULT,
                alphaMin: 0.001,
            },
            width: width,
            height: height,
            nodeRadius: NODE_RADIUS,
            pageSpreadMult: PAGE_SPREAD_MULT,
            nebulaRadiusMult: NEBULA_RADIUS_MULT,
            nebulaMinRadius: NEBULA_MIN_RADIUS,
            scLabelTopPad: SC_LABEL_TOP_PAD,
            scNameLineBudget: SC_NAME_LINE_BUDGET,
            scNameCharWidth: SC_NAME_CHAR_WIDTH,
            // Delta #32: footprint-aware Phase 1.5b seeding.
            scSeparation: {
                footprint: scFootprintParams(),
                minZoomRatio: MIN_ZOOM_RATIO,
                fitWorldPad: FIT_WORLD_PAD,
                hullPadding: HULL_PADDING,
                interGapPx: 8,
            },
            // The whole cache, not just this run's cluster names -- names
            // from a PRIOR dataset are simply never looked up by this
            // run's clusters, harmless to include (labelDimsCache is
            // never pruned, same lifetime as the module itself).
            labelDims: labelDimsCache,
            expandedGroups: expandedGroups,
        };
    }

    function writePositionsIntoNodes(nodes, positions) {
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].x = positions[i * 2];
            nodes[i].y = positions[i * 2 + 1];
        }
    }

    /** The old inline "star decorations" + "Nodes" block (byte-identical
     *  body), now called once -- on the FIRST tick -- instead of once
     *  per render() call after a blocking layout. */
    function paintPageDots(root, nodes) {
        root.select('.nodes').selectAll('use.star-spikes')
            .data(nodes, function (d) { return d.id; })
            .enter().append('use')
            .attr('class', 'star-spikes')
            .attr('href', function (d) { return '#star-v' + starVariant(d.id); })
            .attr('fill', 'currentColor')
            .attr('opacity', starGlyphOpacity)
            .attr('pointer-events', 'none');

        root.select('.nodes').selectAll('circle.page')
            .data(nodes, function (d) { return d.id; })
            .enter().append('circle')
            .attr('class', function (d) {
                return d.kind === 'singleton'
                    ? 'page singleton'
                    : (d.kind === 'unclustered' ? 'page unclustered' : 'page');
            })
            .attr('r', function (d) { return pageDotRadius(d, currentZoomK); })
            .attr('fill', 'currentColor')
            .attr('fill-opacity', 0)
            .attr('stroke', 'none')
            .attr('opacity', 1.0)
            .attr('pointer-events', 'none')
            .attr('cx', function (d) { return d.x; })
            .attr('cy', function (d) { return d.y; });
    }

    /** Re-applies CURRENT `__simRunCtx.nodes` positions to the already-
     *  painted dots (updatePageDotScale, header comment delta #18) and
     *  rebuilds the hover/click hit-test structure against them -- so
     *  hover/click keep tracking the live, still-settling positions
     *  during settle, not a stale first-tick snapshot. */
    function flushSimPaintNow() {
        var ctx = __simRunCtx;
        if (!ctx) return;
        updatePageDotScale(currentZoomK);
        rebuildDelaunay(ctx.nodes);
    }

    function scheduleSimPaint() {
        if (__simRafHandle != null) return;
        __simRafHandle = __rafSchedule(function () {
            __simRafHandle = null;
            flushSimPaintNow();
        });
    }

    function handleSimTick(positions) {
        var ctx = __simRunCtx;
        if (!ctx) return;
        writePositionsIntoNodes(ctx.nodes, positions);
        if (!ctx.paintedOnce) {
            // First paint = the phyllotaxis seed (sim.worker.ts always
            // posts this as the very first message) -- painted
            // synchronously, not rAF-deferred, matching the A2 spike's
            // own first-commit-is-synchronous precedent (task-W-brief.md
            // references it as the UX to match).
            ctx.paintedOnce = true;
            paintPageDots(ctx.root, ctx.nodes);
            rebuildDelaunay(ctx.nodes);
            if (ctx.opts && typeof ctx.opts.onFirstPaint === 'function') ctx.opts.onFirstPaint();
        } else {
            // Every later tick: rAF-batched so a burst of same-frame tick
            // messages coalesces into one paint (task-W-brief.md W2).
            scheduleSimPaint();
        }
    }

    /** Delta #32: the paint-path constants the footprint estimator needs,
     *  read LIVE (tuner overrides included) at call time. charAdvanceEm
     *  normalizes SC_NAME_CHAR_WIDTH, which computeWatermarkBBox expresses
     *  at its own hardcoded 30px font, to an em advance. */
    function scFootprintParams() {
        return {
            // Delta #36: pre-scaled by plateFitScale so plateFootprintAtRatio
            // (sc-separation.ts) needs no new input -- ratio 1.0 there IS
            // "the plate as painted at fit on this canvas".
            baseIconSize: BASE_SC_ICON_SIZE * plateFitScale,
            baseNameFontPx: BASE_SC_NAME_FONT_SIZE * plateFitScale,
            labelTopPad: SC_LABEL_TOP_PAD * plateFitScale,
            lineBudget: SC_NAME_LINE_BUDGET,
            charAdvanceEm: SC_NAME_CHAR_WIDTH / 30,
            scIcon: SCALE_THRESHOLDS.scIcon,
            scName: SCALE_THRESHOLDS.scName,
            pad: 2,  // WM_PAD in drawWatermarks
        };
    }

    /** Delta #32 post-settle correction pass. Runs once per layout, after
     *  the worker's final positions are written into `nodes` and BEFORE
     *  finishRenderAfterSettle paints or fits anything. Rigidly translates
     *  whole SC member-sets until every painted nameplate's estimated
     *  footprint at the 0.5x zoom floor is disjoint from every other,
     *  bounded per SC by SC_SEPARATION_BUDGET_RATIO x fog reach. Pairs that
     *  cannot be resolved within budget are NOT forced: the smaller plate
     *  is recorded as overflow with its computed exile onset k, and
     *  drawWatermarks exiles it to the periphery below that k. Deterministic
     *  given the settle output. Up to 3 outer iterations because moving
     *  SCs changes the fit bbox and therefore the floor k the footprints
     *  are measured against; re-fitting between iterations is what makes
     *  "spread them apart" a redistribution rather than a self-cancelling
     *  uniform expansion (spec, "fit-renormalization trap"). Final fix
     *  wave: the tail (final measure, zero-budget overflow sweep, kExile,
     *  cloud centroid, __scLayout write) now lives in remeasureScLayout, so
     *  a later resize can re-derive the SAME record for a new canvas size
     *  without repeating the movement phase -- see that function's comment. */
    function applyScLayoutSeparation(ctx) {
        __scLayout = null;
        __scShiftW = {};  // final fix wave: cumulative per-SC shift, cleared per settle
        wmGlideReset();   // final fix wave (Minor 3): a new layout invalidates every stored glide offset -- the first post-fit draw must snap, not glide from the previous layout's plate positions
        var nodes = ctx.nodes, clusters = ctx.clusters;
        if (!nodes.length || !__mountedIcons || !currentData) return;
        var canvasW = ctx.width, canvasH = effectiveCanvasHeight(ctx.height);
        if (!(canvasW > 0) || !(canvasH > 0)) return;
        plateFitScale = plateFitScaleFor(canvasW, canvasH);  // delta #36: before scFootprintParams()/computeFitBBox read it
        var fp = scFootprintParams();

        var groups = {};
        clusters.forEach(function (c) {
            if (!c.super_cluster) return;
            if (!groups[c.super_cluster]) groups[c.super_cluster] = [];
            groups[c.super_cluster].push(c);
        });
        // Only SCs drawWatermarks will actually paint take part.
        var scKeys = Object.keys(groups).filter(function (kw) {
            return !!paintedScEntry(kw);
        }).sort();
        if (scKeys.length < 2) return;

        var nodeIdxByKw = {}, pagesByKw = {};
        scKeys.forEach(function (kw) {
            var ids = {}, pages = 0;
            groups[kw].forEach(function (c) { (c.page_ids || []).forEach(function (pid) { ids[pid] = true; }); pages += (c.page_ids || []).length; });
            var idx = [];
            for (var i = 0; i < nodes.length; i++) if (ids[nodes[i].id] && nodes[i].x != null) idx.push(i);
            nodeIdxByKw[kw] = idx; pagesByKw[kw] = pages;
        });

        // usedW is WORLD units (fix round 1: kFloor changes every outer
        // iteration as the correction re-fits, so a running total kept in
        // SCREEN px would silently mix px measured at different scales --
        // world units are the one thing that stays comparable across
        // iterations; re-expressed in the CURRENT iteration's screen px
        // only where a px comparison against budgetPx is actually needed).
        var usedW = {}, budgetPx = {}, overflow = {};
        scKeys.forEach(function (kw) { usedW[kw] = 0; budgetPx[kw] = 0; });
        var kFit = 0, kFloor = 0, bbox = null, anchors = {};

        function measure() {
            bbox = computeFitBBox(nodes);
            if (!bbox) return false;
            kFit = Math.min(canvasW / (bbox.maxX - bbox.minX), canvasH / (bbox.maxY - bbox.minY));
            kFloor = kFit * MIN_ZOOM_RATIO;
            var centroids = computeClusterCentroids(clusters, nodes);
            scKeys.forEach(function (kw) {
                var geo = scOverlayGeometry(groups[kw], centroids, nodes);
                if (!geo) { anchors[kw] = null; return; }
                anchors[kw] = { x: geo.cx, y: geo.cy };
                // Final fix wave (Important #2): floor at SC_SEPARATION_
                // BUDGET_MIN_PX -- see that var's own comment.
                budgetPx[kw] = Math.max(geo.maxReach * kFloor * SC_SEPARATION_BUDGET_RATIO, SC_SEPARATION_BUDGET_MIN_PX);
            });
            return kFit > 0;
        }

        for (var outer = 0; outer < 3; outer++) {
            if (!measure()) return;
            var plates = [];
            scKeys.forEach(function (kw) {
                if (overflow[kw] || !anchors[kw]) return;
                plates.push({
                    key: kw, pages: pagesByKw[kw],
                    x: anchors[kw].x * kFloor, y: anchors[kw].y * kFloor,
                    fp: plateFootprintAtRatio(kw, MIN_ZOOM_RATIO, fp),
                    // usedW (world) re-expressed at THIS iteration's kFloor so
                    // it compares against budgetPx[kw], which is also this
                    // iteration's screen px.
                    budget: Math.max(0, budgetPx[kw] - usedW[kw] * kFloor),
                });
            });
            var res = solveSeparation(plates);
            res.overflow.forEach(function (kw) { overflow[kw] = true; });
            var anyMove = false;
            Object.keys(res.shifts).forEach(function (kw) {
                var s = res.shifts[kw];
                var len = Math.sqrt(s.dx * s.dx + s.dy * s.dy);
                if (len < 1e-6) return;
                anyMove = true;
                // Accumulate in world units (divide THIS iteration's screen-px
                // shift by THIS iteration's kFloor) -- keeps usedW comparable
                // across iterations even though kFloor itself moves each time.
                usedW[kw] += len / kFloor;
                var dxW = s.dx / kFloor, dyW = s.dy / kFloor;
                nodeIdxByKw[kw].forEach(function (i) { nodes[i].x += dxW; nodes[i].y += dyW; });
            });
            if (!anyMove) break;
        }

        // Final fix wave: hand off the per-SC cumulative shift the
        // movement phase above just produced, then run the shared
        // measure+report tail through remeasureScLayout (also the
        // resize-time entry point) so there is exactly one place that
        // turns "current node positions + canvas size" into a __scLayout
        // record. __scLayout is set to a non-null placeholder first so
        // remeasureScLayout's own "no layout yet" guard (meant to keep a
        // resize from doing work before any settle ever ran) doesn't block
        // THIS settle from establishing the record in the first place.
        scKeys.forEach(function (kw) { __scShiftW[kw] = usedW[kw]; });
        __scLayout = {};
        remeasureScLayout(canvasW, canvasH);
    }

    /** Final fix wave (Important #1): __scLayout used to be fixed at the
     *  canvas size in effect at settle -- a resize left the floor
     *  guarantee and every plate's exile onset stale, since the
     *  ResizeObserver handler only re-fits, never re-measures. This is the
     *  node-immutable "recompute the report for THIS canvas size" tail,
     *  shared by applyScLayoutSeparation's own settle-time call (above) and
     *  the ResizeObserver handler's later resize-time call. Recomputes
     *  groups/painted keys/anchors/node index sets fresh from currentData
     *  (never from applyScLayoutSeparation's closure -- the two call sites
     *  don't share one) and never moves a node: the movement phase only
     *  ever runs inside applyScLayoutSeparation's own outer loop, at
     *  settle. Per-SC shift is read from __scShiftW (world units, written
     *  by that movement phase) so shiftPx = __scShiftW[kw] * kFloor is
     *  correct at WHATEVER floor is current, settle or a later resize
     *  alike; overflow here comes from the zero-budget check alone (mirrors
     *  applyScLayoutSeparation's own former post-loop "guarantee by
     *  construction" sweep, just run standalone against every painted SC
     *  rather than only the ones the movement phase hadn't already flagged).
     *  Guard: no-op when __scLayout is null (no layout yet -- nothing for a
     *  resize to refresh) or fewer than 2 painted SCs.
     *
     *  2026-09-13 fit-includes-exiles fix: also derives __scLayout.fitBBox
     *  -- the content bbox expanded (bounded fixed-point search, see the
     *  loop's own comment) to include every plate exiled AT fit -- which
     *  fitToContent now fits to instead of the plain content bbox, so 100%
     *  zoom (and the 0.5x floor beneath it) always contains every exiled
     *  nameplate. cloudBBox (the ring perimeter exiled plates are placed
     *  against) is now the UNPADDED content bbox, not the fit bbox -- see
     *  unpadFitBBox.
     *
     *  Review round (2026-09-13): the record written to __scLayout (kFit,
     *  kFloor, overflow, kExileOf, budgetPx) must ALWAYS be measured from
     *  the SAME bbox that ends up stored as fitBBox -- measureAtBBox below
     *  is the one place a candidate bbox turns into that record, called
     *  immediately after fitBBox changes (never deferred to "the next loop
     *  pass"), so every exit path (converged, cap hit, or the no-exile
     *  reset) leaves fitZoom/kExile/the floor sweep judging the SAME scale
     *  that is actually stored and later applied by fitToContent. */
    function remeasureScLayout(canvasW, canvasH) {
        if (!__scLayout || !currentData || !__mountedIcons) return;
        if (!(canvasW > 0) || !(canvasH > 0)) return;
        var nodes = currentData.nodes || [];
        var clusters = currentData.clusters || [];
        if (!nodes.length) return;
        plateFitScale = plateFitScaleFor(canvasW, canvasH);  // delta #36: before scFootprintParams()/computeFitBBox read it
        var fp = scFootprintParams();

        var groups = {};
        clusters.forEach(function (c) {
            if (!c.super_cluster) return;
            if (!groups[c.super_cluster]) groups[c.super_cluster] = [];
            groups[c.super_cluster].push(c);
        });
        var scKeys = Object.keys(groups).filter(function (kw) {
            return !!paintedScEntry(kw);
        }).sort();
        if (scKeys.length < 2) return;

        var nodeIdxByKw = {}, pagesByKw = {};
        scKeys.forEach(function (kw) {
            var ids = {}, pages = 0;
            groups[kw].forEach(function (c) { (c.page_ids || []).forEach(function (pid) { ids[pid] = true; }); pages += (c.page_ids || []).length; });
            var idx = [];
            for (var i = 0; i < nodes.length; i++) if (ids[nodes[i].id] && nodes[i].x != null) idx.push(i);
            nodeIdxByKw[kw] = idx; pagesByKw[kw] = pages;
        });

        var contentBBox = computeFitBBox(nodes);
        if (!contentBBox) return;
        // Ring perimeter for exiled plates is the UNPADDED content bbox
        // (2026-09-13 user direction: plates hug the nebula instead of
        // floating out past the fit's own daylight margin) -- invariant
        // across the fit-search loop below, since it depends only on node
        // positions, never on canvasW/canvasH or the candidate fit bbox.
        var cloudBBox = unpadFitBBox(contentBBox);

        // Review Minor 2: anchors (scOverlayGeometry) and the cloud
        // centroid are pure functions of node positions -- independent of
        // kFit/kFloor -- so both are computed ONCE here, not on every
        // fixed-point pass below. Only budgetPx (uses kFloor) and the
        // overflow/kExile sweep (use kFit/kFloor) are k-dependent and stay
        // inside measureAtBBox.
        var centroids = computeClusterCentroids(clusters, nodes);
        var anchors = {}, reachOf = {};
        scKeys.forEach(function (kw) {
            var geo = scOverlayGeometry(groups[kw], centroids, nodes);
            if (!geo) { anchors[kw] = null; return; }
            anchors[kw] = { x: geo.cx, y: geo.cy };
            reachOf[kw] = geo.maxReach;
        });
        var cloudCx = 0, cloudCy = 0, cloudN = 0;
        scKeys.forEach(function (kw) {
            nodeIdxByKw[kw].forEach(function (i) { cloudCx += nodes[i].x; cloudCy += nodes[i].y; cloudN++; });
        });
        cloudCx = cloudN ? cloudCx / cloudN : (contentBBox.minX + contentBBox.maxX) / 2;
        cloudCy = cloudN ? cloudCy / cloudN : (contentBBox.minY + contentBBox.maxY) / 2;

        // 2026-09-13 fit-includes-exiles fix: 100% zoom must equal
        // zoom-to-fit INCLUDING every plate exiled AT fit (plus
        // SC_FIT_EXILE_MARGIN_PX) -- otherwise fit (and the 0.5x floor
        // beneath it) crops peripheral plates (user report, screenshot).
        // Growing the fit bbox to include an exiled plate SHRINKS kFit
        // (and kFloor with it), which shrinks screen-space separation
        // between anchors and can push another plate into overflow/exile
        // that wasn't before -- so this is a bounded fixed-point search,
        // not a single pass.
        var kFit = 0, kFloor = 0, budgetPx = {}, overflow = {}, kExileOf = {};

        /** Turns a candidate bbox into the k-dependent half of the record
         *  (kFit/kFloor/budgetPx/overflow/kExileOf, all outer vars mutated
         *  as a side effect) and returns the keys exiled AT that bbox's own
         *  fit scale. Called immediately whenever fitBBox changes -- never
         *  on a later pass -- so the outer vars are never left describing a
         *  bbox other than whatever fitBBox currently holds. */
        function measureAtBBox(bb) {
            kFit = Math.min(canvasW / (bb.maxX - bb.minX), canvasH / (bb.maxY - bb.minY));
            if (!(kFit > 0)) return [];
            kFloor = kFit * MIN_ZOOM_RATIO;

            budgetPx = {};
            scKeys.forEach(function (kw) {
                if (!anchors[kw]) return;
                budgetPx[kw] = Math.max(reachOf[kw] * kFloor * SC_SEPARATION_BUDGET_RATIO, SC_SEPARATION_BUDGET_MIN_PX);
            });

            // Guarantee by construction: whatever is still overlapping at
            // zero budget becomes overflow, so every plate drawn at its
            // anchor is disjoint at the floor -- the resolver+glide safety
            // net should never have to move an anchored plate. This is the
            // ONLY source of overflow at a remeasure -- the movement phase
            // (when there was one) already ran.
            overflow = {};
            var checkPlates = [];
            scKeys.forEach(function (kw) {
                if (!anchors[kw]) return;
                checkPlates.push({ key: kw, pages: pagesByKw[kw], x: anchors[kw].x * kFloor, y: anchors[kw].y * kFloor, fp: plateFootprintAtRatio(kw, MIN_ZOOM_RATIO, fp), budget: 0 });
            });
            solveSeparation(checkPlates).overflow.forEach(function (kw) { overflow[kw] = true; });

            kExileOf = {};
            scKeys.forEach(function (kw) {
                if (overflow[kw] && anchors[kw]) {
                    // Task 7: opponents = every other painted plate at its
                    // anchor. Restricting to anchored plates let a plate
                    // whose only collision was with ANOTHER overflow plate
                    // compute a floor-level kExile (already "clear"), so it
                    // never exiled and the R6 safety net slid it ~800px on
                    // real data.
                    var opponents = scKeys.filter(function (k) { return k !== kw && anchors[k]; });
                    var r = computeExileRatio(kw, anchors, opponents, fp, kFit, MIN_ZOOM_RATIO, 4);
                    kExileOf[kw] = isFinite(r) ? kFit * r : Infinity;
                } else {
                    kExileOf[kw] = 0;
                }
            });

            // "Exiled at fit" = would still be exiled if the user's current
            // zoom were exactly THIS candidate's fit scale (currentZoomK ==
            // kFit) -- i.e. kFit hasn't yet reached this plate's own exile
            // onset at that same candidate scale.
            return scKeys.filter(function (kw) { return overflow[kw] && anchors[kw] && kFit < kExileOf[kw]; });
        }

        // Review Minor 1: cap raised from a flat 4 to scKeys.length + 4 --
        // the exiled-at-fit set can only grow by at most one plate per pass
        // (each pass either folds the newly-discovered exiles into the
        // bbox or proves none remain), so scKeys.length passes exhausts
        // every plate; +4 slack covers the no-exile reset pass below and
        // general settling. Per the task brief this cap is reported
        // against, not raised further, if a fixture still hasn't converged.
        var maxIterations = scKeys.length + 4;
        var fitBBox = contentBBox;
        var exiledAtFit = measureAtBBox(fitBBox);
        // Review guard: measureAtBBox returns [] (not a signal) when
        // kFit <= 0, so without this check a degenerate canvas/bbox would
        // fall straight into the "no exile" branch below and overwrite
        // __scLayout with a zeroed-out record. Bail out here instead,
        // matching the pre-fix behavior of leaving any previously-valid
        // __scLayout untouched.
        if (!(kFit > 0)) return;
        for (var it = 0; it < maxIterations; it++) {
            var isLast = (it === maxIterations - 1);

            if (!exiledAtFit.length) {
                if (fitBBox === contentBBox) break; // record already matches fitBBox
                // fitBBox was expanded on an earlier pass but nothing is
                // exiled at fit against it -- drop back to contentBBox and
                // re-measure IMMEDIATELY (not on a later pass, which the cap
                // could cut off before it runs) so the stored record can
                // never describe a bbox other than the one about to be
                // stored.
                fitBBox = contentBBox;
                exiledAtFit = measureAtBBox(fitBBox);
                continue;
            }

            // Predict drawWatermarks' own exile pre-pass EXACTLY (same
            // placeExiledPlates call, same env shape) at k = kFit, ratio =
            // 1.0 (fit) -- so the bbox this loop derives is provably what
            // fit will actually need, not a parallel estimate.
            var items = exiledAtFit.map(function (kw) { return { key: kw, ax: anchors[kw].x, ay: anchors[kw].y, fp: plateFootprintAtRatio(kw, 1.0, fp) }; });
            var placed = placeExiledPlates(items, { cx: cloudCx, cy: cloudCy, bbox: cloudBBox, k: kFit, marginPx: SC_EXILE_MARGIN_PX });
            var next = { minX: contentBBox.minX, minY: contentBBox.minY, maxX: contentBBox.maxX, maxY: contentBBox.maxY };
            items.forEach(function (itm) {
                var p = placed[itm.key];
                var hw = (itm.fp.right - itm.fp.left) / 2 / kFit + SC_FIT_EXILE_MARGIN_PX / kFit;
                var hh = (itm.fp.bottom - itm.fp.top) / 2 / kFit + SC_FIT_EXILE_MARGIN_PX / kFit;
                if (p.x - hw < next.minX) next.minX = p.x - hw;
                if (p.x + hw > next.maxX) next.maxX = p.x + hw;
                if (p.y - hh < next.minY) next.minY = p.y - hh;
                if (p.y + hh > next.maxY) next.maxY = p.y + hh;
            });

            // Task 9 (2026-09-13): keep the nebula centered at 100%. The union
            // alone centers the union, shifting the cloud away from a one-sided
            // exile; expand symmetrically about the CONTENT bbox center instead
            // (equal empty margin on the lighter side; kFit slightly lower).
            var ccx = (contentBBox.minX + contentBBox.maxX) / 2, ccy = (contentBBox.minY + contentBBox.maxY) / 2;
            var hwN = Math.max(ccx - next.minX, next.maxX - ccx), hhN = Math.max(ccy - next.minY, next.maxY - ccy);
            next = { minX: ccx - hwN, minY: ccy - hhN, maxX: ccx + hwN, maxY: ccy + hhN };

            // Review Minor 1: relative-k convergence (was an absolute
            // 0.5-world-unit bbox tolerance) -- converged once the NEXT
            // candidate's own fit scale would move kFit by less than 0.1%.
            var kNext = Math.min(canvasW / (next.maxX - next.minX), canvasH / (next.maxY - next.minY));
            var converged = kFit > 0 && Math.abs(kNext - kFit) / kFit < 1e-3;
            if (converged || isLast) break; // record (measured from fitBBox) already matches the stored fitBBox -- do NOT replace it with next

            fitBBox = next;
            exiledAtFit = measureAtBBox(fitBBox);
        }

        var plateInfo = {}, report = [];
        scKeys.forEach(function (kw) {
            // shiftPx re-expresses the correction pass's own world-unit
            // record (__scShiftW, unaffected by resize) at WHATEVER kFloor
            // is current, so shiftPx <= budgetPx stays an apples-to-apples
            // invariant at every canvas size, not just the settle-time one.
            var shiftPx = (__scShiftW[kw] || 0) * kFloor;
            var kExile = kExileOf[kw] || 0;
            plateInfo[kw] = { anchor: anchors[kw], shiftPx: shiftPx, budgetPx: budgetPx[kw], overflow: !!overflow[kw], kExile: kExile };
            report.push({ keyword: kw, pages: pagesByKw[kw], shiftPx: shiftPx, budgetPx: budgetPx[kw], overflow: !!overflow[kw], kExile: kExile });
        });
        __scLayout = {
            kFit: kFit, kFloor: kFloor,
            plateFitScale: plateFitScale,
            cloudCentroid: { x: cloudCx, y: cloudCy },
            cloudBBox: cloudBBox,
            contentBBox: contentBBox,
            fitBBox: fitBBox,
            plates: plateInfo,
            fpParams: fp,
            report: report,
        };
    }

    function handleSimEnd(positions) {
        var ctx = __simRunCtx;
        if (!ctx) return;
        if (__simRafHandle != null) {
            __rafCancel(__simRafHandle);
            __simRafHandle = null;
        }
        writePositionsIntoNodes(ctx.nodes, positions);
        applyScLayoutSeparation(ctx);  // delta #32: must run before ANY paint/fit of these positions
        if (!ctx.paintedOnce) {
            // Defensive fallback only -- sim.worker.ts's handleStart
            // always posts a seed `tick` before any `end` (even a
            // same-frame settle-immediately run), so handleSimTick above
            // has always already run by the time this branch could be
            // reached. Guards a future protocol change, not a real path.
            ctx.paintedOnce = true;
            paintPageDots(ctx.root, ctx.nodes);
            if (ctx.opts && typeof ctx.opts.onFirstPaint === 'function') ctx.opts.onFirstPaint();
        } else {
            // Paint the FINAL positions immediately (not rAF-deferred) --
            // finishRenderAfterSettle below reads these same positions to
            // build hulls/nebula/labels, so the dots must already be
            // final before it runs, not on a future animation frame.
            flushSimPaintNow();
        }
        finishRenderAfterSettle(ctx);
    }

    /** Schedules `fn` to run on the next animation frame, as the next
     *  settle-tail chunk for `ctx`'s run -- rAF (not a bare microtask) so
     *  a user input arriving between chunks gets its own turn instead of
     *  being starved by back-to-back synchronous work (task-W-brief.md
     *  fix round 1). Skipped entirely if `ctx` is no longer the live run
     *  by the time the frame fires (disposed, or superseded by a newer
     *  render() call) -- same identity-check idiom handleSimTick/
     *  handleSimEnd already use via their own `__simRunCtx` reads. */
    function scheduleSettleChunk(ctx, fn) {
        __simPendingChunkFn = fn;
        __simPendingChunkCtx = ctx;
        __simRafHandle = __rafSchedule(function () {
            __simRafHandle = null;
            var pendingFn = __simPendingChunkFn;
            var pendingCtx = __simPendingChunkCtx;
            __simPendingChunkFn = null;
            __simPendingChunkCtx = null;
            if (__simRunCtx !== pendingCtx) return;
            pendingFn();
        });
    }

    /** Dev/test-only: synchronously drains every still-pending settle
     *  chunk (there may be more than one -- each chunk that isn't the
     *  last schedules the next before returning) instead of waiting for
     *  their rAF/setTimeout callbacks to fire. Deterministic "fast
     *  forward finishRenderAfterSettle's now-multi-frame tail to
     *  completion" for tests (window.__d3FlushSettleChunk below) -- a
     *  no-op (returns false) if nothing is pending, e.g. a per-tick
     *  scheduleSimPaint() call is the one currently occupying
     *  __simRafHandle instead. That guard isn't airtight, though: a NEW
     *  render() call's own reset (:4351-4354) only cancels
     *  __simRafHandle, not __simPendingChunkFn/__simPendingChunkCtx -- if
     *  a settle chunk was still pending when that new run supersedes it,
     *  and the new run's first tick's scheduleSimPaint() then claims the
     *  now-free __simRafHandle, this function's `while` condition above
     *  can see that PAINT handle alongside the STALE settle-chunk
     *  bookkeeping and cancel it once, believing it's a settle chunk. The
     *  `__simRunCtx !== ctx` check inside the loop still catches the
     *  stale ctx and breaks before invoking the wrong function, so
     *  nothing incorrect ever runs -- only that one paint frame is
     *  dropped, and the very next handleSimTick's own scheduleSimPaint()
     *  call reschedules it normally (self-healing within one tick). Only
     *  reachable via window.__d3FlushSettleChunk (dev/test-only), and
     *  only in that narrow supersede-mid-settle-chunk window. */
    function flushPendingSettleChunk() {
        var flushedAny = false;
        while (__simRafHandle != null && __simPendingChunkFn) {
            __rafCancel(__simRafHandle);
            __simRafHandle = null;
            var fn = __simPendingChunkFn;
            var ctx = __simPendingChunkCtx;
            __simPendingChunkFn = null;
            __simPendingChunkCtx = null;
            flushedAny = true;
            if (__simRunCtx !== ctx) break;
            fn();
        }
        return flushedAny;
    }

    /** The old post-computeLayout tail of render() (byte-identical body,
     *  `nodes`/`clusters`/`validLinks`/`root`/`width`/`height`/
     *  `prevTransform` read off `ctx` instead of render()'s own closure)
     *  -- everything that needs FINAL, settled positions: cluster colors
     *  (position-based fallback), hulls, labels, nebula, watermarks,
     *  cluster links, fit-to-content, and the hover/click hit-test
     *  rebuild's last (now genuinely final) pass.
     *
     *  Task group W fix round 1 (chunking): this used to be ONE
     *  synchronous block -- for the real dataset (356 clusters, 802
     *  nodes) measured at ~120-160ms total (instrumented breakdown in
     *  task-W-report.md), itself exceeding the spec's 100ms-long-task
     *  bar even though the FORCE SIMULATION it follows costs ~0ms
     *  main-thread time. Split into 3 chunks at natural draw boundaries,
     *  chained via scheduleSettleChunk (rAF, so a user input between
     *  chunks gets a turn): colors+hulls+labels (~30ms measured),
     *  nebula+watermarks+links (~42ms), fit+Delaunay (~52ms, the single
     *  largest atom -- still comfortably under the ~60ms ceiling on its
     *  own). DRAW ORDER is preserved EXACTLY (same calls, same
     *  arguments, same relative sequence -- only rAF yield points were
     *  inserted between groups) and the END STATE is therefore identical
     *  to the pre-chunking single-block version; z-order is unaffected
     *  either way since it's fixed by each group's (`, `.hulls`,
     *  `.nebula`, `.watermarks`, ...) position in the SVG, set up once at
     *  mount, not by JS call order. */
    function finishRenderAfterSettle(ctx) {
        var nodes = ctx.nodes, clusters = ctx.clusters, validLinks = ctx.validLinks;
        var root = ctx.root, width = ctx.width, height = ctx.height;

        // ── Chunk 1: colors + hulls + labels ──
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

        drawHulls(root, nodes, clusters);
        drawGroupLabels(root, clusters, nodes);

        // Page titles for ALL dots (singletons included) — revealed past
        // PAGE_TITLE_LOD_K_MIN, collision-culled (audit V3).
        drawPageTitleLabels(root, nodes);

        scheduleSettleChunk(ctx, function () {
            // ── Chunk 2: nebula + watermarks + links ──
            var linkAll = root.select('.links').selectAll('line.cluster-link');

            // Nebula clouds behind clusters
            drawNebula(root, clusters, nodes);

            // Watermark icons behind super-cluster groups
            drawWatermarks(root, clusters);

            // Position links at cluster centroids
            drawClusterLinks(root, linkAll, nodes, clusters, validLinks);

            scheduleSettleChunk(ctx, function () {
                // ── Chunk 3: fit zoom to content + Delaunay rebuild ──
                lastCanvasDims = { w: width, h: effectiveCanvasHeight(height) };
                if (ctx.prevTransform) {
                    fitToContent(nodes, width, effectiveCanvasHeight(height), storedZoomBehavior,
                        function (bbox) { contentBBox = bbox; });
                    svg.call(storedZoomBehavior.transform, ctx.prevTransform);
                } else {
                    fitToContent(nodes, width, effectiveCanvasHeight(height), storedZoomBehavior,
                        function (bbox) { contentBBox = bbox; });
                }
                // Task group W fix round 2 (vision-review F5, see
                // toggleGroupExpansion's own comment above for the full
                // mechanism writeup): an expand's frame is applied HERE,
                // AFTER the preserveView restore just above -- the same
                // relative order Dash's synchronous toggleGroupExpansion
                // gets for free (restore the pinned view, then frame over
                // it), reproduced explicitly because this run's settle is
                // async. `ctx.opts.frameGroupId` is only ever set by
                // toggleGroupExpansion (render()'s other callers never
                // pass it), and groupWorldBBox now reads FINAL, settled
                // positions (writePositionsIntoNodes already ran in
                // handleSimEnd before this chunk), unlike the removed
                // synchronous call site's stale pre-relayout bbox. Guarded
                // by the same scheduleSettleChunk/__simRunCtx identity
                // check every chunk already goes through -- a dispose() or
                // a superseding render() call mid-settle means this chunk
                // (and therefore this frame) never runs, same as the
                // preserveView restore just above it.
                if (ctx.opts && ctx.opts.frameGroupId != null) {
                    var expandBB = groupWorldBBox(ctx.opts.frameGroupId);
                    if (expandBB) frameWorldBBox(expandBB, { minRatio: 1.6, maxRatio: 2.6 });
                }
                rebuildDelaunay(nodes);

                // Header comment delta #31: onSettleEnd fires HERE, at the
                // tail of chunk 3 -- after fitToContent (and its
                // preserveView restore) and after INITIATING (not waiting
                // out) the knot-expand frame above; that transition's own
                // 500ms deliberately keeps animating past this signal, same
                // as item 26's own comment already establishes for the
                // frame itself. No extra staleness guard needed beyond what
                // scheduleSettleChunk already provides -- by the time this
                // callback body runs, `__simRunCtx === ctx` is already
                // confirmed (scheduleSettleChunk's own identity check).
                if (ctx.opts && typeof ctx.opts.onSettleEnd === 'function') ctx.opts.onSettleEnd();

                // Noise filter is now applied at render input (see
                // render() entry), so no post-render visibility patch is
                // needed.
            });
        });
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

        // Task V3 item 3 fix (header comment delta #28), GENERALIZED by
        // batch 03 V4 item 2 (header comment delta #31), and by fix review
        // I2 (delta #34): a caller that OMITS `opts` entirely --
        // __vendorToggleNoise's and applyTunerSnapshot's own
        // `render(rawData)` re-render tails, both by original design
        // ("re-run the SAME render with whatever's already configured") --
        // OR passes a REAL but SPARSE opts object that doesn't carry these
        // keys -- toggleGroupExpansion's knot-expand `render(rawData,
        // {preserveView, frameGroupId})` -- must not silently drop the
        // in-flight render's onFirstPaint/onRenderCycleStart/onSettleEnd/
        // onViewChange signals. Backfills whichever of the four this
        // call's own opts doesn't already specify from the CURRENT
        // __simRunCtx's own opts (the previous run, not yet overwritten
        // below) -- deliberately NOT the full opts object: `frameGroupId`
        // (only ever set by toggleGroupExpansion, see that field's own
        // comment further down) is a one-shot expand signal that must
        // never leak into an unrelated later re-render, and carrying
        // `preserveView` forward would change toggleNoise's/
        // applyTunerSnapshot's existing "reset to fit-content" behavior --
        // out of scope for this fix. onViewChange joined this list
        // (originally delta #34 shipped it OUTSIDE the carry set,
        // reasoning it was cheap enough to just re-pass on every real call
        // site) once review flagged that toggleNoise/applyTunerSnapshot's
        // own internal re-renders would otherwise leave Starfield.tsx
        // frozen on the pan/zoom state from before the toggle -- the SAME
        // "opts omitted, callback silently dropped" bug class delta #28
        // originally fixed for onFirstPaint. See delta #28/#31 for the
        // root-cause writeups this closes.
        var __priorCycleOpts = (__simRunCtx && __simRunCtx.opts) || null;
        if (__priorCycleOpts) {
            var __carriedCallbacks = {
                onFirstPaint: __priorCycleOpts.onFirstPaint,
                onRenderCycleStart: __priorCycleOpts.onRenderCycleStart,
                onSettleEnd: __priorCycleOpts.onSettleEnd,
                onViewChange: __priorCycleOpts.onViewChange,
            };
            opts = opts ? Object.assign({}, __carriedCallbacks, opts) : __carriedCallbacks;
        }

        // Header comment delta #31: onRenderCycleStart fires HERE,
        // synchronously, at the top of every real render cycle (past the
        // empty-payload guard above and the opts carry-forward just above)
        // -- the wrapper's settle veil (components/GraphCanvas.tsx) raises
        // on this signal. No __simRunCtx identity-check guard needed here
        // (unlike onSettleEnd, several hundred lines down in
        // finishRenderAfterSettle's chunk 3): this call always corresponds
        // to the CURRENT, about-to-run cycle, never a stale one.
        if (opts && typeof opts.onRenderCycleStart === 'function') opts.onRenderCycleStart();

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

        // Header comment delta #30: captured BEFORE the svg/if-else branch
        // below runs (which unconditionally (re)assigns `svg` either way).
        // Fix round 1 (F3 reviewer finding): `svg` truthy HERE means a
        // PRIOR render() call for this mount has STARTED (built the svg)
        // -- NOT that it has necessarily SETTLED. A re-render issued
        // before the mount's very first cycle finishes settling (e.g. a
        // rapid noise-toggle/tuner change fired before the initial layout
        // completes) still finds `svg` truthy here with `fitZoom` (module
        // var, read below at the zoom behavior's own construction site)
        // still parked at its `1` module-init default -- seeding a
        // BOUNDED `[0.5, 4]` interim extent from that default rather than
        // the wide-open absolute `[0.05, 6]` fallback. Never worse than
        // the pre-fix behavior either way, and self-correcting the moment
        // THIS cycle's own fitToContent runs (same as any other cycle) --
        // see that edit site's own comment for the full interim-zoom-clamp
        // writeup. `svg` is null (no prior fit to seed from at all) only
        // for the mount's genuine first-ever render, or the first render
        // after a container swap/dispose (both null `svg`, see items
        // 10/11/23).
        var __priorFitZoomForClamp = svg ? fitZoom : null;
        // Header comment delta #34: same "svg null means no prior mount to
        // trust" gate as __priorFitZoomForClamp just above -- without this,
        // __fitTransform (a plain module var, like fitZoom) would carry a
        // PRIOR, unrelated mount's fit transform into this genuinely fresh
        // mount/container-swap's very first 'zoom' tick, reporting a
        // nonsense parallax reference point instead of "no pan yet."
        if (!svg) __fitTransform = null;

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
                        // Final fix wave (Important #1): re-derive the SC
                        // layout record for the NEW canvas size before the
                        // fit below redraws watermarks -- otherwise the
                        // floor guarantee and every plate's exile onset
                        // stay pinned to whatever size was current at
                        // settle. Must run BEFORE fitToContent so its zoom
                        // handler (which calls drawWatermarks) sees the
                        // fresh record on this same tick.
                        remeasureScLayout(lastCanvasDims.w, lastCanvasDims.h);
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

        // Zoom + pan. Header comment delta #35 (2026-09-13, was stale
        // before then: "scroll only — no click-drag pan" -- d3-zoom's own
        // default filter already allowed click-drag pan and touch/pinch
        // even when this comment claimed otherwise; only wheel behavior
        // has ever actually changed here): plain wheel (a mouse wheel, or
        // two-finger trackpad scroll) pans via the dedicated 'wheel.pan'
        // listener below; Ctrl/Cmd+wheel (including a trackpad pinch,
        // which browsers deliver as a ctrlKey wheel event) zooms via
        // zoomBehavior's own default wheel handling. Click-drag and touch/
        // pinch are unaffected -- zoomBehavior's `.filter()` below mirrors
        // d3-zoom's own default for every non-wheel event type.
        // contentBBox is set by fitToContent after layout -- module-level
        // (header comment delta #19; see that entry's finishRenderAfterSettle
        // paragraph), not a fresh per-render() local: finishRenderAfterSettle
        // now runs as its own function (not nested inside render()), so a
        // per-call local here would be unreachable from its fitToContent
        // callback under this IIFE's 'use strict' (a ReferenceError, not a
        // silent global) -- promoting it to a module var alongside
        // lastCanvasDims/fitZoom/currentZoomK (which already have the exact
        // same "one current value, read by whichever zoom handler/observer
        // is currently live" shape) fixes that AND incidentally corrects a
        // pre-existing stale-closure gap: the ResizeObserver handler above
        // is created ONCE, on first mount, so its own `function (bb) {
        // contentBBox = bb; }` callback previously wrote to that FIRST
        // render() call's now-orphaned local, never the CURRENT render()'s
        // -- a later resize's re-fit silently never reached the live pan
        // clamp. A single shared module var makes every writer/reader
        // agree on the same binding regardless of which render() call
        // they were created in.

        // Header comment delta #30: interim zoom clamp. Seeds THIS cycle's
        // scaleExtent from whatever `fitZoom` a PRIOR render() call left
        // behind (__priorFitZoomForClamp, captured above BEFORE the
        // svg/if-else branch ran) when one exists, instead of the wide-open
        // absolute default -- usually that PRIOR cycle's own already-settled
        // fitZoom, but bounded to `fitZoom`'s `1` module-init default (still
        // far tighter than the absolute default) if a re-render lands before
        // the mount's very first cycle has settled (F3 reviewer finding; see
        // this fix's own header-comment paragraph for the full writeup). The
        // fit-relative clamp fitToContent itself applies (below) only lands
        // once THIS cycle's own settle actually completes, several seconds
        // later at real dataset scale. No prior render at all (first ever
        // for this mount, or the first after a container swap/dispose)
        // keeps the original absolute bounds.
        var zoomBehavior = d3.zoom()
            .scaleExtent(__priorFitZoomForClamp != null
                ? [__priorFitZoomForClamp * MIN_ZOOM_RATIO, __priorFitZoomForClamp * 4]
                : [0.05, 6])
            // Header comment delta #35: excludes a plain (non-modifier)
            // wheel tick from driving THIS behavior's own zoom -- the new
            // 'wheel.pan' listener below handles plain wheel instead (pan,
            // not zoom). Ctrl/Cmd+wheel still reaches d3-zoom's own default
            // wheel handling (browsers deliver two-finger trackpad pinch as
            // a ctrlKey wheel event, so this doubles as the pinch-to-zoom
            // gesture). The non-wheel branch is d3-zoom's own unmodified
            // default filter (`!event.ctrlKey && !event.button`) restated
            // explicitly -- `.filter()` REPLACES the default entirely
            // rather than composing with it, so drag-to-pan (mousedown/
            // pointerdown-driven) and touch/pinch, neither of which are
            // 'wheel' events, must be spelled out here too or they'd stop
            // working.
            .filter(function (event) {
                if (event.type === 'wheel') return !!(event.ctrlKey || event.metaKey);
                return !event.ctrlKey && !event.button;
            })
            // Fix review C2: d3-zoom's OWN default `wheelDelta` (verified
            // against the installed d3-zoom package,
            // node_modules/d3-zoom/dist/d3-zoom.js) already multiplies a
            // ctrlKey wheel's delta by 10 -- meant for a real trackpad
            // pinch, whose deltaY per gesture-tick is tiny, but a real
            // physical mouse's Ctrl+wheel notch delivers the SAME
            // deltaY magnitude a plain wheel pan tick does (~100), so
            // without a cap a single Ctrl+wheel notch on a mouse zoomed
            // ~4x (2^2) instead of a normal single-notch step. Restates
            // the exact same default formula (same coefficients, verified
            // against the source above) and additionally clamps the
            // exponent to [-0.5, 0.5] -- a single event can move `k` by at
            // most a factor of 2^0.5 (~1.41x), regardless of device or
            // deltaMode. A genuine trackpad pinch's own deltaY is small
            // enough that this cap almost never engages for it.
            .wheelDelta(function (event) {
                var d = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey ? 10 : 1);
                return Math.max(-0.5, Math.min(0.5, d));
            })
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
                // Header comment delta #34: fires on every zoom tick (pan,
                // wheel, pinch, the zoom-indicator's scaleBy/scaleTo, and
                // __d3ZoomTo alike -- every path funnels through this same
                // handler), AFTER the clamp above, so t.x/t.y are the final
                // clamped values -- Starfield.tsx's own parallax transform.
                // __fitTransform is null only before this mount's first
                // fitToContent has ever run; falling back to the just-
                // clamped t itself (cx/cy from the current canvas dims)
                // makes that tick's own fitX/fitY/fitK equal x/y/k (zero
                // offset), the correct "no pan yet" reading rather than an
                // undefined reference point.
                if (opts && typeof opts.onViewChange === 'function') {
                    var fit = __fitTransform || { x: t.x, y: t.y, k: t.k, cx: width / 2, cy: effectiveCanvasHeight(height) / 2 };
                    opts.onViewChange({
                        x: t.x, y: t.y, k: t.k,
                        fitX: fit.x, fitY: fit.y, fitK: fit.k,
                        cx: fit.cx, cy: fit.cy,
                    });
                }
            });
        svg.call(zoomBehavior);
        // d3-zoom's own dblclick-zoom conflicts with the app's dblclick
        // (clear + refit) handler above. zoomBehavior is a fresh d3.zoom()
        // instance every render, so svg.call(zoomBehavior) re-attaches its
        // internal 'dblclick.zoom' listener each time -- this disable must
        // be re-applied after every attach, not just once at construction.
        svg.on('dblclick.zoom', null);
        // Header comment delta #35: plain wheel pans (two-finger trackpad
        // scroll, or a mouse wheel), Ctrl/Cmd+wheel zooms (delta #35's own
        // `.filter()` above excludes a plain wheel from zoomBehavior's own
        // handling, so this listener owns it instead). `translateBy`
        // dispatches the SAME 'zoom' event zoomBehavior's own gestures do,
        // so the manual pan clamp inside the `.on('zoom', ...)` handler
        // above applies here too -- this listener never touches
        // `root.attr('transform', ...)` directly. Re-registered on every
        // render() cycle (like 'dblclick.zoom' just above) since `svg`
        // itself, not just zoomBehavior, is the event target and a
        // re-render's `if (!svg) {...} else {...}` branch never removes
        // pre-existing listeners on an EXISTING svg -- but this is cheap
        // (d3's `.on()` replaces the same-named listener, never stacks
        // duplicates) and matches the file's own existing convention.
        // `deltaMode` (WheelEvent's `DOM_DELTA_PIXEL`/`_LINE`/`_PAGE`, 0/1/2)
        // reports coarser units for some devices/OSes -- 16px roughly
        // approximates one text line, and a full page maps to the current
        // viewport height. Divides by `t.k` so the pan is a CONSTANT
        // screen-pixel amount at any zoom (translateBy's dx/dy are in the
        // behavior's own pre-scale coordinate space).
        svg.on('wheel.pan', function (event) {
            if (event.ctrlKey || event.metaKey) return; // zoomBehavior's own filter claims this gesture instead
            event.preventDefault();
            var t = d3.zoomTransform(svg.node());
            var mult = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? svg.node().clientHeight : 1;
            zoomBehavior.translateBy(svg, -event.deltaX * mult / t.k, -event.deltaY * mult / t.k);
        });
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

        // ── Phase 1: Compute layout via the Web Worker (Task group W,
        // header comment delta #19) -- see the "Task group W: Web Worker
        // sim glue" functions above (buildSimStartPayload,
        // handleSimTick/handleSimEnd, finishRenderAfterSettle) for what
        // used to be the rest of this function's body, inline.
        if (__simRafHandle != null) {
            __rafCancel(__simRafHandle);
            __simRafHandle = null;
        }
        __simRunCtx = {
            nodes: nodes,
            clusters: clusters,
            validLinks: validLinks,
            root: root,
            width: width,
            height: height,
            opts: opts,
            paintedOnce: false,
            // Captured HERE, not at settle time, so it still means "the
            // transform active when THIS render() call began" -- see
            // header comment delta #19's preserveView paragraph.
            prevTransform: (opts && opts.preserveView && svg) ? d3.zoomTransform(svg.node()) : null,
        };
        if (!__simClient) {
            __simClient = createWorkerSim({ onTick: handleSimTick, onEnd: handleSimEnd });
        }
        // Delta #36 (Task 4b): the sim-start payload embeds scFootprintParams(),
        // which is pre-scaled by plateFitScale -- write the scale for THIS
        // canvas first, or the worker's Phase-1.5b seed uses scale 1 on a
        // first mount and the previous canvas's scale on a re-render (the
        // settle-time write sites all run later). Same dims the settle path
        // uses: width, search-bar-adjusted height.
        plateFitScale = plateFitScaleFor(width, effectiveCanvasHeight(height));
        __simClient.start(buildSimStartPayload(nodes, clusters, validLinks, width, height));

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
        // Task V3 item 1 (header comment delta #27, user ruling 2026-08-10,
        // P1): the filter-dim layer only applies when NO selection is
        // active -- selection wins outright, matching Dash's ACTUAL wired
        // dispatch (app.py ~:3040). This REVERSES delta #15's union
        // composition (see that item's updated text, and delta #27, for
        // the full history): the highlight branches above are checked
        // first via `hasSelection`, and the filter is only unioned in when
        // that's false, instead of unconditionally.
        var hasSelection = Object.keys(highlightIds).length > 0;
        if (!hasSelection && filterDimNodeIds) {
            filterDimNodeIds.forEach(function (nid) { highlightIds[nid] = true; });
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
    // in app.py, not this file). GraphCanvas.tsx calls this directly
    // instead now (GraphA1.tsx did, at S2 sandbox time).
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
        // unmount/remount -- e.g. a client-side navigation that unmounts
        // and remounts GraphCanvas.tsx's center panel; the S2-era sandbox
        // route this guard was originally written against,
        // /sandbox/graph-a1, is long gone) would see `svg` still
        // non-null (pointing at the FIRST, now-detached, container) and
        // silently skip creating a new <svg> in the new container: blank
        // canvas, no error.
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
        // Batch 03 final whole-branch review fix (header comment delta
        // #23): a mount this wrapper's returned dispose() tore down
        // (rather than a container swap, handled above) leaves its old
        // <svg> still attached to `container` -- dispose() deliberately
        // does NOT touch the DOM itself, only nulls `svg` and its sibling
        // module state (so this `if (!svg)` reconstructs on the NEXT
        // render() call): a caller may rely on the last-rendered content
        // staying visible/frozen immediately after dispose(), with no
        // later render() call at all (see
        // d3-graph-vendor.remount.test.ts's "unmount mid-settle..." test,
        // which asserts exactly that). Any such leftover is removed here
        // instead, right before the untouched internal render()'s own
        // `if (!svg)` block (vendor ~:4023) appends a fresh one --
        // without this, a disposed-then-reused container (e.g.
        // GraphCanvas.tsx's mount effect disposing on a `hasNodes`
        // true->false transition and re-rendering into the SAME,
        // never-swapped container on the next true) would end up with
        // TWO stacked <svg> elements instead of one. `container.children`,
        // not a full `innerHTML` wipe -- this container also holds
        // React-managed siblings (GraphCanvas.tsx's empty-state/error/
        // debug-overlay divs) that must survive untouched. A no-op on a
        // genuine first-ever mount (nothing to remove yet) and on a
        // container swap (the guard above already reset `svg`, and the
        // NEW container is not expected to be carrying a stray <svg> of
        // its own).
        if (!svg) {
            var __staleSvgChildren = container.children;
            for (var __i = __staleSvgChildren.length - 1; __i >= 0; __i--) {
                var __child = __staleSvgChildren[__i];
                if (__child.tagName && __child.tagName.toLowerCase() === 'svg') __child.remove();
            }
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
            // Batch 03 final whole-branch review fix (header comment
            // delta #23 below): also forget the SAME-container mount's
            // svg/zoom/data state here, not just the ResizeObserver/
            // Escape handles teardownContainerHandlers() just removed --
            // see delta #23 for the round-trip bug this closes. Mirrors
            // the container-swap guard's own reset above (`svg` /
            // `storedZoomBehavior` / `lastCanvasDims` / `rawData` /
            // `__tunerInitialized`) so a dispose()'d mount and a swapped-
            // away mount leave the SAME clean slate for the next
            // `render()` call's `if (!svg)` block to rebuild against.
            // Deliberately DOES NOT touch the DOM itself (the old `<svg>`
            // and its content stay exactly as last rendered) -- a caller
            // may dispose() with no later render() call at all and expect
            // the last-rendered content to remain visible/frozen (see
            // "unmount mid-settle..." below), and on a TRUE final unmount
            // the whole container leaves the document anyway. The
            // leftover `<svg>` a SAME-container reuse would otherwise
            // stack a second one on top of is instead removed lazily, at
            // the START of the next `render()` call into this container
            // -- see __vendorRender's own `if (!svg)` cleanup, right
            // before it calls the untouched internal `render(data, opts)`.
            svg = null;
            storedZoomBehavior = null;
            lastCanvasDims = null;
            rawData = null;
            __tunerInitialized = false;
            // Task group W fix round 1 (review finding, Medium): final
            // unmount must also stop any in-flight sim run -- previously
            // only the container/Escape/ResizeObserver handlers were torn
            // down here, leaving the worker ticking against a now-DETACHED
            // svg (painting into nowhere at up to 60Hz) until it settled,
            // at which point it would still run the full settle-end
            // finishRenderAfterSettle tail for no one. `.stop()`, NOT
            // `__simClient.dispose()` -- dispose() permanently no-ops the
            // controller, and render()'s `if (!__simClient) { __simClient
            // = createWorkerSim(...); }` guard would then never recreate
            // it on a later remount, silently breaking every future mount
            // in this container's lifetime. `__simClient` is a
            // persistent, render()-call-spanning singleton by design (see
            // its own declaration comment) -- `.stop()` preserves that:
            // the SAME controller instance is reused. `.stop()` halts the
            // worker's tick loop (posts `{type: "stop"}`; sim.worker.ts's
            // handleStop clears its scheduled frame) and suppresses
            // callback delivery on this side -- it does NOT terminate the
            // worker, which keeps idling until the next `.start()` (the
            // call that actually terminates it, same as `.dispose()`).
            if (__simClient) __simClient.stop();
            // Belt-and-suspenders against a rAF-batched paint
            // (scheduleSimPaint) that was already QUEUED before dispose()
            // ran -- .stop()'s suppression stops handleSimTick/
            // handleSimEnd from ever firing again, but a rAF callback
            // scheduled by an EARLIER handleSimTick call isn't itself
            // cancelled by that; cancel it explicitly, and null
            // __simRunCtx so flushSimPaintNow's/handleSimTick's/
            // handleSimEnd's own `if (!ctx) return;` guards make a
            // straggler a no-op even if it still fires. Same reasoning
            // for onFirstPaint: it lives on `ctx.opts`, so nulling ctx
            // also makes a post-dispose onFirstPaint impossible.
            if (__simRafHandle != null) {
                __rafCancel(__simRafHandle);
                __simRafHandle = null;
            }
            __simRunCtx = null;
        };
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3GraphRender = __vendorRender;
        // Task group W fix round 1: test-only escape hatch, NOT part of
        // the original Dash dev-alias set (no matching `__vendorX`
        // binding, no EOF module export -- purely a debug/test utility
        // for lib/graph/d3-graph-vendor.remount.test.ts to deterministically
        // fast-forward finishRenderAfterSettle's chunked (multi-rAF-frame)
        // settle tail to completion without fake timers or real waits.
        // See flushPendingSettleChunk's own comment.
        window.__d3FlushSettleChunk = flushPendingSettleChunk;
        // Header comment delta #30: test-only escape hatch (same class as
        // __d3FlushSettleChunk above) -- exposes the CURRENT render cycle's
        // zoom behavior's live scaleExtent so d3-graph-vendor.remount.test.ts
        // can assert the interim clamp directly instead of driving a real
        // d3-zoom wheel gesture/transition through jsdom.
        window.__d3GetZoomScaleExtent = function () {
            return (storedZoomBehavior && typeof storedZoomBehavior.scaleExtent === 'function')
                ? storedZoomBehavior.scaleExtent()
                : null;
        };
        window.__d3ScLayoutReport = function () { return __scLayout ? __scLayout.report : null; };
        window.__d3ScLayout = function () { return __scLayout; };
        window.__d3SetScSeparationOptions = function (o) {
            if (o && typeof o.budgetRatio === 'number') SC_SEPARATION_BUDGET_RATIO = o.budgetRatio;
            if (o && typeof o.budgetMinPx === 'number') SC_SEPARATION_BUDGET_MIN_PX = o.budgetMinPx;
            // Item 3 (2026-09-13): live-tunable exile placement, same class
            // as the two options above -- validated against the two known
            // modes so a typo can't silently wedge the switch into a
            // falsy-but-not-'periphery' state.
            if (o && (o.exileClampMode === 'periphery' || o.exileClampMode === 'viewport')) SC_EXILE_CLAMP_MODE = o.exileClampMode;
            if (o && typeof o.exileMarginPx === 'number') SC_EXILE_MARGIN_PX = o.exileMarginPx;
        };
        // Item 3 (2026-09-13): read side of the option set above, so tests
        // (and live tuning) can assert/inspect the current values without
        // reaching into module-private state.
        window.__d3GetScSeparationOptions = function () {
            return {
                budgetRatio: SC_SEPARATION_BUDGET_RATIO,
                budgetMinPx: SC_SEPARATION_BUDGET_MIN_PX,
                exileClampMode: SC_EXILE_CLAMP_MODE,
                exileMarginPx: SC_EXILE_MARGIN_PX,
            };
        };
        // Final fix wave (Important #1): test-only escape hatch driving the
        // same node-immutable re-measure the ResizeObserver handler calls,
        // without needing a real jsdom resize (jsdom never fires
        // ResizeObserver on layout changes).
        window.__d3ScLayoutRemeasure = function (w, h) {
            remeasureScLayout(w, h);
            return __scLayout;
        };
        // Drives the REAL zoom behavior to absolute k around the viewport
        // center, so tests exercise the zoom-tick pipeline (updateLabelLOD /
        // updateLabelScale -> drawWatermarks -> updateEdgeChips) exactly as a
        // wheel gesture would.
        window.__d3ZoomTo = function (k) {
            if (!svg || !storedZoomBehavior || !lastCanvasDims) return false;
            var t = d3.zoomTransform(svg.node());
            var cxs = lastCanvasDims.w / 2, cys = lastCanvasDims.h / 2;
            var nx = cxs - (cxs - t.x) * (k / t.k), ny = cys - (cys - t.y) * (k / t.k);
            svg.call(storedZoomBehavior.transform, d3.zoomIdentity.translate(nx, ny).scale(k));
            return true;
        };
        // Almagest graph tuner (delta #33): live-preview a draft AlmagestParams
        // set (or null to fall back to shippedParams) without a re-render --
        // redraws just the SC nameplates via the same path a real zoom tick
        // uses (updateLabelScale -> drawWatermarks -> renderScName).
        window.__d3SetAlmagestPreview = function (params) {
            __almagestPreview = params || null;
            if (svg && rawData) updateLabelScale(currentZoomK);  // redraws watermarks only
        };
        // Batch A (spec: the 2026-09-13 graph-interaction-followups plan,
        // private): dev-only debug aid -- tints every SC nameplate by the
        // tier face it's currently painted in (Display/Mid/Text), so a dev
        // can see which breakpoint a given zoom level exercises. Off by
        // default and not persisted; redraws the same way the preview hook
        // above does.
        window.__d3SetAlmagestTierTint = function (on) {
            __almagestTierTint = !!on;
            if (svg && rawData) updateLabelScale(currentZoomK);
        };
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

    // Task V1 (vision-review fix loop) dev-console-contract note: the
    // if/else-if chain below matches exactly 'nodes' (array)/'node'
    // (auto-detects cluster membership, see the branch's own comment)/
    // 'session' -- type: 'cluster' (as a caller might reasonably guess, or
    // as an earlier task brief literally specified) matches NO branch and
    // is a SILENT no-op: every var above is already reset to null by the
    // time the if/else-if falls through, so the net effect is
    // indistinguishable from clearSelection() except updateHighlighting()
    // still runs. Live-verified both apps (task-V1-report.md) -- Dash runs
    // this exact same vendored logic, so this is inherited Dash behavior,
    // not a port regression; both apps are identical here. Use
    // `__vendorSetSelection('node', <cluster-id>)` to select a cluster --
    // the 'node' branch immediately below auto-detects cluster membership
    // via currentData.clusters.some(...) and routes to selectedClusterId
    // itself when the id matches a real cluster. Documented here so the
    // next person hitting a silent no-op from `window.__d3SetSelection`
    // doesn't have to rediscover this by reading the branches by hand.
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
     * Task A1-3 (header comment delta #15, precedence reversed by delta #27
     * -- user ruling 2026-08-10, P1, Task V3 item 1): set the independent
     * filter-dim layer (NavProvider's filterHighlightIds -- diary-window
     * filter dimming). Storage here is unconditional and deliberately does
     * NOT touch any of the selectedNodeId/selectedClusterId/selectedNodeIds/
     * selectedSessionId variables -- this setter's own state stays
     * orthogonal to selection's, same as NavState's own model (lib/nav.ts:
     * filter persists across selection changes). What CHANGED at delta #27
     * is how updateHighlighting() (see that function's own comment) reads
     * the two back: selection, when active, wins outright and this layer
     * does not render at all -- it only takes visual effect while no
     * selection is active. Not a union with whatever selection is current,
     * despite this delta's original #15 text (superseded).
     * @param {string[]|null|undefined} nodeIds - node ids to keep visible when no selection is active; empty/null/undefined clears the filter (dims nothing)
     */
    __vendorSetFilterDim = function (nodeIds) {
        filterDimNodeIds = (nodeIds && nodeIds.length > 0) ? nodeIds : null;
        updateHighlighting();
    };
    if (process.env.NODE_ENV !== "production") {
        window.__d3SetFilterDim = __vendorSetFilterDim;
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
    __vendorSetFilterDim as setFilterDim,
    __vendorToggleNoise as toggleNoise,
    __vendorFrameNodes as frameNodes,
    __vendorGetClusterPages as getClusterPages,
    __vendorHasNode as hasNode,
    __vendorDebugGetSelection as debugGetSelection,
    __vendorResetTunerToDefaults as resetTunerToDefaults,
    __vendorApplyTunerOverrides as applyTunerOverrides,
    __vendorExpandedGroups as expandedGroups,
};
