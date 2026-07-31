"use client";

// Batch 03 (graph canvas port) Task S3 -- "A2: React-owned" sandbox spike.
//
// d3-zoom bound to the mounted <svg>, transform applied directly to the
// ref'd <g class="graph-root"> -- vendor :3864-3931 (zoom setup + pan
// clamp) and :3451-3594 (fitToContent) re-expressed against React refs
// instead of a D3 selection over the whole render tree.
//
// Deliberately renders nothing (returns null) and owns NO React state of
// its own besides the one useSyncExternalStore subscription needed to know
// when positions first exist. Every zoom-driven visual update it makes --
// the graph-root transform, page-dot screen-clamped radius, hull-label LOD
// fade, hull-label collision cull -- is a direct DOM mutation via
// querySelectorAll/setAttribute, exactly like the vendor's own
// updatePageDotScale/updateLabelLOD/runLabelCull (all plain D3 `.attr`/
// `.style` calls against already-rendered elements). This is intentional:
// those three concerns are driven by the CURRENT ZOOM LEVEL, not by node
// POSITIONS, so routing them through React state would make every pan/zoom
// tick a React commit for the whole dots+labels subtree -- exactly the
// per-tick reconciliation cost the bake-off is trying to keep OFF the
// zoom/pan path (position-driven re-renders are what's being measured; see
// useForceLayout.ts's header comment). PageDots/HullLabels (GraphA2.tsx)
// render the base attributes once per position update and never set an
// inline `style`/`r`-clamp of their own that this component's writes would
// fight with on the next re-render -- see that file's comments at the
// relevant JSX for the exact contract.
//
// Background click -> onSelect(null, null) is NOT handled here (despite
// vendor :3735-3756 living inside the same setup block) -- it's a plain
// React onClick on the <svg> in GraphA2.tsx (checks event.target ===
// event.currentTarget), simpler than threading it through a second native
// listener here and avoids any native-vs-synthetic event ordering
// question. This component's only job is pan/zoom.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import type { ZoomBehavior } from "d3-zoom";
import { GRAPH_DEFAULTS } from "./constants";
import d3 from "./d3";
import {
  MIN_ZOOM_RATIO,
  clampedScale,
  hullLabelLineOffsets,
  hullLabelLodOpacity,
  pageDotRadius,
} from "./render-helpers";
import type { ForceLayoutStore } from "./useForceLayout";

export interface ZoomProps {
  svgRef: RefObject<SVGSVGElement | null>;
  rootRef: RefObject<SVGGElement | null>;
  layoutStore: ForceLayoutStore;
  width: number;
  height: number;
}

interface ContentBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CULL_DEBOUNCE_MS = 90; // vendor :1518 (scheduleLabelCull)
const CULL_PAD = 2; // vendor :1581

/** Screen-clamped page-dot radius + star-glyph scale, at the given
 *  absolute zoomK/fitZoom (vendor's updatePageDotScale, :1408-1425, minus
 *  the selected/armed 1.8x/1.5x emphasis -- there's no persistent
 *  selection styling in this sandbox's click-select stub, see GraphA2.tsx's
 *  header comment).
 *
 *  Review finding 1 (critical): pageDotRadius now takes the ABSOLUTE
 *  zoomK + fitZoom, not their pre-divided ratio -- see render-helpers.ts's
 *  clampedScale comment for why dividing by the ratio instead of zoomK
 *  left every screen-clamped size off by a factor of fitZoom.
 *
 *  Review finding 7: `use.star-spikes` gets ONLY a `scale(...)` transform
 *  here -- translate now lives on the wrapping `<g>` PageDots renders
 *  (React-owned, rewritten every tick as positions change). Previously
 *  this function wrote the WHOLE `translate(...) scale(...)` string, but
 *  so did PageDots' own per-tick render (at a stale, ratio-1 scale) --
 *  every position-driven re-render clobbered this function's zoom-correct
 *  scale until the next zoom event. Splitting translate (React, changes
 *  every tick) from scale (this function, changes only on zoom/pan) into
 *  two different attributes removes the fight: PageDots never sets
 *  `transform` on `use.star-spikes` at all (only a constant per-kind
 *  fallback, see that file's comment), so React's reconciler never
 *  touches it again after mount, and this function's write always sticks
 *  until the next zoom event recomputes it. */
