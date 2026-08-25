"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useSearchBarResize } from "@/hooks/useSearchBarResize";
import { useGraph } from "@/hooks/useGraph";
import { useSession } from "@/components/SessionProvider";
import { apiFetch } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import { hasGraphNode, frameSourceNode } from "@/lib/graph/chat-interop";

// GET /api/agent/internals response shape (backend/api/main.py's
// agent_internals): system prompt + AGENT_TOOLS verbatim, OpenAI
// function-tool shape. 403 for non-admin-context callers.
interface AgentToolParam {
  type?: string;
  description?: string;
}
interface AgentTool {
  function: {
    name: string;
    description: string;
    parameters?: { properties?: Record<string, AgentToolParam> };
  };
}
interface AgentInternals {
  system_prompt: string;
  tools: AgentTool[];
}

// Port of graph_canvas.py's _render_tool_definition(): one collapsible
// per tool -- summary is the function name (monospace), a description
// paragraph, then a `<pre>` of "  name: type — desc" param lines.
function renderToolDefinition(tool: AgentTool) {
  const func = tool.function;
  const params = func.parameters?.properties ?? {};
  const paramLines = Object.entries(params).map(
    ([name, spec]) => `  ${name}: ${spec.type ?? ""} — ${spec.description ?? ""}`
  );
  const paramText = paramLines.length > 0 ? paramLines.join("\n") : "  (none)";
  return (
    <details key={func.name}>
      <summary style={{ fontFamily: "monospace", fontSize: "0.72rem" }}>{func.name}</summary>
      <p style={{ fontSize: "0.7rem", color: "var(--text)", opacity: 0.7, margin: "2px 0 2px 12px" }}>
        {func.description}
      </p>
      <pre>{paramText}</pre>
    </details>
  );
}

