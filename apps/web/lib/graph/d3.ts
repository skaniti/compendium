// Batch 03 (graph canvas port) Task S2 -- mechanical delta #1, pre-
// authorized by the task brief: the Dash page loaded a single global `d3`
// UMD bundle (a `<script src="…d3.v7.min.js">` tag before d3_graph.js);
// this repo installs d3 as scoped micro-packages instead (npm convention,
// smaller bundles). This module re-exports exactly the subset
// lib/graph/d3-graph-vendor.js uses as one `d3` namespace object, so the
// vendored file's `d3.foo(...)` call sites don't need touching -- see that
// file's header comment for the full accounting of what changed and why.
//
// d3-transition is imported for its SIDE EFFECT ONLY (it patches
// `Selection.prototype.transition` when loaded) -- the vendor file calls
// `.transition()` on plain d3-selection Selections (e.g.
// `svg.transition().duration(200).call(...)`), which only exists once
// d3-transition has been loaded somewhere in the bundle. Nothing here
// references its named exports directly.
import "d3-transition";

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import { select, pointer } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform } from "d3-zoom";
import { Delaunay } from "d3-delaunay";
import { line, curveBasisClosed } from "d3-shape";
import { polygonHull } from "d3-polygon";

const d3 = {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  pointer,
  zoom,
  zoomIdentity,
  zoomTransform,
  Delaunay,
  line,
  curveBasisClosed,
  polygonHull,
};

export default d3;
