// Verified against backend/services/agent.py (query_stream + tool_calls_log)
// and a live gpt-4o-mini run (2026-06-30). The private repo's
// STREAMING-CONTRACT.md was reconciled to these shapes 2026-07-05; until a
// shared contract artifact exists (monorepo time), backend event-shape
// changes must be mirrored here by hand.

export interface ToolCall {
  iteration: number;
  tool: string;
  arguments: Record<string, unknown>;
  result_preview: string;
}

export interface StatusEvent {
  type: "status";
  text: string;
}

export interface TokenEvent {
  type: "token";
  text: string;
}

export interface CompleteEvent {
  type: "complete";
  sources: string[];
  // Optional: the backend's early-exit completes (no OpenAI key, empty
  // compendium) omit cluster_ids and images entirely.
  cluster_ids?: number[];
  // Shape per the backend's _extract_image_markers; rendering still deferred.
  images?: { thumb_url: string; source_url: string }[];
  // Optional: _redact_complete_event (backend/services/agent.py, P5)
  // strips both of these whenever get_role(user_id) != "admin". That
  // includes acting-as-demo sessions -- the acted-as row IS the demo
  // user -- so the client's admin-ish chrome (role === "admin" ||
  // actingAsDemo) must never assume they're present.
  tool_calls_made?: ToolCall[];
  total_cost_usd?: number;
  iterations: number;
  model: string;
}

export type AgentEvent = StatusEvent | TokenEvent | CompleteEvent;

// Batch 02 (task 4): shapes for the graph/diary/clustering read endpoints,
// verified against the real backend at HEAD (backend/api/main.py) rather
// than invented ahead of the implementation -- fields the backend never
// sends are left off rather than guessed as optional.

export interface GraphNode {
  id: string;
  label: string;
  level: number;
  kind: string;
  visit_count: number;
  parent_id: string | null;
  children_ids: string[];
  capture_ids: string[];
  page_urls: string[];
  first_visited_at: string | null;
  // Present once a layout has positioned the node / HDBSCAN has scored it;
  // absent otherwise (e.g. a brand-new node before its first layout pass).
  x?: number;
  y?: number;
  outlier_score?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface GraphCluster {
  id: string;
  name: string;
  page_ids: string[];
  // Supercluster/group assignment is a post-recluster enrichment step, so
  // older or noise-only clusters may not carry these yet.
  super_cluster?: string;
  super_cluster_icon?: string | null;
  group_id?: number;
  group_tier?: string;
  group_label?: string;
}

export interface GraphSuperCluster {
  keyword: string;
  icon_id: string | null;
}

export interface GraphGroup {
  id: number;
  label: string;
  tier: string;
  source: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
  clusters: GraphCluster[];
  super_clusters: GraphSuperCluster[];
  groups: GraphGroup[];
}

// GET /api/graph/nodes/{id} -- 404 when the id is unknown (fetchNodeDetail
// returns null rather than throwing in that case; see lib/api.ts).
export interface NodeDetail {
  node: GraphNode;
  subtree: GraphNode[];
}

// Task 6 (batch 02): shared literal union for the day/week/month
// granularity toggle -- lives here (not inline in HistoryPanel/DiaryPanel)
// so both components import the same type instead of two independently
// drifting copies of the same three-string union.
export type Granularity = "day" | "week" | "month";

// GET /api/diary/windows?granularity=&filter_node_id= -- response is
// DiaryWindow[]. Both node_ids (numeric page ids as text) and
// graph_node_ids (title slugs) are present; they index different tables
// on the backend and callers need both.
export interface DiaryWindow {
  key: string;
  label: string;
  node_ids: string[];
  graph_node_ids: string[];
  cluster_freq: Record<string, number>;
  cluster_names: Record<string, string>;
  page_count: number;
}

// GET /api/pages/content?url= -- 404 when no content row matches (or the
// row isn't owned by the caller); fetchPageContent returns null then
// rather than throwing. `pid` is the page_content row id, the same value
// GET /api/pages/{pid}/preview expects.
export interface PageContent {
  pid: number;
  url: string;
  domain: string | null;
  extracted_text: string | null;
  content_summary: string | null;
  tool_selected: string | null;
  has_usable_html: boolean;
}

// GET /api/clustering/status -- presentation-ready strings rendered
// verbatim by the client (no-run state: title "CLUSTERING (NO RUNS YET)",
// stats_line1 "no recluster yet", stats_line2 ""; freshness "No cache" +
// "" color when there's no cache at all).
export interface ClusteringStatus {
  run_number: number | null;
  title: string;
  stats_line1: string;
  stats_line2: string;
  freshness_label: string;
  freshness_color: string;
}

// POST /api/recluster -- the endpoint returns
// ClusteringService.recluster_all()'s dict verbatim (verified in
// compendium-explorer/backend/services/clustering_service.py). That dict's
// exact keys vary by which early-exit path was taken (an already-running
// guard adds "skipped"; a too-few-pages exit adds "filter_stats"; the full
// run adds "featured_singleton_count", "filter_stats", "graph_nodes",
// "graph_edges") -- only the four keys common to every path are named here,
// the rest fall through the index signature instead of being enumerated
// and inevitably drifting out of sync with the backend.
export type ReclusterResult = {
  cluster_count: number;
  noise_count: number;
  naming_cost: number;
  elapsed_seconds: number;
} & Record<string, unknown>;
