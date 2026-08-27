// Task group C (batch 03 graph-canvas port): chat<->graph interop --
// ports search_stream.js's highlightClusters/computeVisibleGraphHeight
// (:298-333 at explorer 4bb0a64, cluster-cite framing) and
// frameSourceNode/the hasNode half of makeLocatePillGroup (:190-232,
// :347-350, the P7 source-pill locate glyph) to the Next module-export
// world.
//
// Dash's guards check `window.__d3GetClusterPages`/`window.__d3FrameNodes`
// existence directly -- those globals are populated synchronously the
// moment d3_graph.js's <script> tag finishes evaluating. This port has no
// synchronous equivalent: lib/graph/d3-graph-vendor.js is loaded via a
// dynamic import() (components/GraphCanvas.tsx's own mount effect uses the
// same pattern), which is inherently async and can also genuinely reject
// (chunk-load failure). Every export below therefore (a) awaits the
// import, (b) swallows a rejection to a null module, and (c) re-checks
// that the specific function(s) it needs actually exist on whatever
// resolved -- the three-part version of Dash's single `if (!window.__d3*)
// return;` check, covering "not loaded yet", "failed to load", and "loaded
// but this build predates the export" alike. No caching layer on top of
// the bare import() call: repeated dynamic imports of an already-resolved
// ES module specifier are cheap (module-graph cache), and skipping a
// manual cache keeps every call site trivially mockable per-test via
// vi.doMock, with nothing to reset except the module registry itself.
type VendorModule = typeof import("@/lib/graph/d3-graph-vendor.js");

async function loadVendor(): Promise<Partial<VendorModule> | null> {
  try {
    return await import("@/lib/graph/d3-graph-vendor.js");
  } catch {
    return null;
  }
}

/** Visible canvas height (container minus the search-bar overlay), shared
 * by every call site that frames nodes so the bar never covers the framed
 * target. Verbatim port of search_stream.js's computeVisibleGraphHeight()
 * (:298-305) -- the Next shell reuses the SAME two DOM ids Dash measures
 * (`#d3-graph-container`: components/GraphCanvas.tsx's root div;
 * `#search-bar`: components/SearchBar.tsx's overlay div, whichever of its
 * minimized/maximized states currently applies), so the measurement itself
 * needed no adjustment beyond the direct id lookup already matching. */
export function computeVisibleGraphHeight(): number {
  if (typeof document === "undefined") return 600;
  const container = document.getElementById("d3-graph-container");
  const bar = document.getElementById("search-bar");
  let visibleH = container ? container.offsetHeight : 600;
  if (bar) visibleH -= bar.offsetHeight;
  if (visibleH < 100) visibleH = 200;
  return visibleH;
}

/** C1: on a chat completion citing cluster_ids, union the member node ids
 * via the vendor's getClusterPages and frame them. Port of
 * search_stream.js's highlightClusters (:307-321); no-ops (no import, no
 * DOM read) on an empty/absent cluster_ids list, same short-circuit order
 * as the source. */
export async function frameCitedClusters(clusterIds: string[] | undefined): Promise<void> {
  if (!clusterIds || clusterIds.length === 0) return;
  const vendor = await loadVendor();
  if (!vendor?.getClusterPages || !vendor.frameNodes) return;

  const allNodeIds: string[] = [];
  for (const clusterId of clusterIds) {
    const pages = vendor.getClusterPages(clusterId) ?? [];
    for (const nodeId of pages) {
      if (!allNodeIds.includes(nodeId)) allNodeIds.push(nodeId);
    }
  }
  if (!allNodeIds.length) return;

  vendor.frameNodes(allNodeIds, computeVisibleGraphHeight());
}

/** C2: whole-graph "is this node on the map" check backing the source-pill
 * locate glyph's render-time gate. Port of the window.__d3HasNode branch
 * of makeLocatePillGroup (:216-218) -- the knownNodeIds/collectKnownNodeIds
 * cluster-scoped fallback is deliberately NOT ported (task-C-brief.md: the
 * glyph gate here is exactly "node_id present AND hasNode(node_id)", no
 * degraded fallback path). Resolves false (never throws) for an absent/
 * not-yet-loaded module -- callers render a plain pill in that case. */
export async function hasGraphNode(nodeId: string): Promise<boolean> {
  const vendor = await loadVendor();
  if (!vendor?.hasNode) return false;
  try {
    return vendor.hasNode(nodeId);
  } catch {
    return false;
  }
}

/** C2: select + frame a single cited source's node on the starfield. Port
 * of search_stream.js's frameSourceNode (:347-350) -- the locate glyph's
 * click handler. No re-check of hasGraphNode here: the glyph is only ever
 * rendered once the caller has already confirmed hasGraphNode(nodeId), so
 * frameNodes' own internal "no matching node in currentData" no-op (vendor
 * :5698-5701) is the only guard this needs against a graph reload racing
 * the click. */
export async function frameSourceNode(nodeId: string): Promise<void> {
  const vendor = await loadVendor();
  if (!vendor?.frameNodes) return;
  vendor.frameNodes([nodeId], computeVisibleGraphHeight());
}
