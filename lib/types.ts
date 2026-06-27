// Verified against backend/services/agent.py (query_stream + tool_calls_log).
// NOTE: complete.tool_calls_made uses { iteration, tool, arguments,
// result_preview } -- NOT the { name, args, result_summary } in
// STREAMING-CONTRACT.md, which is stale on that one field.

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
  cluster_ids: number[];
  images: unknown[]; // deferred this slice; shape unverified
  tool_calls_made: ToolCall[];
  total_cost_usd: number;
  iterations: number;
  model: string;
}

export type AgentEvent = StatusEvent | TokenEvent | CompleteEvent;
