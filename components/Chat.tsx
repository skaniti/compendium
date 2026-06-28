"use client";

import { useCallback, useRef, useState } from "react";
import { streamAgentQuery } from "@/lib/agent-stream";
import { renderMarkdown } from "@/lib/markdown";
import type { CompleteEvent } from "@/lib/types";

interface Assistant {
  text: string;          // streamed raw text (mid-flight)
  done: boolean;         // true after `complete` -> render markdown
  status: string;        // transient label
  meta?: CompleteEvent;  // sources + trace
  error?: string;
}

export default function Chat() {
  const [userMsgs, setUserMsgs] = useState<string[]>([]);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
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

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui" }}>
      {userMsgs.map((m, i) => (
        <div key={i} style={{ textAlign: "right", margin: "8px 0" }}>{m}</div>
      ))}

      {assistant && (
        <div style={{ margin: "8px 0" }}>
          {assistant.status && <div style={{ opacity: 0.6 }}>{assistant.status}</div>}
          {assistant.error ? (
            <div role="alert" style={{ color: "crimson" }}>{assistant.error}</div>
          ) : assistant.done ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(assistant.text) }} />
          ) : (
            <div style={{ whiteSpace: "pre-wrap" }}>{assistant.text}</div>
          )}

          {assistant.meta && assistant.meta.sources.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
              <span style={{ opacity: 0.6, fontSize: 12 }}>sources:</span>
              {assistant.meta.sources.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  {(() => { try { return new URL(u).hostname.replace("www.", ""); } catch { return u; } })()}
                </a>
              ))}
            </div>
          )}

          {assistant.meta && assistant.meta.tool_calls_made.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary>
                Trace: {assistant.meta.iterations} iter, {assistant.meta.tool_calls_made.length} tools, $
                {assistant.meta.total_cost_usd.toFixed(4)} -- {assistant.meta.model}
              </summary>
              {assistant.meta.tool_calls_made.map((tc, i) => (
                <div key={i} style={{ marginLeft: 10, fontSize: 12 }}>
                  <code>{tc.tool}</code>
                  <pre style={{ whiteSpace: "pre-wrap" }}>args: {JSON.stringify(tc.arguments)}</pre>
                  <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>{tc.result_preview}</pre>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={input}
          placeholder="Ask the compendium..."
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          style={{ flex: 1, padding: 8 }}
        />
        {busy ? (
          <button onClick={cancel}>Stop</button>
        ) : (
          <button onClick={send} aria-label="Send">Send</button>
        )}
      </div>
    </main>
  );
}
