import type { AgentEvent, CompleteEvent } from "./types";

/**
 * Pure: pull complete SSE events out of an accumulated text buffer.
 * Splits on "\n" and keeps the last (possibly partial) line as `rest`, which
 * tolerates both standard "\n\n" framing and the legacy single-"\n" framing.
 */
export function extractEvents(buffer: string): { events: AgentEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: AgentEvent[] = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as AgentEvent);
    } catch {
      // partial / keep-alive / malformed -- skip
    }
  }
  return { events, rest };
}

export interface StreamHandlers {
  onStatus?: (text: string) => void;
  onToken?: (text: string) => void;
  onComplete?: (event: CompleteEvent) => void;
}

export async function streamAgentQuery(
  query: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/agent/query-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!res.ok) throw new Error(`Agent request failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Agent response had no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = extractEvents(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.type === "status") handlers.onStatus?.(ev.text);
      else if (ev.type === "token") handlers.onToken?.(ev.text);
      else if (ev.type === "complete") handlers.onComplete?.(ev);
    }
  }
}