// Ports graph_canvas.py's _render_search_bar() (~:112-238) verbatim on
// ids/classes -- the bottom-of-center search-bar overlay: #search-tab
// toggle, #search-bar (#search-resize-handle + #search-conversation + the
// input row), #agent-query-input + #agent-search-btn + the admin-gated
// #agent-internals-btn/#agent-internals-panel pair. Task 10 re-homes the
// old full-page <Chat /> here: streaming/state logic lives in
// hooks/useAgentChat.ts, collapse/expand + drag-resize in
// hooks/useSearchBarResize.ts (mirroring
// hooks/usePanelResize.ts's conventions), and this component owns only
// presentation, wired to app/styles/search-bar.css's already-ported classes.
//
// Deliberately NOT ported (out of scope for this slice -- see Dash's own
// comments on _render_search_bar and search_stream.js):
//   - sessionStorage persistence of chat history + the
//     restored-from-sessionStorage .search-msg-restored rendering it pairs
//     with (search_stream.js's restoreHistory()/pushHistoryTurn()). The
//     #search-clear-btn control itself IS ported below (clears in-memory
//     state); only the cross-reload persistence layer it also resets in
//     Dash is out of scope here.
//   - .chat-images-row -- a separate, not-yet-requested parity gap
//     (unrelated to the batch-03 chat<->graph interop below).
// Sources below (2026-07-28, chat parity fix 2) port makeSourceLink's
// plain .tag-pill.chat-source-pill markup + the "sources:" label
// (search_stream.js ~161-188, ~699-713). Diverges from Dash's
// makeSourceLink in one respect: the pill label stays hostname-only (no
// " · path-tail" suffix) per the batch brief -- matches what this
// component already showed before that fix, now just styled as a pill
// instead of a bullet.
//
// Task group C, C2 (P7 locate-glyph port, batch 03): closes the gap the
// paragraph above used to document as NOT ported. SourcePill (below) adds
// the .chat-source-locate-btn bullseye glyph (makeLocatePillGroup,
// search_stream.js :190-232) once the batch-03 chat<->graph interop
// (lib/graph/chat-interop.ts, wrapping lib/graph/d3-graph-vendor.js's
// module exports -- the Next equivalent of Dash's window.__d3* globals)
// makes hasGraphNode/frameSourceNode available. Tightened vs. Dash's own
// three-state gate (glyph absent / present-but-disabled / present-enabled):
// this port only has two -- the glyph renders iff node_id is present AND
// hasGraphNode(node_id) resolves true, degrading to the existing plain
// pill otherwise (absent sources_detail, absent node_id, hasNode false, or
// the graph module itself absent/not-yet-loaded all take that same plain-
// pill path, per task-C-brief.md).
function SourcePill({ url, nodeId }: { url: string; nodeId: string | null }) {
  // hasGraphNode is async (the vendor module loads via dynamic import(),
  // see chat-interop.ts's own header comment for why there's no
  // synchronous equivalent to Dash's window.__d3HasNode check) -- `known`
  // starts false so a pill always renders plain-first and upgrades to the
  // glyph once/if the check resolves true, rather than blocking the
  // sources row on the graph module loading.
  const [known, setKnown] = useState(false);
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    void hasGraphNode(nodeId).then((result) => {
      if (!cancelled) setKnown(result);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const hostnameLabel = (() => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url;
    }
  })();

  // 2026-08-24 (prod-mode sweep item 4): resolves node_id to the page's
  // real display title via useGraph()'s shared module-level graph cache
  // (hooks/useGraph.ts) -- the SAME cache GraphCanvas/HeaderCards/etc.
  // already share, so this adds no extra fetch and no vendor import.
  // `nodeById` reads a useSyncExternalStore snapshot, so this is
  // synchronous and reactive: while the graph hasn't loaded yet (or never
  // resolves this id) `node` is undefined and `label` below falls back to
  // hostnameLabel, then once/if the shared cache's payload includes this
  // node this component re-renders and picks up the title automatically --
  // same "hostname first, upgrade once resolved" shape as the `known`
  // glyph gate above. `node.label` is the page's real title (backend
  // graph_builder.py: `GraphNode(id=_slugify(title), label=title, ...)`),
  // NOT a de-slugified node_id -- that substitute is lossy/ugly and
  // deliberately not used here.
  const { nodeById } = useGraph();
  const node = nodeId ? nodeById(nodeId) : undefined;
  const label = node?.label ?? hostnameLabel;

  const pill = (
    <a href={url} target="_blank" rel="noreferrer" className="tag-pill chat-source-pill">
      {label}
    </a>
  );

  if (!nodeId || !known) return pill;

  return (
    <span className="chat-source-pill-group">
      {pill}
      <button
        type="button"
        className="chat-source-locate-btn"
        // "Locate on graph" -- deliberate divergence from Dash's own
        // "Locate on map" string (search_stream.js:220), user-directed
        // 2026-08-24 prod-mode sweep item 2 (this app has no map, only
        // the graph canvas the glyph actually frames a node in).
        title="Locate on graph"
        aria-label="Locate on graph"
        onClick={(e) => {
          // Port of makeLocatePillGroup's click handler (search_stream.js
          // :221-225) -- the button isn't nested inside the pill's <a>
          // here (unlike Dash's DOM, where the same guard is just
          // defensive), but preventDefault/stopPropagation are kept for
          // parity and as cheap insurance against this ever being
          // refactored into a nested layout.
          e.preventDefault();
          e.stopPropagation();
          void frameSourceNode(nodeId);
        }}
      >
        {"◎"}
      </button>
    </span>
  );
}

