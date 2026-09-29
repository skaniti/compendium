"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamAgentQuery } from "@/lib/agent-stream";
import { buildHistory, type Exchange, type HistoryTurn } from "@/lib/chat-history";
import { frameCitedClusters } from "@/lib/graph/chat-interop";
import type { CompleteEvent } from "@/lib/types";

// Extracted verbatim (state/streaming logic only -- no JSX) from the old
// full-page components/Chat.tsx as part of the search-bar re-home (Task 10).
// Presentation now lives in components/SearchBar.tsx; this hook is the
// single source of truth for the conversation state both the message list
// and the input row read/drive.
//
// 2026-07-28 (chat parity fix 1): restructured from `userMsgs: string[]` +
// a single shared `assistant: AssistantMessage | null` slot to a `turns:
// Turn[]` array. The single-slot shape was the bug: every send() replaced
// `assistant` wholesale, so a second query erased the first answer from
// the screen instead of appending beside it. Dash's search_stream.js never
// has this problem because runStreamingQuery() (~469-523) appends a brand
// new assistantRow DOM node per turn and holds a direct reference to THAT
// row for the rest of its streaming lifetime -- prior rows are just other
// nodes still sitting in #search-conversation. `turns` + id-addressed
// updates (see updateAssistant below) is this hook's equivalent: each
// send() owns one Turn object for its whole lifetime, addressed by an id
// that's never reused, so turns never collide across sends. Auto-scroll
// (Dash's scrollIfPinned/pinned-to-bottom tracking) is NOT ported here --
// out of scope for this fix, which is display-persistence only.

export interface AssistantMessage {
  text: string; // streamed raw text (mid-flight)
  done: boolean; // true after `complete` -> render markdown
  status: string; // transient label
  meta?: CompleteEvent; // sources + trace
  error?: string;
}

// One user/assistant exchange. `id` is a monotonically-increasing,
// never-reused identifier assigned at send()-time -- it's what lets every
// streaming callback for a turn (onStatus/onToken/onComplete/the abort or
// error catch, and even a requestAnimationFrame-batched flush that fires
// late) find and update ONLY its own turn, never "the last turn" or "the
// currently active turn". That distinction matters across clear(): once
// clear() empties `turns`, a straggling callback from the just-cancelled
// run addresses an id that's no longer present, so its update is a no-op
// (see updateAssistant) instead of resurrecting the cleared turn or --
// worse -- writing into whatever new turn a fast follow-up send() has
// since started. Dash sidesteps this entirely via direct DOM references
// (see the top-of-file comment); id-addressing is the array-of-turns
// equivalent of that same guarantee.
export interface Turn {
  id: number;
  user: string;
  assistant: AssistantMessage;
  // Rebuilt from sessionStorage after a reload: text only (no sources,
  // trace or images), rendered with .search-msg-restored.
  restored?: boolean;
}

// Dash parity (search_stream.js HISTORY_STORAGE_KEY / HISTORY_MAX_TURNS).
export const HISTORY_STORAGE_KEY = "compendium-search-history";
export const HISTORY_MAX_TURNS = 40;

interface StoredTurn {
  user: string;
  assistant: { text: string; done: boolean; status: string };
  restored: boolean;
}

function isWellFormedStored(t: unknown): t is StoredTurn {
  const o = t as StoredTurn | null;
  return (
    !!o &&
    typeof o.user === "string" &&
    o.user.length > 0 &&
    !!o.assistant &&
    typeof o.assistant.text === "string" &&
    o.assistant.text.length > 0
  );
}

// Every storage access is fail-open: a full/disabled sessionStorage must
// never break the live chat, only its persistence.
function loadStored(): { turns: StoredTurn[]; nextId: number } {
  try {
    const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return { turns: [], nextId: 0 };
    const parsed = JSON.parse(raw) as { turns?: unknown; nextId?: unknown };
    const turns = Array.isArray(parsed.turns) ? parsed.turns.filter(isWellFormedStored) : [];
    const nextId = typeof parsed.nextId === "number" ? parsed.nextId : 0;
    return { turns, nextId: Math.max(nextId, turns.length) };
  } catch {
    return { turns: [], nextId: 0 };
  }
}

function saveStored(turns: StoredTurn[], nextId: number): void {
  try {
    sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ turns, nextId }));
  } catch {
    // quota / disabled
  }
}

function removeStored(): void {
  try {
    sessionStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // disabled
  }
}

