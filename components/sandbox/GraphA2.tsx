"use client";

// Batch 03 (graph canvas port) Task S3 -- "A2: React-owned" sandbox spike.
// Renders the sandbox bar (star-dot pages, cluster hull-label pills,
// wheel-zoom/drag-pan, click-select stub) as a plain SVG scene graph
// driven by React state/refs, instead of GraphA1's mount-a-div-and-let-D3-
// own-it approach. See lib/graph/useForceLayout.ts's header comment for
// the layout math (vendor-derived, adapted to run live) and
// lib/graph/Zoom.tsx's header comment for why pan/zoom stays fully
// imperative even in this "React-owned" variant.
//
// Scope cuts vs the full vendor file (all out of scope per spec.md's F2
// section -- "NOT in the sandbox bar: nebula, watermarks, LOD niceties,
// tooltips, knots, chips"; group-collapse is an additional cut this file
// makes on its own, justified below):
//   - No nebula clouds, watermarks, group captions, edge chips, tooltips,
//     near-zoom page-title reveal, or Delaunay hover-arming.
//   - No tier-driven collapse packing (batch C C1, `isCollapsedCluster`) --
//     every cluster gets its own hull label, none are suppressed in favor
//     of a single group caption. That whole feature (group_id/group_tier/
//     group_label, the "▸/▾" caption, expand/collapse state) isn't called
//     out anywhere in the sandbox-bar's explicit item list, unlike the
//     page-count LOD fade + collision cull below (which the vendor's own
//     header comment flags as load-bearing for "cluster hull-label pills"
//     specifically) -- so it's cut rather than partially ported.
//   - Selection is a pure callback stub (onSelect fires; nothing dims/
//     brightens on click) -- A1 inherits the vendor's full
//     updateHighlighting dimming for free since it IS the vendor file;
//     reproducing that in React was judged out of the "click-select stub"
//     bar this task's brief sets. Flagged in task-S3-report.md for the F2
//     scorecard.
//   - Hull-label placement uses the vendor's BASE anchor formula only
//     (centroid-x, 10th-percentile-top-y minus a fixed gap) -- the SC
//     radial-anchor override, watermark no-go ejection, and the pill-vs-
//     label AABB collision loop are all nebula/watermark/SC-pill
//     machinery that never runs here (see render-helpers.ts's
//     computeHullLabelLayout comment).

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { GraphCluster, GraphNode, GraphPayload, GraphSuperCluster } from "@/lib/types";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
import Zoom from "@/lib/graph/Zoom";
import { useForceLayout, type ForceLayoutStore } from "@/lib/graph/useForceLayout";
import {
  STAR_PATH_DEFS,
  buildClusterColorMap,
  computeHullLabelLayout,
  labelColor,
  pageDotRadius,
  starGlyphOpacity,
  starVariant,
  type HullLabelLayout,
} from "@/lib/graph/render-helpers";

export type SelectKind = "node" | "cluster" | null;

export interface GraphA2Props {
  data: GraphPayload;
  // Fires once right after the FIRST commit of dots -- the phyllotaxis
  // seed, before the live sim has ticked at all (see useForceLayout.ts's
  // header comment for why "first dots" is the seed, not the settled
  // layout -- this is the honest A2 equivalent of A1's "render() returned,
  // dots are on screen" moment).
  onFirstPaint?: () => void;
  // Same callback shape as A1's opts.onSelect (kind 'node' | 'cluster' |
  // null, id or null) -- the bake-off compares select behavior across
  // both variants. Defaults to a console stub matching A1's.
  onSelect?: (kind: SelectKind, id: string | null) => void;
}

// vendor :3728-3729's own fallback when the container hasn't laid out yet
// (`rect.width || 800`); reused here for the same reason, and doubles as
// the deterministic size unit tests render against (jsdom's
// getBoundingClientRect always returns zeros).
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 600;

function defaultOnSelect(kind: SelectKind, id: string | null) {
  console.info("[GraphA2] select", { kind, id });
}