function applyDotStyles(root: ParentNode, zoomK: number, fitZoom: number) {
  root.querySelectorAll<SVGCircleElement>("circle.page").forEach((el) => {
    const kind = el.getAttribute("data-kind") || "";
    el.setAttribute("r", String(pageDotRadius(kind, zoomK, fitZoom)));
  });
  root.querySelectorAll<SVGUseElement>("use.star-spikes").forEach((el) => {
    const kind = el.getAttribute("data-kind") || "";
    const s = pageDotRadius(kind, zoomK, fitZoom) * 0.95;
    el.setAttribute("transform", `scale(${s})`);
  });
}

/** Screen-clamped hull-label font-size + tspan repositioning (vendor's
 *  updateLabelScale, :1319-1357) -- review finding 2 (round 1): A2
 *  previously rendered a static "10px" WORLD-unit font-size that scaled
 *  geometrically with zoom instead of staying screen-clamped, and never
 *  repositioned tspans to compensate.
 *
 *  This sandbox has no SC radial-anchor override (render-helpers.ts's
 *  computeHullLabelLayout comment) -- every label, SC-like or not, uses
 *  the same "recompute from clusterTopY" repositioning formula (vendor's
 *  non-SC branch, :1346-1350); only the scale KEY/base font size differs
 *  for SC-like clusters (vendor :1332-1334), since that distinction is
 *  about typography, not the (unported) pill anchor.
 *
 *  Review round 2, finding 1: this function used to also read
 *  `data-cluster-top-y` and bake the live cluster position into the tspan
 *  `y` it wrote -- but GraphA2.tsx's HullLabels re-renders that SAME
 *  attribute every sim tick (unscaled), so whichever of the two writers
 *  ran last within the ~2s settle window won, and the fit-triggered zoom
 *  event (which always fires BEFORE settle finishes) always lost. Fixed by
 *  splitting ownership: GraphA2.tsx now applies `clusterTopY` via a
 *  `<text transform="translate(0,clusterTopY)">` it owns exclusively (see
 *  that file's HullLabels comment), and this function writes ONLY the
 *  zoom-scale-dependent RELATIVE offset (render-helpers.ts's
 *  hullLabelLineOffsets, clusterTopY-independent by construction) -- the
 *  two writers no longer touch a shared quantity, so neither can clobber
 *  the other. `data-line-count`/`data-is-sc` are written by GraphA2.tsx's
 *  HullLabels once per label (stable metadata, not tick-driven) for this
 *  function to read back on each zoom event. */
function applyLabelStyles(root: ParentNode, zoomK: number, fitZoom: number) {
  root.querySelectorAll<SVGTextElement>("text.hull-label").forEach((el) => {
    const isSC = el.getAttribute("data-is-sc") === "1";
    const thresholds = isSC ? GRAPH_DEFAULTS.SCALE_THRESHOLDS.scLabel : GRAPH_DEFAULTS.SCALE_THRESHOLDS.clLabel;
    const baseSize = isSC ? GRAPH_DEFAULTS.BASE_SC_LABEL_FONT_SIZE : GRAPH_DEFAULTS.BASE_LABEL_FONT_SIZE;
    const scale = clampedScale(zoomK, fitZoom, thresholds);
    const lblSize = baseSize * scale;
    el.setAttribute("font-size", `${lblSize}px`);

    const lineCount = Number(el.getAttribute("data-line-count") || "1");
    const offsets = hullLabelLineOffsets(lineCount, zoomK, fitZoom, isSC);
    el.querySelectorAll<SVGTSpanElement>("tspan").forEach((tspan, i) => {
      tspan.setAttribute("y", String(offsets[i]));
    });
  });
}

/** Page-count LOD fade for hull labels (vendor's updateLabelLOD,
 *  :1479-1499) -- writes `data-lod-opacity` (the pre-cull base opacity)
 *  and, unless the label is currently culled, the visible opacity too. */