export default function SearchBar() {
  const { turns, busy, input, setInput, send, cancel, clear } = useAgentChat();
  const { barRef, handleRef, maximized, resizing, toggleMaximized, expand } = useSearchBarResize();

  // app.py's clientside callback predicate (:2807-2830): admin-context ==
  // real admin role OR an admin currently viewing as demo. Same gate for
  // the internals gear/panel (item 4) and the per-response trace block +
  // #search-bar's data-show-trace attribute (item 5). In dev-unauthed
  // (no session hydrated -> role null, actingAsDemo false) this resolves
  // false -- gear/trace stay hidden, matching the accepted dev-vs-Dash
  // difference noted in the batch brief (Dash's dev mode resolves an
  // admin dev-user; Next dev has no identity).
  const { role, actingAsDemo } = useSession();
  const adminContext = role === "admin" || actingAsDemo;

  const [internalsOpen, setInternalsOpen] = useState(false);
  const [internals, setInternals] = useState<AgentInternals | null>(null);
  const [internalsLoading, setInternalsLoading] = useState(false);
  const [internalsError, setInternalsError] = useState<string | null>(null);

  const loadInternals = useCallback(async () => {
    setInternalsLoading(true);
    setInternalsError(null);
    try {
      const res = await apiFetch("/api/agent/internals");
      if (!res.ok) {
        setInternalsError(
          res.status === 403 ? "Admin access required." : `Failed to load (${res.status}).`
        );
        return;
      }
      const data = (await res.json()) as AgentInternals;
      setInternals(data);
    } catch (err) {
      setInternalsError((err as Error).message || "Failed to load agent internals.");
    } finally {
      setInternalsLoading(false);
    }
  }, []);

  // search_stream.js's gear handler (:927-934) just toggles display --
  // the lazy-fetch-on-first-open is new here (Dash server-renders the
  // panel contents up front, so it has nothing to fetch). Only fires on
  // the open transition, and only when nothing has loaded yet (a prior
  // failure leaves `internals` null, so the next open retries).
  const toggleInternals = useCallback(() => {
    setInternalsOpen((open) => {
      const next = !open;
      if (next && internals === null && !internalsLoading) void loadInternals();
      return next;
    });
  }, [internals, internalsLoading, loadInternals]);

  // Defensive, not a Dash behavior to port: the panel's open state
  // (style.display) and its role gate (the `hidden` attribute) are
  // otherwise independent, and an inline `display` write beats the UA
  // `[hidden] { display: none }` rule -- app/styles/style.css's
  // `#graph-debug-overlay form[hidden]` comment documents this exact
  // CSS-specificity gotcha biting this codebase before (a hidden=True
  // "view demo" link stayed visible). Force-close on any transition out
  // of admin-context so the two states can never disagree.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- force-close only on the admin-context transition (see comment above), not derivable during render
    if (!adminContext) setInternalsOpen(false);
  }, [adminContext]);

  // search_stream.js's runStreamingQuery() validates FIRST -- `if (!query ||
  // isStreaming) return;` -- and only then auto-maximizes (`if (bar &&
  // !isMaximized(bar)) setMaximized(bar, true);`). So both an empty/
  // whitespace send AND a send while already streaming are no-ops in Dash
  // (busy is ALWAYS a no-op -- no expand, no send), not just the former.
  // Mirror that ordering exactly: busy short-circuits before the input is
  // even checked.
  const handleSend = useCallback(() => {
    if (busy || !input.trim()) return;
    expand();
    void send();
  }, [busy, input, expand, send]);

  const hasMessages = turns.length > 0;

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
        data-show-trace={adminContext ? "1" : "0"}
      >
        <div id="search-resize-handle" ref={handleRef} className="search-resize-handle" />

        <div
          id="search-conversation"
          className={"search-conversation" + (hasMessages ? " has-messages" : "")}
        >
          {/* Chat parity fix 1 (2026-07-28): map over turns (not userMsgs
              then a single assistant block) so every completed exchange
              renders interleaved -- user bubble immediately followed by
              its own assistant bubble, in send order -- matching Dash's
              DOM append order in runStreamingQuery (addUserMessage() then
              the assistantRow append, ~501-523 of search_stream.js).
              key={id} (not array index) since turns can only grow/reset,
              never reorder, and id is stable for a turn's whole lifetime. */}
          {turns.map(({ id, user, assistant }) => (
            <Fragment key={id}>
              <div className="search-msg-user">
                <span className="search-msg-user-text">{user}</span>
              </div>
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

                {/* Chat parity fix 2 (2026-07-28): Dash's styled source
                    pills, not a bullet list -- port of makeSourceLink +
                    the "sources:" label wrapper (search_stream.js
                    ~161-188 build the pill, ~699-713 build the row +
                    label). One pill per URL (not deduped by hostname),
                    same as Dash's loop over metadata.sources.
                    Task group C, C2: each pill additionally gets the P7
                    locate glyph (makeLocatePillGroup) when its
                    sources_detail entry carries a node_id -- see
                    SourcePill above. nodeIdByUrl mirrors Dash's own
                    url->node_id lookup built just above its loop
                    (search_stream.js ~716-720). */}
                {assistant.meta && assistant.meta.sources.length > 0 && (
                  <div className="chat-sources-row">
                    <span className="chat-sources-label">sources:</span>
                    {(() => {
                      const nodeIdByUrl = new Map<string, string | null>();
                      for (const d of assistant.meta.sources_detail ?? []) {
                        if (d.url) nodeIdByUrl.set(d.url, d.node_id);
                      }
                      return assistant.meta.sources.map((u) => (
                        <SourcePill key={u} url={u} nodeId={nodeIdByUrl.get(u) ?? null} />
                      ));
                    })()}
                  </div>
                )}

                {/* Guard on the DATA, not just adminContext: the backend
                    redacts tool_calls_made/total_cost_usd for any
                    non-admin get_role(user_id) -- which includes
                    acting-as-demo sessions, where adminContext is still
                    true here. An acting session therefore renders no
                    trace at all (same visible outcome as Dash). */}
                {adminContext && assistant.meta?.tool_calls_made && assistant.meta.tool_calls_made.length > 0 && (
                  <details>
                    <summary className="search-trace-summary">
                      Trace: {assistant.meta.iterations} iter, {assistant.meta.tool_calls_made.length} tools, $
                      {(assistant.meta.total_cost_usd ?? 0).toFixed(4)} -- {assistant.meta.model}
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
            </Fragment>
          ))}
        </div>

        <div className="search-bar-input-row">
          <textarea
            id="agent-query-input"
            value={input}
            placeholder="Ask about your browsing history..."
            onChange={(e) => {
              setInput(e.target.value);
              // Port of search_keyboard.js:34-38's auto-grow: reset to the
              // 26px single-line floor first, then grow to scrollHeight
              // clamped to 80px (~4 rows). Direct style mutation (no React
              // state) -- matches the source's direct DOM write on the
              // 'input' listener. Faithful quirk KEPT: this only runs on a
              // real user input event, so useAgentChat's programmatic
              // setInput("") after send does NOT reset the height (Dash's
              // listener is 'input', which a controlled-value React update
              // never dispatches either).
              const ta = e.target;
              ta.style.height = "26px";
              ta.style.height = `${Math.max(26, Math.min(ta.scrollHeight, 80))}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends (Shift+Enter for a newline) -- this is PARITY,
              // not an addition: Dash's assets/search_keyboard.js (:22-31)
              // wires the identical behavior onto #agent-query-input in the
              // capture phase (so it fires before React's synthetic
              // handlers), calling window.__searchStreamQuery() on a bare
              // Enter. This handler is the port of that wiring.
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
          {/* Clear-chat (P4): NOT admin-gated in Dash (no hidden=True,
              unlike the gear button below) -- every viewer gets it.
              graph_canvas.py's clearHistory() only resets chatHistory +
              empties #search-conversation; it never touches the textarea. */}
          <button
            id="search-clear-btn"
            type="button"
            className="search-clear-btn"
            title="Clear conversation"
            aria-label="Clear conversation"
            onClick={clear}
          >
            {"↺"}
          </button>
          {/* Admin-gated in Dash (hidden=True until a clientside callback
              unhides it for admin-context viewers, app.py:2807-2830). */}
          <button
            id="agent-internals-btn"
            type="button"
            className="search-gear-btn"
            title="Agent Internals"
            aria-label="Agent Internals"
            hidden={!adminContext}
            onClick={toggleInternals}
          >
            {"⚙"}
          </button>
        </div>
      </div>

      {/* Port of graph_canvas.py's Agent Internals overlay (:190-236) --
          sibling of #search-bar (not nested in the input row), toggled by
          the gear above and closed by #agent-internals-close. Same
          hidden={!adminContext}/style.display split as Dash: `hidden`
          gates on role, `style.display` gates on open/closed. */}
      <div
        id="agent-internals-panel"
        className="internals-panel"
        style={{ display: internalsOpen ? "block" : "none" }}
        hidden={!adminContext}
      >
        <div className="internals-panel-inner">
          <div className="internals-header">
            <span
              style={{
                fontWeight: 600,
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Agent Internals
            </span>
            <button
              id="agent-internals-close"
              type="button"
              className="internals-close-btn"
              aria-label="Close"
              onClick={() => setInternalsOpen(false)}
            >
              {"✕"}
            </button>
          </div>

          {internalsLoading && (
            <div style={{ fontSize: "0.7rem", color: "var(--text)", opacity: 0.7 }}>Loading…</div>
          )}
          {internalsError && (
            <div role="alert" style={{ fontSize: "0.7rem", color: "var(--text)", opacity: 0.8 }}>
              {internalsError}
            </div>
          )}

          <details style={{ marginTop: 6 }}>
            <summary>System Prompt</summary>
            <pre>{internals?.system_prompt ?? ""}</pre>
          </details>
          <details style={{ marginTop: 6 }}>
            <summary>Tools ({internals?.tools.length ?? 0})</summary>
            {internals?.tools.map((t) => renderToolDefinition(t))}
          </details>
        </div>
      </div>
    </div>
  );
}
