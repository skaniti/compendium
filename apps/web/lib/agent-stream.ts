import type { AgentEvent, CompleteEvent } from "./types";
import { recoverSession, redirectToLogin } from "./api";
import { sessionMayResume } from "./session-policy-client";

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

// One prior turn sent as conversation context -- the backend's HistoryTurn
// wire contract (role user|assistant, non-empty content). The backend caps
// and sanitizes; this is just the shape.
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// Dash parity (search_stream.js HISTORY_SEND_TURNS): the backend keeps the
// last 10 turns, so sending more is wasted bytes.
export const HISTORY_SEND_TURNS = 10;

function fetchAgentStream(query: string, history: HistoryTurn[], signal?: AbortSignal): Promise<Response> {
  // `history` is context distinct from `query` -- the current question is
  // never in both. Omitted entirely when empty so a fresh conversation
  // sends the same body it always did.
  const body = history.length > 0 ? { query, history: history.slice(-HISTORY_SEND_TURNS) } : { query };
  return fetch("/api/agent/query-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function streamAgentQuery(
  query: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  history: HistoryTurn[] = [],
): Promise<void> {
  let res = await fetchAgentStream(query, history, signal);
  if (!res.ok) {
    // Batch-04 fix-round bug: this talks to fetch directly (not apiFetch,
    // since it needs the raw stream body) so a post-lapse 401 here never
    // went through apiFetch's bounce-to-/login handling -- it just threw
    // a generic Error that useAgentChat rendered as a chat error bubble,
    // stranding the user on a dead page instead of sending them to
    // /login. res.status is already the structured signal (no need to
    // string-match the thrown message downstream): on 401, reuse the same
    // guarded navigate lib/api.ts's apiFetch uses and return without
    // throwing, since the caller is about to navigate away and an error
    // bubble would be pointless. Any other non-ok status still throws.
    //
    // D3 (session-expiry-tuning): before that bounce, try the same silent
    // single-flight recovery apiFetch attempts (recoverSession -- shared
    // with every other 401 handler, so a chat 401 alongside a panel 401 on
    // the same stale page load only rotates the refresh token once) and
    // retry this request exactly once on success. A retried request that
    // still 401s (or a failed recovery) falls through to the same
    // redirectToLogin as before. Gated by sessionMayResume exactly like
    // apiFetch's own 401 handling -- with no policy cookie (or one that
    // forbids resume/is outside its idle window), skip the doomed refresh
    // attempt entirely and bounce straight to /login.
    if (res.status === 401) {
      if (sessionMayResume(Date.now())) {
        const recovered = await recoverSession();
        if (recovered) {
          res = await fetchAgentStream(query, history, signal);
          if (res.ok) return readAgentStream(res, handlers);
          if (res.status !== 401) {
            throw new Error(`Agent request failed: ${res.status} ${res.statusText}`);
          }
        }
      }
      redirectToLogin();
      return;
    }
    throw new Error(`Agent request failed: ${res.status} ${res.statusText}`);
  }
  return readAgentStream(res, handlers);
}

async function readAgentStream(res: Response, handlers: StreamHandlers): Promise<void> {
  // The sole !res.body check (previously duplicated in streamAgentQuery
  // too) -- covers both call sites into this function: the normal ok path
  // above, and the post-recovery retry path in streamAgentQuery's 401
  // branch.
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
