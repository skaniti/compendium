// Recency-weighted conversation window. Every finished exchange since the
// last clear is represented: the newest verbatim, older ones progressively
// condensed (deterministic truncation, no LLM), all inside one character
// budget. Replaces the flat "last 10 exchanges" slice.

// One prior turn sent as conversation context -- the backend's HistoryTurn
// wire contract (role user|assistant, non-empty content).
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface Exchange {
  user: string;
  assistant: string;
}

// Under the backend's 8000 total-char cap, with margin.
export const HISTORY_CHAR_BUDGET = 7500;
// The backend's per-turn cap.
export const HISTORY_TURN_CAP = 2000;
export const HISTORY_USER_MIN = 300;
export const HISTORY_ASSISTANT_MIN = 160;
export const HISTORY_ELLIPSIS = " …";

// Condense `text` to at most `allowance` chars (ellipsis included): whole
// text if it fits, else the last sentence boundary, then word boundary,
// then a hard cut, plus the ellipsis.
export function condense(text: string, allowance: number): string {
  if (text.length <= allowance) return text;
  const limit = Math.max(1, allowance - HISTORY_ELLIPSIS.length);
  // Sentence boundary: end exclusive `e <= limit`, either just after . ! ?
  // followed by whitespace, or just before a newline.
  let end = 0;
  for (let i = Math.min(limit, text.length - 1); i >= 1; i--) {
    const c = text[i];
    if (c === "\n") {
      end = i;
      break;
    }
    if ((c === "." || c === "!" || c === "?") && i + 1 <= limit && /\s/.test(text[i + 1] ?? "")) {
      end = i + 1;
      break;
    }
  }
  let cut = end > 0 ? text.slice(0, end).trimEnd() : "";
  if (!cut) {
    // Word cut only if it keeps at least half the limit; else hard cut.
    const sp = text.lastIndexOf(" ", limit);
    cut = sp >= limit / 2 ? text.slice(0, sp).trimEnd() : "";
  }
  if (!cut) cut = text.slice(0, limit).trimEnd();
  return cut + HISTORY_ELLIPSIS;
}

function allowances(k: number): { user: number; assistant: number } {
  if (k === 0) return { user: HISTORY_TURN_CAP, assistant: HISTORY_TURN_CAP };
  return {
    user: HISTORY_USER_MIN,
    assistant: Math.max(HISTORY_ASSISTANT_MIN, Math.floor(HISTORY_TURN_CAP / 2 ** k)),
  };
}

// `exchanges` oldest first. Returns alternating user/assistant turns,
// oldest first, never with empty content.
//
// Loop: condense every exchange to its age allowance; if over budget,
// shrink exchanges with k >= 2 (the two newest are exempt) oldest-first to
// their minimums; if still over, drop the oldest exchange and restart, so
// allowances are recomputed for the survivors and freed budget re-expands
// them.
export function buildHistory(exchanges: Exchange[]): HistoryTurn[] {
  let list = exchanges
    .map((e) => ({ user: e.user.trim(), assistant: e.assistant.trim() }))
    .filter((e) => e.user && e.assistant);

  while (list.length > 0) {
    const n = list.length;
    const rows = list.map((src, i) => {
      const a = allowances(n - 1 - i);
      return { user: condense(src.user, a.user), assistant: condense(src.assistant, a.assistant) };
    });
    const total = () => rows.reduce((s, r) => s + r.user.length + r.assistant.length, 0);
    for (let i = 0; i < n - 2 && total() > HISTORY_CHAR_BUDGET; i++) {
      rows[i] = {
        user: condense(list[i].user, HISTORY_USER_MIN),
        assistant: condense(list[i].assistant, HISTORY_ASSISTANT_MIN),
      };
    }
    if (total() <= HISTORY_CHAR_BUDGET || n === 1) {
      return rows.flatMap((r): HistoryTurn[] => [
        { role: "user", content: r.user },
        { role: "assistant", content: r.assistant },
      ]);
    }
    list = list.slice(1);
  }
  return [];
}