function applyLodStyles(root: ParentNode, ratio: number) {
  root.querySelectorAll<SVGGElement>("g.hull-label-group").forEach((el) => {
    const pageCount = Number(el.getAttribute("data-page-count") || "0");
    const op = hullLabelLodOpacity(pageCount, ratio);
    el.setAttribute("data-lod-opacity", String(op));
    if (!el.hasAttribute("data-culled")) el.style.opacity = String(op);
  });
}

/** Greedy screen-space collision cull for hull labels (vendor's
 *  runLabelCull, :1577-1649), minus the watermark/group-caption/selection
 *  obstacle passes -- none of those render in this sandbox (nebula/
 *  watermarks/group-collapse are out of scope; see spec.md's F2 section).
 *  Priority: biggest cluster (by page count) wins contested screen space.
 *
 *  jsdom guard: every element measures {0,0,0,0} in the test environment
 *  (no real layout engine) -- rather than have every zero-sized rect
 *  "collide" with every other one and cull everything, a label whose rect
 *  has no area is left at its LOD opacity, uncontested. */
function runLabelCull(root: ParentNode) {
  const entries = Array.from(root.querySelectorAll<SVGGElement>("g.hull-label-group")).map((el) => ({
    el,
    pageCount: Number(el.getAttribute("data-page-count") || "0"),
  }));
  entries.sort((a, b) => b.pageCount - a.pageCount);

  const kept: DOMRect[] = [];
  function collides(r: DOMRect): boolean {
    return kept.some(
      (k) => r.left < k.right + CULL_PAD && k.left < r.right + CULL_PAD && r.top < k.bottom + CULL_PAD && k.top < r.bottom + CULL_PAD
    );
  }

  entries.forEach(({ el }) => {
    const lodAttr = el.getAttribute("data-lod-opacity");
    const baseOp = lodAttr == null ? 1 : Number(lodAttr);
    if (baseOp <= 0) {
      el.setAttribute("data-culled", "1");
      el.style.opacity = "0";
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // unmeasurable -- leave alone
    if (collides(rect)) {
      el.setAttribute("data-culled", "1");
      el.style.opacity = "0";
    } else {
      el.removeAttribute("data-culled");
      el.style.opacity = String(baseOp);
      kept.push(rect);
    }
  });
}

export default function Zoom({ svgRef, rootRef, layoutStore, width, height }: ZoomProps) {
  // Only used to learn "positions now exist" once, for the initial fit --
  // this component otherwise reads positionsRef directly (a ref read, not
  // a subscription) when it needs a bbox, same hot-path discipline as
  // PageDots/HullLabels.
  const version = useSyncExternalStore(layoutStore.subscribe, layoutStore.getVersion, () => 0);

  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const contentBBoxRef = useRef<ContentBBox | null>(null);
  const fitZoomRef = useRef(1);
  const currentKRef = useRef(1);
  const hasFitRef = useRef(false);
  const cullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Effect 1 (mount-once): wire d3-zoom to the svg. Pan clamp + the
  // per-tick style passes read contentBBoxRef/fitZoomRef via refs, so this
  // effect doesn't need to re-run when those are populated later by
  // Effect 2 below.
  useEffect(() => {
    const svgEl = svgRef.current;
    const rootEl = rootRef.current;
    if (!svgEl || !rootEl) return;
    const svgSel = d3.select(svgEl);

    function scheduleCull() {
      if (cullTimerRef.current) clearTimeout(cullTimerRef.current);
      cullTimerRef.current = setTimeout(() => {
        if (svgRef.current) runLabelCull(svgRef.current);
      }, CULL_DEBOUNCE_MS);
    }

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 6]) // vendor :3865, re-narrowed by fitToContent below
      .on("zoom", (event) => {
        const t = event.transform;
        // Pan clamp (vendor :3868-3915): may reach everything visible at
        // the MIN_ZOOM_RATIO zoom-out floor, at any zoom. Mutating
        // t.x/t.y in place is deliberate -- `t` IS the transform d3-zoom
        // stores internally for this element, so the clamp sticks.
        const bbox = contentBBoxRef.current;
        if (bbox) {
          const cx = bbox.x + bbox.w / 2;
          const cy = bbox.y + bbox.h / 2;
          const bw2 = bbox.w / MIN_ZOOM_RATIO;
          const bh2 = bbox.h / MIN_ZOOM_RATIO;
          const ex = cx - bw2 / 2;
          const ey = cy - bh2 / 2;

          const maxTx = -ex * t.k;
          const minTx = width - (ex + bw2) * t.k;
          t.x = minTx > maxTx ? (minTx + maxTx) / 2 : Math.max(minTx, Math.min(maxTx, t.x));

          const maxTy = -ey * t.k;
          const minTy = height - (ey + bh2) * t.k;
          t.y = minTy > maxTy ? (minTy + maxTy) / 2 : Math.max(minTy, Math.min(maxTy, t.y));
        }
        rootEl.setAttribute("transform", String(t));
        currentKRef.current = t.k;
        const ratio = fitZoomRef.current > 0 ? t.k / fitZoomRef.current : 1;
        // Critical fix (review finding 1): pageDotRadius/clampedScale need
        // the ABSOLUTE t.k/fitZoomRef.current, not the pre-divided ratio --
        // see applyDotStyles's comment. applyLodStyles/hullLabelLodOpacity
        // are unaffected (that formula is ratio-based in the vendor too,
        // :1481 `currentK / fitZoom`, never routed through clampedScale).
        applyDotStyles(svgEl, t.k, fitZoomRef.current);
        applyLabelStyles(svgEl, t.k, fitZoomRef.current);
        applyLodStyles(svgEl, ratio);
        scheduleCull();
      });

    zoomBehaviorRef.current = zoomBehavior;
    svgSel.call(zoomBehavior);
    // The vendor's own reasoning (:3926-3931) for disabling d3-zoom's
    // built-in dblclick-zoom: it would conflict with a future dblclick-to-
    // clear-and-refit gesture. No such gesture exists in this sandbox yet,
    // but disabling it keeps a stray dblclick from jumping the zoom level
    // unexpectedly, matching A1's behavior.
    svgSel.on("dblclick.zoom", null);

    return () => {
      svgSel.on(".zoom", null);
      if (cullTimerRef.current) clearTimeout(cullTimerRef.current);
    };
  }, [svgRef, rootRef, width, height]);

  // Effect 2: the one-time fit-to-content (vendor's fitToContent,
  // :3451-3594, minus the nebula/watermark bbox extensions -- neither
  // renders in this sandbox, see render-helpers.ts's computeHullLabelLayout
  // comment for the same scope note applied to label anchoring). Runs once
  // positions first exist (version > 0); re-runs harmlessly on later
  // version bumps but no-ops past the first successful fit.
  useEffect(() => {
    if (hasFitRef.current) return;
    if (version === 0) return;
    const svgEl = svgRef.current;
    const zoomBehavior = zoomBehaviorRef.current;
    if (!svgEl || !zoomBehavior) return;
    const positions = layoutStore.positionsRef.current;
    if (positions.size === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    positions.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    if (!isFinite(minX)) return;

    minX -= GRAPH_DEFAULTS.HULL_PADDING + GRAPH_DEFAULTS.FIT_WORLD_PAD;
    minY -= GRAPH_DEFAULTS.HULL_PADDING + GRAPH_DEFAULTS.FIT_WORLD_PAD + 20;
    maxX += GRAPH_DEFAULTS.HULL_PADDING + GRAPH_DEFAULTS.FIT_WORLD_PAD;
    maxY += GRAPH_DEFAULTS.HULL_PADDING + GRAPH_DEFAULTS.FIT_WORLD_PAD;
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw <= 0 || bh <= 0) return;

    hasFitRef.current = true;
    contentBBoxRef.current = { x: minX, y: minY, w: bw, h: bh };

    const scale = Math.min(width / bw, height / bh);
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    const transform = d3.zoomIdentity.translate(width / 2 - mx * scale, height / 2 - my * scale).scale(scale);

    fitZoomRef.current = scale;
    currentKRef.current = scale;
    zoomBehavior.scaleExtent([scale * MIN_ZOOM_RATIO, scale * 4]); // vendor :3584
    d3.select(svgEl).call(zoomBehavior.transform, transform); // fires the 'zoom' handler above, which applies dot/LOD/cull styles at the fit ratio (1.0)
  }, [version, svgRef, layoutStore, width, height]);

  return null;
}