export default function GraphA2({ data, onFirstPaint, onSelect }: GraphA2Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rootRef = useRef<SVGGElement | null>(null);

  // Measured once on mount (not via ResizeObserver -- see A1's own S2 fix
  // comment in app/sandbox/graph-a1/page.tsx for the indefinite-height
  // ResizeObserver feedback loop that pattern caused; this sandbox's
  // scope doesn't call for live window-resize responsiveness, see the
  // header comment's scope-cuts list).
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    setDims({ width: rect?.width || FALLBACK_WIDTH, height: rect?.height || FALLBACK_HEIGHT });
  }, []);
  const width = dims?.width ?? 0;
  const height = dims?.height ?? 0;

  const onSelectRef = useRef(onSelect ?? defaultOnSelect);
  onSelectRef.current = onSelect ?? defaultOnSelect;
  // Stable identity across GraphA2 re-renders (an inline arrow prop would
  // change PageDots'/HullLabels' props every render and defeat their
  // memoization below).
  const handleSelect = useCallback((kind: SelectKind, id: string | null) => {
    onSelectRef.current(kind, id);
  }, []);

  const onFirstPaintRef = useRef(onFirstPaint);
  onFirstPaintRef.current = onFirstPaint;
  // Stable identity (useMemo, deps []) so useForceLayout's effect deps
  // don't see a "new" callbacks object every render and re-run the sim.
  const layoutCallbacks = useMemo(() => ({ onFirstPaint: () => onFirstPaintRef.current?.() }), []);

  const layoutStore = useForceLayout(data.nodes, data.clusters, data.links, width, height, layoutCallbacks);

  const handleBackgroundClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      if (event.target === event.currentTarget) handleSelect(null, null);
    },
    [handleSelect]
  );

  return (
    // Same #d3-graph-container id GraphA1 uses -- app/styles/theme.css's
    // `#d3-graph-container > svg` edge-fade mask and the unscoped
    // `circle.page, use.star-spikes { color: var(--ink) }` rule both
    // apply here too (the two sandboxes are different routes, never
    // mounted simultaneously, so the shared id doesn't collide).
    <div id="d3-graph-container" ref={containerRef} style={{ width: "100%", height: "100%" }}>
      {width > 0 && height > 0 ? (
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${width} ${height}`}
          onClick={handleBackgroundClick}
        >
          <defs>
            {STAR_PATH_DEFS.map((d, i) => (
              <path key={i} id={`star-v${i}`} d={d} />
            ))}
          </defs>
          <g className="graph-root" ref={rootRef}>
            <PageDots nodes={data.nodes} layoutStore={layoutStore} onSelect={handleSelect} />
            <HullLabels
              clusters={data.clusters}
              superClusters={data.super_clusters}
              layoutStore={layoutStore}
              onSelect={handleSelect}
            />
          </g>
        </svg>
      ) : null}
      <Zoom svgRef={svgRef} rootRef={rootRef} layoutStore={layoutStore} width={width} height={height} />
    </div>
  );
}

// ── Dots layer ──────────────────────────────────────────────────────────
// The one component the brief calls out by name: "the dots layer as a
// single memoized component keyed by the positions version." It's the
// only thing in this file that actually needs to re-render on every sim
// tick, so it's the only thing that subscribes to layoutStore via
// useSyncExternalStore -- GraphA2 itself never does (see its
// onFirstPaint wiring above), so a tick only ever re-renders this one
// subtree, never the chip/Zoom/svg wrapper riding alongside it.
//
// wrapped in React.memo even though its own re-render trigger (the
// useSyncExternalStore subscription) is internal, not prop-driven: it
// stops an unrelated GraphA2 re-render (e.g. the one-time `dims` state
// commit) from re-rendering this subtree too, since `nodes`/`layoutStore`/
// `onSelect` are all referentially stable across such a re-render (see
// their construction above).

interface PageDotsProps {
  nodes: GraphNode[];
  layoutStore: ForceLayoutStore;
  onSelect: (kind: SelectKind, id: string) => void;
}

const PageDots = memo(function PageDots({ nodes, layoutStore, onSelect }: PageDotsProps) {
  const version = useSyncExternalStore(layoutStore.subscribe, layoutStore.getVersion, () => 0);
  if (version === 0) return null; // nothing seeded yet
  const positions = layoutStore.positionsRef.current;

  return (
    <g className="nodes">
      {nodes.map((n) => {
        const pos = positions.get(n.id);
        if (!pos) return null;
        // Rendered at zoomK=1/fitZoom=1 (both refs' actual pre-fit default,
        // vendor :368's own `var fitZoom = 1`) -- Zoom.tsx's applyDotStyles
        // takes over the `r`/scale attributes imperatively on every zoom
        // tick afterward (see that file's header comment); this initial
        // value is what's on screen between "first paint" and the first
        // zoom/pan gesture (in practice, the fit-to-content call that
        // follows almost immediately).
        const r = pageDotRadius(n.kind, 1, 1);
        const dotClass = n.kind === "singleton" ? "page singleton" : n.kind === "unclustered" ? "page unclustered" : "page";
        // Review finding 7: the star glyph's translate (position, changes
        // every sim tick) and scale (zoom-driven, changes only on zoom/pan)
        // are split across two elements so React and Zoom.tsx never write
        // the same attribute. The outer <g> gets a React-owned `translate`
        // that legitimately changes every tick; the inner <use> gets a
        // CONSTANT `scale` -- since `r` only depends on `n.kind` (not
        // position), this expression evaluates to the SAME string on every
        // re-render, so React's reconciler never re-issues that DOM write
        // after mount, and Zoom.tsx's later `scale(...)` writes (see that
        // file's applyDotStyles) are never clobbered by a tick-driven
        // re-render. Previously both lived in ONE `transform` string on
        // the `<use>` itself, so every tick's translate change forced a
        // full-string rewrite that also stomped Zoom's scale.
        return (
          <Fragment key={n.id}>
            {/* vendor :3996-4003 -- the visible glyph. */}
            <g transform={`translate(${pos.x},${pos.y})`}>
              <use
                className="star-spikes"
                href={`#star-v${starVariant(n.id)}`}
                data-kind={n.kind}
                transform={`scale(${r * 0.95})`}
                fill="currentColor"
                opacity={starGlyphOpacity(n.visit_count)}
                pointerEvents="none"
              />
            </g>
            {/* vendor :4006-4045 -- invisible (fill-opacity 0) hit target;
                visiblePainted (not the CSS default) is what still makes it
                clickable despite the transparent fill -- same trick the
                vendor's own comment there explains. `r` is likewise a
                per-kind constant (not position-derived), so it survives
                Zoom.tsx's later writes the same way. */}
            <circle
              className={dotClass}
              data-kind={n.kind}
              r={r}
              cx={pos.x}
              cy={pos.y}
              fill="currentColor"
              fillOpacity={0}
              stroke="none"
              pointerEvents="visiblePainted"
              onClick={(event) => {
                event.stopPropagation();
                onSelect("node", n.id);
              }}
            />
          </Fragment>
        );
      })}
    </g>
  );
});

