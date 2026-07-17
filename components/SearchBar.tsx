"use client";

import { useCallback } from "react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useSearchBarResize } from "@/hooks/useSearchBarResize";
import { renderMarkdown } from "@/lib/markdown";

// Ports graph_canvas.py's _render_search_bar() (~:112-238) verbatim on
// ids/classes -- the bottom-of-center search-bar overlay: #search-tab
// toggle, #search-bar (#search-resize-handle + #search-conversation + the
// input row), #agent-query-input + #agent-search-btn + the admin-gated
// #agent-internals-btn placeholder. Task 10 re-homes the old full-page
// <Chat /> here: streaming/state logic lives in hooks/useAgentChat.ts,
// collapse/expand + drag-resize in hooks/useSearchBarResize.ts (mirroring
// hooks/usePanelResize.ts's conventions), and this component owns only
// presentation, wired to app/styles/search-bar.css's already-ported classes.
//
// Deliberately NOT ported (out of scope for this slice -- see Dash's own
// comments on _render_search_bar and search_stream.js):
//   - #search-clear-btn (P4 clear-chat -- needs sessionStorage persistence
//     this migration hasn't built yet) and the restored-from-sessionStorage
//     .search-msg-restored rendering it pairs with.
//   - #agent-internals-panel content (admin-gated by a role context this
//     app doesn't resolve yet) -- the gear button itself is rendered
//     `hidden`, matching Dash's own default (hidden=True until a
//     clientside callback unhides it for admin-context viewers), so there's
//     nothing behind it to build yet.
//   - .chat-source-pill / .chat-source-locate-btn (P7 locate-on-graph
//     glyph) and .chat-images-row -- the pre-existing Chat.tsx never
//     rendered these either; sources stay the plain-link list it already
//     had (now styled via the ported .search-msg-sources list class).
export default function SearchBar() {
  const { userMsgs, assistant, busy, input, setInput, send, cancel } = useAgentChat();
  const { barRef, handleRef, maximized, resizing, toggleMaximized, expand } = useSearchBarResize();

  // search_stream.js's runStreamingQuery() validates FIRST -- `if (!query ||
  // isStreaming) return;` -- and only then auto-maximizes (`if (bar &&
  // !isMaximized(bar)) setMaximized(bar, true);`). So an empty/whitespace
  // send while idle is a no-op in Dash, not an expand. Mirror that: bail
  // before expand() when there's nothing to send and we're not already busy
  // (a non-empty in-flight send still expands/sends as before).
  const handleSend = useCallback(() => {
    if (!busy && !input.trim()) return;
    expand();
    void send();
  }, [busy, input, expand, send]);

  const hasMessages = userMsgs.length > 0 || assistant != null;

  return (
    <div className="search-bar-wrapper">
      <button
        id="search-tab"
        type="button"
        className="search-tab"
        aria-expanded={maximized}
        onClick={toggleMaximized}
      >
        Compendium Search <span id="search-tab-arrow">{maximized ? "▼" : "▲"}</span>
      </button>

      <div
        id="search-bar"
        ref={barRef}
        className={
          "search-bar" + (maximized ? "" : " minimized") + (resizing ? " resizing" : "")
        }
      >
        <div id="search-resize-handle" ref={handleRef} className="search-resize-handle" />

        <div
          id="search-conversation"
          className={"search-conversation" + (hasMessages ? " has-messages" : "")}
        >
          {userMsgs.map((m, i) => (
            <div key={i} className="search-msg-user">
              <span className="search-msg-user-text">{m}</span>
            </div>
          ))}

          {assistant && (
            <div className="search-msg-assistant">
              {assistant.status && (
                <div className="search-msg-status">
                  <span className="search-spinner" />
                  {assistant.status}
                </div>
              )}
              {assistant.error ? (
                <div role="alert" className="search-msg-error">
                  {assistant.error}
                </div>
              ) : assistant.done ? (
                <div
                  className="search-msg-assistant-text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(assistant.text) }}
                />
              ) : (
                <div className="search-msg-assistant-text" style={{ whiteSpace: "pre-wrap" }}>
                  {assistant.text}
                </div>
              )}

              {assistant.meta && assistant.meta.sources.length > 0 && (
                <ul className="search-msg-sources">
                  {assistant.meta.sources.map((u) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer">
                        {(() => {
                          try {
                            return new URL(u).hostname.replace("www.", "");
                          } catch {
                            return u;
                          }
                        })()}
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {assistant.meta && assistant.meta.tool_calls_made.length > 0 && (
                <details>
                  <summary className="search-trace-summary">
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
        </div>

        <div className="search-bar-input-row">
          <textarea
            id="agent-query-input"
            value={input}
            placeholder="Ask about your browsing history..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends (Shift+Enter for a newline) -- this is PARITY,
              // not an addition: Dash's assets/search_keyboard.js (:22-31)
              // wires the identical behavior onto #agent-query-input in the
              // capture phase (so it fires before React's synthetic
              // handlers), calling window.__searchStreamQuery() on a bare
              // Enter. This handler is the port of that wiring.
              //
              // KNOWN UNPORTED GAP: search_keyboard.js:34-38 also auto-grows
              // the textarea 26px -> 80px on input as the query gets
              // longer. Not implemented here -- flagged for the batch
              // acceptance gate's fix-or-defer triage, not addressed in
              // this pass.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            id="agent-search-btn"
            type="button"
            className={"search-icon-btn" + (busy ? " is-stop" : "")}
            title={busy ? "Stop" : "Search"}
            aria-label={busy ? "Stop" : "Search"}
            onClick={busy ? cancel : handleSend}
          />
          {/* Admin-gated in Dash (hidden=True until a clientside callback
              unhides it for admin-context viewers) -- rendered hidden here
              too since there's no role context to gate on yet. */}
          <button
            id="agent-internals-btn"
            type="button"
            className="search-gear-btn"
            title="Agent Internals"
            aria-label="Agent Internals"
            hidden
          >
            {"⚙"}
          </button>
        </div>
      </div>
    </div>
  );
}