export interface UseAgentChat {
  turns: Turn[];
  busy: boolean;
  input: string;
  setInput: (value: string) => void;
  send: () => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

// Prior exchanges as the recency-weighted HistoryTurn window (see
// lib/chat-history.ts), oldest first. A turn contributes only when its
// answer finished cleanly with text (done, no error).
export function historyFromTurns(turns: Turn[]): HistoryTurn[] {
  const exchanges: Exchange[] = [];
  for (const t of turns) {
    if (!t.assistant.done || t.assistant.error || !t.assistant.text.trim() || !t.user.trim()) continue;
    exchanges.push({ user: t.user, assistant: t.assistant.text });
  }
  return buildHistory(exchanges);
}

export function useAgentChat(): UseAgentChat {
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const nextIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Finished turns mirrored to sessionStorage, and a generation bumped by
  // clear() so a straggling completion can't persist into a cleared chat.
  const storedRef = useRef<StoredTurn[]>([]);
  const generationRef = useRef(0);

  // Restore after mount (not in the initial state) so SSR and the first
  // client render agree.
  useEffect(() => {
    const { turns: stored, nextId } = loadStored();
    if (stored.length === 0 || turnsRef.current.length > 0) return;
    storedRef.current = stored;
    nextIdRef.current = Math.max(nextIdRef.current, nextId);
    setTurns(stored.map((t, i) => ({ id: i, user: t.user, assistant: { ...t.assistant }, restored: true })));
  }, []);

  // Id-addressed update: only the turn whose id matches is touched: every
  // other turn (completed answers from earlier sends, in particular)
  // passes through unchanged. If no turn in `turns` has this id -- clear()
  // ran since this turn started, or (impossible given nextIdRef only ever
  // increments) an id collision -- the .map is a no-op, generalizing the
  // original single-slot code's `a ? { ...a, ... } : a` "already null,
  // update is a no-op" guard from one nullable slot to an array of
  // addressable turns.
  const updateAssistant = useCallback(
    (id: number, updater: (a: AssistantMessage) => AssistantMessage) => {
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, assistant: updater(t.assistant) } : t)));
    },
    [],
  );

  const send = useCallback(async () => {
    const query = input.trim();
    if (!query || busy) return;
    setBusy(true);
    setInput("");
    const id = nextIdRef.current++;
    setTurns((ts) => [
      ...ts,
      { id, user: query, assistant: { text: "", done: false, status: "Thinking..." } },
    ]);

    // Buffer + rAF handle are local to this call, not hook-level refs, so
    // a straggling scheduled flush from THIS send can never read or write
    // a DIFFERENT turn's buffer -- each send() closes over its own. (The
    // original code's single hook-level bufferRef was safe only because
    // there was ever exactly one assistant slot to write into; that
    // invariant no longer holds once completed turns must persist.)
    let buffer = "";
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      updateAssistant(id, (a) => ({ ...a, text: buffer }));
    };
    const scheduleFlush = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(flush);
    };

    // Conversation continuity (port gap found 2026-09-28: Dash sent the
    // last 10 turns as `history`; the port sent only the query, so every
    // follow-up started cold). Snapshot the turns that exist BEFORE this
    // send -- `turnsRef` mirrors state so this callback need not re-create
    // on every turn -- and keep only finished, non-empty exchanges: the
    // backend's HistoryTurn rejects empty content, and an errored or
    // cancelled turn has no answer worth replaying.
    const history = historyFromTurns(turnsRef.current);

    const generation = generationRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamAgentQuery(
        query,
        {
          onStatus: (text) => updateAssistant(id, (a) => ({ ...a, status: text })),
          onToken: (text) => {
            buffer += text;
            scheduleFlush();
          },
          onComplete: (meta) => {
            updateAssistant(id, (a) => ({ ...a, text: buffer, done: true, status: "", meta }));
            if (generation === generationRef.current && buffer.trim()) {
              storedRef.current = [
                ...storedRef.current,
                { user: query, assistant: { text: buffer, done: true, status: "" }, restored: true },
              ].slice(-HISTORY_MAX_TURNS);
              saveStored(storedRef.current, nextIdRef.current);
            }
            // Task group C (C1, cluster-cite framing): port of
            // search_stream.js's `if (metadata && metadata.cluster_ids) {
            // highlightClusters(metadata.cluster_ids); }` (:831-832) --
            // fire-and-forget, since framing the graph is a canvas side
            // effect, not chat state. frameCitedClusters (lib/graph/
            // chat-interop.ts) already no-ops on an absent/empty
            // cluster_ids list and on a missing/not-yet-loaded graph
            // module; the .catch here is a backstop against any other
            // unexpected rejection, so this can never surface as an
            // unhandled rejection or bleed into this turn's error state --
            // chat must never crash while the canvas is loading or
            // missing.
            frameCitedClusters(meta.cluster_ids).catch(() => {});
          },
        },
        ctrl.signal,
        history,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateAssistant(id, (a) => ({ ...a, done: true, status: "", error: "Cancelled." }));
      } else {
        updateAssistant(id, (a) => ({ ...a, done: true, status: "", error: (err as Error).message }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, updateAssistant]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  // Port of search_stream.js's clearHistory() (P4), called from the
  // #search-clear-btn handler in attach(): resets the turn history and
  // empties #search-conversation, leaving the input text untouched --
  // Dash's clearHistory() only clears chatHistory/sessionStorage, never
  // touches the textarea. Sane deviation from Dash: Dash's clearHistory()
  // doesn't itself cancel an in-flight stream (the DOM it was writing into
  // just gets wiped out from under it by the click handler's own
  // `conv.innerHTML = ''`, a detached-node write that's harmless in raw
  // DOM). React has no equivalent "orphan the node" affordance -- an
  // in-flight send() would keep calling updateAssistant against state this
  // hook still owns after clear(), which would silently resurrect the
  // just-cleared turn as soon as the next token/complete event arrived (or,
  // with turns now addressed by id, could even bleed into a fresh turn
  // that started before the aborted run's own catch/finally fires -- see
  // Turn's doc comment). Cancelling first avoids that: abort() is
  // synchronous, so the in-flight send()'s catch/finally only ever runs
  // updateAssistant(id, ...) against a `turns` that no longer contains that
  // id (already emptied by this clear()), which is a no-op as established
  // above.
  const clear = useCallback(() => {
    abortRef.current?.abort();
    generationRef.current++;
    storedRef.current = [];
    removeStored();
    setTurns([]);
  }, []);

  return { turns, busy, input, setInput, send, cancel, clear };
}
