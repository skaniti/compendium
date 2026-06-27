import type { AgentEvent } from "./types";

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
