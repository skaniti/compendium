"use client";

import { useCallback, useRef, useState } from "react";
import { streamAgentQuery } from "@/lib/agent-stream";
import type { CompleteEvent } from "@/lib/types";

// Extracted verbatim (state/streaming logic only -- no JSX) from the old
// full-page components/Chat.tsx as part of the search-bar re-home (Task 10).
// Presentation now lives in components/SearchBar.tsx; this hook is the
// single source of truth for the conversation state both the message list
// and the input row read/drive.

export interface AssistantMessage {
  text: string; // streamed raw text (mid-flight)
  done: boolean; // true after `complete` -> render markdown
  status: string; // transient label
  meta?: CompleteEvent; // sources + trace
  error?: string;
}

export interface UseAgentChat {
  userMsgs: string[];
  assistant: AssistantMessage | null;
  busy: boolean;
  input: string;
  setInput: (value: string) => void;
  send: () => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

export function useAgentChat(): UseAgentChat {
  const [userMsgs, setUserMsgs] = useState<string[]>([]);
  const [assistant, setAssistant] = useState<AssistantMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const bufferRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;
    setAssistant((a) => (a ? { ...a, text: bufferRef.current } : a));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const send = useCallback(async () => {
    const query = input.trim();
    if (!query || busy) return;
    setBusy(true);
    setInput("");
    setUserMsgs((m) => [...m, query]);
    bufferRef.current = "";
    setAssistant({ text: "", done: false, status: "Thinking..." });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamAgentQuery(
        query,
        {
          onStatus: (text) => setAssistant((a) => (a ? { ...a, status: text } : a)),
          onToken: (text) => { bufferRef.current += text; scheduleFlush(); },
          onComplete: (meta) =>
            setAssistant((a) => (a ? { ...a, text: bufferRef.current, done: true, status: "", meta } : a)),
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setAssistant((a) => (a ? { ...a, done: true, status: "", error: "Cancelled." } : a));
      } else {
        setAssistant((a) => (a ? { ...a, done: true, status: "", error: (err as Error).message } : a));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, scheduleFlush]);

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
  // in-flight send() would keep calling setAssistant/setUserMsgs against
  // state this hook still owns after clear(), which would silently
  // resurrect the just-cleared turn as soon as the next token/complete
  // event arrived. Cancelling first avoids that: abort() is synchronous,
  // so the in-flight send()'s catch/finally only ever sees assistant
  // already null (its `a ? ... : a` update pattern is already a no-op
  // once that happens).
  const clear = useCallback(() => {
    abortRef.current?.abort();
    setUserMsgs([]);
    setAssistant(null);
  }, []);

  return { userMsgs, assistant, busy, input, setInput, send, cancel, clear };
}
