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
  tool_calls_made: ToolCall[];
  total_cost_usd: number;
  iterations: number;
  model: string;
}

export type AgentEvent = StatusEvent | TokenEvent | CompleteEvent;
