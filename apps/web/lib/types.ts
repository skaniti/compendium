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

// Task group C, C2 (P7 locate-glyph port): one entry of the SSE complete
// event's `sources_detail` list, verified against
// backend/services/agent.py's `_build_sources_detail` (~195-215) and its
// two call sites (AgentResponse.sources_detail ~307, the SSE
// complete_event's own "sources_detail" key ~950) at explorer HEAD.
// `node_id` reproduces graph_builder._slugify(title) -- the SAME id shape
// GraphCluster.id / GraphNode.id use (lib/graph/vendor.d.ts's
// getClusterPages/hasNode both take/return this id family) -- NOT
// `page_id`, which indexes a different (page-row) table entirely and is
// not usable for joining against the graph. Either field is null when the
// citing tool couldn't resolve one (agent.py:1220-1240's own comment); the
// client must degrade to a plain, non-interactive source pill in that case
// rather than crash.
export interface SourceDetail {
  url: string;
  page_id: number | null;
  node_id: string | null;
}

export interface CompleteEvent {
  type: "complete";
  sources: string[];
  // Optional: the backend's early-exit completes (no OpenAI key, empty
  // compendium) omit cluster_ids, sources_detail, and images entirely.
  //
  // Task group C fix: was `number[]` -- WRONG. Verified against
  // backend/services/agent.py: `cluster_ids` is
  // `list(set(state.clusters_cited))` and `clusters_cited: list[str]` is
  // populated exclusively via `state.clusters_cited.append(c["cluster_slug"])`
  // (agent.py:1286/1329/1355/1487/1827) -- these are cluster SLUGS
  // (strings), matching GraphCluster.id (string) and the
  // getClusterPages(clusterId: string) signature (lib/graph/vendor.d.ts)
  // they're unioned through. The stale `number[]` annotation predates any
  // consumer of this field (comment above said "currently unconsumed")
  // and was never exercised against the real backend shape until now.
  cluster_ids?: string[];
  // Task group C, C2 (P7 locate-glyph port): NOT stripped by
  // _redact_complete_event (backend/services/agent.py ~568-583) -- that
  // helper only pops total_cost_usd/tool_calls_made for non-admin
  // sessions, so sources_detail (and cluster_ids above) survive redaction
  // and are visible to every caller regardless of role.
  sources_detail?: SourceDetail[];
  // Shape per the backend's _extract_image_markers; rendered as the
  // .chat-images-row under the sources row (max 6, Dash parity).
  images?: { thumb_url: string; source_url?: string | null }[];
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

// Task 8-C2 (header widget cards batch): originally defined in
// components/TimeWindowProvider.tsx -- moved here at Task A1-3 (batch 03)
// so lib/api.ts's fetchGraph() and hooks/useGraph.ts (neither of which
// import from components/, an established layering boundary in this repo)
// can reference it without a lib -> components dependency.
// TimeWindowProvider.tsx re-exports this under its original name, so its
// existing importers (HeaderCards.tsx) are unaffected.
//
// "365" is a legacy value the Dash graph filter still accepts (kept in the
// type for round-trip completeness) but renders NO pill -- there is no
// (label, "365") entry in DATE_RANGE_PILLS (HeaderCards.tsx).
export type TimeWindow = "all" | "7" | "30" | "90" | "365";

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

// Task 8-C1 (header-widget-cards batch foundations): topic-interest shapes,
// verified against compendium-explorer/backend/api/main.py's Topics section
// (~2812-3110) at HEAD. Two of these endpoints (members, rename) landed in
// the explorer repo concurrently with this task -- their shapes were
// dictated to the backend implementer verbatim and are locked as specified
// here rather than independently re-derived.

// GET /api/topics -- {topics: TopicInterest[]}; cluster_count = member
// clusters in the latest completed run (exact keyword match).
export interface TopicInterest {
  keyword: string;
  icon_id: string | null;
  cluster_count: number;
}

// GET /api/topics/{keyword}/members?limit= -- {members: TopicMember[]},
// ordered mean_membership_probability DESC NULLS LAST, page_count DESC,
// name (cluster_repo.get_top_clusters_for_keyword).
export interface TopicMember {
  cluster_name: string;
  page_count: number;
  mean_membership_probability: number | null;
}

// GET /api/topics/exclusions -- {exclusions: MemberExclusion[]}
export interface MemberExclusion {
  keyword: string;
  cluster_slug: string;
  cluster_name: string;
  created_at: string;
}

// Pipeline dev view (apps/api backend/api/routers/pipeline.py). Shapes mirror
// the router's bare dicts; every endpoint takes the shared period (`range`).
export type RangeKey = "7d" | "30d" | "90d" | "all";

export interface DecisionRow { key: string; label: string; count: number; evaluated: boolean }
export interface TopDomain { domain: string; count: number }
export interface ReasonRow { key: string; label: string; count: number; top_domains: TopDomain[] }
export interface SkipGateCategory { id: string; label: string; description: string }
export interface SkipGateConfig {
  model: string; temperature: number; prompt_name: string; prompt: string;
  tools: { name: string; description: string }[];
  categories: SkipGateCategory[];
}
export interface PipelineSummary {
  range: RangeKey;
  status_counts: { active: number; pending: number; archived: number };
  total_pages: number;
  archive_ratio: number;
  decisions: DecisionRow[];
  archive_reasons: ReasonRow[];
  skip_categories: ReasonRow[];
  skip_gate_config: SkipGateConfig;
  flow?: PipelineFlow; // optional: stale-API guard
  rule_filter_config?: RuleFilterConfig;
}
export type FlowOutcomeKey = "before_gate" | "rule_filter" | "gate" | "processed" | "pending";
export type FateKey = "archived" | "active" | "pending";
export interface FlowOutcome { key: FlowOutcomeKey; label: string; count: number; top_domains: TopDomain[] }
export interface FlowDetail { outcome: FlowOutcomeKey; key: string; label: string; count: number; top_domains: TopDomain[]; fates: Record<FateKey, number> }
export interface FlowFate { key: FateKey; label: string; count: number }
export interface PipelineFlow { total: number; outcomes: FlowOutcome[]; details: FlowDetail[]; fates: FlowFate[] }
export interface RuleFilterConfig { domains: string[]; domain_suffixes: string[]; url_patterns: { domain: string; path: string }[]; path_rules: string[] }
export type TimelineGranularity = "6h" | "day" | "week" | "month";
export interface TimelineBucket {
  start: string; // ISO with the viewer's local offset
  label_key: string;
  kept: number; archived: number; evaluated: number; skipped: number;
  categories: Record<string, number>;
  total: number; outcomes: Record<FlowOutcomeKey, number>; reached_gate: number;
}
export interface PipelineTimeline { range: RangeKey; granularity: TimelineGranularity; buckets: TimelineBucket[] }
export interface PipelinePage {
  id: number; title: string | null; domain: string | null; status: string;
  processing_depth: string | null; archive_reason: string | null;
  skip_reasoning: string | null; skip_category: string | null; visited_at: string | null; created_at: string | null;
  outcome: FlowOutcomeKey; detail: string; detail_label: string; fate: FateKey;
}
export type PageSortColumn = "title" | "domain" | "status" | "processing_depth" | "visited_at" | "created_at";
export type SortDir = "asc" | "desc";
export interface PipelinePagesResponse { rows: PipelinePage[]; total: number; limit: number; offset: number; sort: PageSortColumn; dir: SortDir }