// ── Hull labels ──────────────────────────────────────────────────────────

interface HullLabelsProps {
  clusters: GraphCluster[];
  superClusters: GraphSuperCluster[];
  layoutStore: ForceLayoutStore;
  onSelect: (kind: SelectKind, id: string) => void;
}

const HullLabels = memo(function HullLabels({ clusters, superClusters, layoutStore, onSelect }: HullLabelsProps) {
  const version = useSyncExternalStore(layoutStore.subscribe, layoutStore.getVersion, () => 0);
  // Review finding 6: colorMap/labelFillMap used to be recomputed from
  // computeClusterPositionCentroids(clusters, positions) -- LIVE, MOVING
  // page-node positions -- on every single tick, which (a) re-ran
  // buildClusterColorMap's getGalaxyStops() and (b) called labelColor()
  // (a getComputedStyle hit apiece) once per label, every tick: ~100+
  // getComputedStyle calls/frame on the real dataset, and angle-based hues
  // drifting visibly while the sim settles (the vendor assigns colors ONCE,
  // post-layout, since it never re-renders after its one synchronous
  // paint). Fixed by memoizing on `hasPositions` (flips false->true exactly
  // once, at the first commit) instead of `version` (bumps every tick) --
  // and by sourcing centroids from the STABLE Phase-1/1.75 store
  // (layoutStore.clusterCentroidsRef, populated once, synchronously, before
  // Phase 2 ever seeds a page node -- see useForceLayout.ts) instead of the
  // live/settling page positions. Must be called unconditionally, before
  // the early return below (rules of hooks).
  const hasPositions = version > 0;
  const { colorMap, labelFillMap } = useMemo(() => {
    const centroids = layoutStore.clusterCentroidsRef.current;
    const cMap = buildClusterColorMap(clusters, superClusters, centroids);
    const fillMap = new Map<string, string>();
    cMap.forEach((color, id) => fillMap.set(id, labelColor(color)));
    return { colorMap: cMap, labelFillMap: fillMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `hasPositions`
    // stands in for "clusterCentroidsRef is now populated"; it flips once
    // and never again, which is exactly the "compute once" cadence this
    // fix wants (clusters/superClusters/layoutStore are themselves stable
    // for the component's lifetime, same contract as the rest of this file).
  }, [clusters, superClusters, layoutStore, hasPositions]);

  if (version === 0 || clusters.length === 0) return null;
  const positions = layoutStore.positionsRef.current;

  const layouts: HullLabelLayout[] = [];
  clusters.forEach((c) => {
    const memberPoints: Array<[number, number]> = [];
    c.page_ids.forEach((pid) => {
      const p = positions.get(pid);
      if (p) memberPoints.push([p.x, p.y]);
    });
    const layout = computeHullLabelLayout(c, memberPoints);
    if (layout) layouts.push(layout);
  });

  return (
    <g className="hull-labels">
      {layouts.map((layout) => {
        const fill = labelFillMap.get(layout.clusterId) ?? "#888888";
        const startY = layout.y - ((layout.lines.length - 1) * layout.lineH) / 2;
        return (
          <g
            key={layout.clusterId}
            className="hull-label-group"
            data-page-count={layout.pageCount}
            cursor="pointer"
            pointerEvents="bounding-box" // vendor :4400
            onClick={(event) => {
              event.stopPropagation();
              onSelect("cluster", layout.clusterId);
            }}
          >
            <text
              className="hull-label"
              textAnchor="middle"
              // Constant per render (BASE_LABEL_FONT_SIZE never varies) --
              // Zoom.tsx's applyLabelStyles (review finding 2) owns the
              // screen-clamped value from the first zoom event onward
              // (fired synchronously by the initial fit-to-content call);
              // this is what's on screen only in the brief window before
              // that. Being a constant expression means React's
              // reconciler never re-touches this attribute after mount
              // (same "no clobber" contract as PageDots' star-glyph
              // scale, see that component's comment), so Zoom's write
              // sticks across tick-driven re-renders.
              fontSize={`${GRAPH_DEFAULTS.BASE_LABEL_FONT_SIZE}px`}
              fontWeight={600}
              fill={fill}
              // Metadata for Zoom.tsx's applyLabelStyles -- vendor
              // :4691-4696's data-cluster-top-y/data-line-count, plus a
              // data-is-sc flag (vendor distinguishes SC-pill vs plain
              // labels via the datum directly; this DOM-imperative port
              // has no datum to read, so it's stashed as an attribute).
              // These update every render (cluster position tracks the
              // live sim), unlike font-size/fill above.
              data-cluster-top-y={layout.clusterTopY}
              data-line-count={layout.lines.length}
              data-is-sc={layout.isSuperClusterLike ? "1" : undefined}
              // vendor :4686/:4718 -- SC-like clusters render a touch
              // brighter (0.95 vs 0.7) since they no longer get the retired
              // pill background to set them apart (applySCMarker's small
              // colored dot is skipped here -- it needs getBBox, and is a
              // decorative nicety on top of an already out-of-scope nebula/
              // SC-pill system).
              opacity={layout.isSuperClusterLike ? 0.95 : 0.7}
            >
              {layout.lines.map((line, i) => (
                <tspan key={i} x={layout.x} y={startY + i * layout.lineH}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </g>
  );
});
