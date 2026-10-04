import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchBar, { TRACE_PREVIEW_MAX_CHARS, ChatImagesRow } from "./SearchBar";
import * as stream from "@/lib/agent-stream";
import * as SessionProviderModule from "@/components/SessionProvider";
import * as apiModule from "@/lib/api";
import * as chatInterop from "@/lib/graph/chat-interop";
import { __resetGraphCacheForTest } from "@/hooks/useGraph";
import type { SessionRole } from "@/components/SessionProvider";
import type { GraphPayload } from "@/lib/types";

// Ported from the old full-page Chat.test.tsx (Task 10: re-home into the
// search-bar overlay -- see graph_canvas.py's _render_search_bar()). Selector
// changes vs. the original: the send control is now the single
// #agent-search-btn icon button (aria-label "Search", matching Dash's
// title="Search" -- exact-string match so it doesn't also catch the
// #search-tab button, whose accessible name is "Compendium Search ...").
//
// SearchBar now reads useSession() (items 4/5's admin-context gate), so
// every render needs a mocked session -- same convention
// SessionProvider.test.tsx uses for ThemeProviderModule/StarfieldProviderModule
// (mock the hook directly rather than standing up a real SessionProvider,
// which needs its own fetch/DOM setup unrelated to what these tests
// exercise). Defaults to signed-out/non-admin; admin-context tests call
// mockSession({ role: "admin" }) explicitly before rendering; an admin
// acting as demo is NOT admin context (2026-10-04).
function mockSession(overrides: { role?: SessionRole | null; actingAsDemo?: boolean } = {}) {
  vi.spyOn(SessionProviderModule, "useSession").mockReturnValue({
    role: overrides.role ?? null,
    account: "test@example.com",
    actingAsDemo: overrides.actingAsDemo ?? false,
    adminOriginEmail: undefined,
    showNoise: false,
    status: "hydrated",
    refresh: vi.fn(),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Minimal GraphNode builder for item 4's title-resolution tests, matching
// GraphCanvas.test.tsx's own `node()` fixture convention.
function node(id: string, label: string): GraphPayload["nodes"][number] {
  return {
    id,
    label,
    level: 1,
    kind: "singleton",
    visit_count: 1,
    parent_id: null,
    children_ids: [],
    capture_ids: [],
    page_urls: [],
    first_visited_at: null,
  };
}

describe("SearchBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // useGraph()'s module-level graph cache (hooks/useGraph.ts) is a
    // shared singleton across every test in this file -- without this
    // reset, a payload one of item 4's title-resolution tests mocks
    // fetchGraph() to resolve with would leak into later tests (including
    // the pre-existing "example.com" hostname assertions above).
    __resetGraphCacheForTest();
    mockSession();
    sessionStorage.clear();
  });

  it("renders a restored turn text-only with .search-msg-restored and no sources row", async () => {
    sessionStorage.setItem(
      "compendium-search-history",
      JSON.stringify({
        nextId: 1,
        turns: [{ user: "old q", assistant: { text: "**old** a", done: true, status: "" }, restored: true }],
      }),
    );
    const { container } = render(<SearchBar />);
    await waitFor(() => expect(container.querySelector(".search-msg-restored")).toBeInTheDocument());
    expect(container.querySelector(".search-msg-user-text")).toHaveTextContent("old q");
    expect(container.querySelector(".search-msg-restored strong")).toHaveTextContent("old");
    expect(container.querySelector(".chat-sources-row")).not.toBeInTheDocument();
    expect(container.querySelector(".search-msg-restored details")).not.toBeInTheDocument();
  });

  it("renders streamed tokens then the final markdown + sources", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onStatus?.("thinking");
      h.onToken?.("**hello**");
      h.onComplete?.({
        type: "complete", sources: ["https://example.com/x"], cluster_ids: [],
        images: [], tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    render(<SearchBar />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument()); // markdown-rendered bold

    // Sources render as Dash's styled pills (search_stream.js's
    // makeSourceLink + the "sources:" label built in runStreamingQuery
    // ~680-713), not a bullet list -- see item 2/fix 2's comment block
    // above SearchBar's sources markup.
    expect(screen.getByText("sources:")).toBeInTheDocument();
    const sourcePill = screen.getByRole("link", { name: "example.com" });
    expect(sourcePill).toHaveClass("tag-pill", "chat-source-pill");
    expect(sourcePill).toHaveAttribute("href", "https://example.com/x");
    expect(sourcePill).toHaveAttribute("target", "_blank");
    expect(document.querySelector(".search-msg-sources")).not.toBeInTheDocument(); // old <ul> markup gone
  });

  it("renders one source pill per URL even when hostnames repeat", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete",
        sources: ["https://example.com/a", "https://example.com/b"],
        cluster_ids: [], images: [], tool_calls_made: [], total_cost_usd: 0,
        iterations: 1, model: "m",
      });
    });
    render(<SearchBar />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "example.com" })).toHaveLength(2)
    );
    const [first, second] = screen.getAllByRole("link", { name: "example.com" });
    expect(first).toHaveAttribute("href", "https://example.com/a");
    expect(second).toHaveAttribute("href", "https://example.com/b");
  });

  // Task group C, C2 (P7 locate-glyph port, closes the gap this
  // component's own doc comment used to document as NOT ported). Port of
  // search_stream.js's makeLocatePillGroup (:190-232) gate, but tightened
  // per task-C-brief.md: the glyph itself renders iff node_id is present
  // AND hasGraphNode(node_id) resolves true -- no Dash-style "present but
  // disabled" third state. hasGraphNode/frameSourceNode
  // (lib/graph/chat-interop.ts) are mocked at this boundary; their own
  // absent-module/rejection-swallowing contracts are covered directly in
  // lib/graph/chat-interop.test.ts.
  describe("source pill locate glyph (C2)", () => {
    function sendWithSources(sourcesDetail?: Array<{ url: string; page_id: number | null; node_id: string | null }>) {
      return vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete",
          sources: ["https://example.com/x"],
          sources_detail: sourcesDetail,
          cluster_ids: [],
          images: [],
          tool_calls_made: [],
          total_cost_usd: 0,
          iterations: 1,
          model: "m",
        });
      });
    }

    it("renders the locate glyph when node_id is present and hasGraphNode resolves true, and clicking it frames that node", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockImplementation(async (nodeId) => nodeId === "node-x");
      const frameSpy = vi.spyOn(chatInterop, "frameSourceNode").mockResolvedValue(undefined);
      sendWithSources([{ url: "https://example.com/x", page_id: null, node_id: "node-x" }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      const glyph = await screen.findByRole("button", { name: "Locate on graph" });
      expect(glyph.closest(".chat-source-pill-group")).not.toBeNull();
      expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument();

      await userEvent.click(glyph);
      expect(frameSpy).toHaveBeenCalledWith("node-x");
    });

    it("renders a plain pill (no glyph) when sources_detail is entirely absent (redacted/early-exit shape)", async () => {
      const hasNodeSpy = vi.spyOn(chatInterop, "hasGraphNode");
      sendWithSources(undefined);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Locate on graph" })).not.toBeInTheDocument();
      expect(hasNodeSpy).not.toHaveBeenCalled(); // no node_id to even check
    });

    it("renders a plain pill (no glyph) when the source's sources_detail entry has node_id: null", async () => {
      const hasNodeSpy = vi.spyOn(chatInterop, "hasGraphNode");
      sendWithSources([{ url: "https://example.com/x", page_id: 7, node_id: null }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Locate on graph" })).not.toBeInTheDocument();
      expect(hasNodeSpy).not.toHaveBeenCalled();
    });

    it("renders a plain pill (no glyph) when hasGraphNode resolves false -- the node isn't on the current graph (also covers the absent/not-yet-loaded graph module, since hasGraphNode degrades to false for that case too)", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockResolvedValue(false);
      const frameSpy = vi.spyOn(chatInterop, "frameSourceNode");
      sendWithSources([{ url: "https://example.com/x", page_id: null, node_id: "node-not-on-map" }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
      await waitFor(() => expect(chatInterop.hasGraphNode).toHaveBeenCalledWith("node-not-on-map"));
      expect(screen.queryByRole("button", { name: "Locate on graph" })).not.toBeInTheDocument();
      expect(frameSpy).not.toHaveBeenCalled();
    });
  });

  // 2026-08-24 (prod-mode sweep item 4): the pill label resolves to the
  // page's real display title (useGraph()'s shared graph cache,
  // GraphNode.label) instead of staying hostname-only forever -- the bug
  // this closes: two sources on the same host (e.g. two Wikipedia
  // articles) rendered as two identical, indistinguishable "en.wikipedia.
  // org" pills. hasGraphNode/frameSourceNode (the separate locate-glyph
  // gate, covered above) are mocked the same way as the C2 block; this
  // block additionally mocks fetchGraph (hooks/useGraph.ts's own fetcher)
  // to control what the shared graph cache resolves with.
  describe("source pill title resolution (item 4)", () => {
    function sendWithSources(sourcesDetail?: Array<{ url: string; page_id: number | null; node_id: string | null }>) {
      return vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete",
          sources: sourcesDetail?.map((s) => s.url) ?? ["https://example.com/x"],
          sources_detail: sourcesDetail,
          cluster_ids: [],
          images: [],
          tool_calls_made: [],
          total_cost_usd: 0,
          iterations: 1,
          model: "m",
        });
      });
    }

    it("upgrades the pill label to the node's real title once the graph payload resolves", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockResolvedValue(false); // locate-glyph gate irrelevant here
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue({
        nodes: [node("node-x", "Arduino - Wikipedia")],
        links: [],
        clusters: [],
        super_clusters: [],
        groups: [],
      });
      sendWithSources([{ url: "https://en.wikipedia.org/wiki/Arduino", page_id: null, node_id: "node-x" }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "Arduino - Wikipedia" })).toBeInTheDocument());
      expect(screen.queryByRole("link", { name: "en.wikipedia.org" })).not.toBeInTheDocument();
    });

    it("two sources on the same hostname render distinct titles instead of two identical hostname pills", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockResolvedValue(false);
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue({
        nodes: [node("node-a", "Arduino - Wikipedia"), node("node-b", "Breadboard - Wikipedia")],
        links: [],
        clusters: [],
        super_clusters: [],
        groups: [],
      });
      sendWithSources([
        { url: "https://en.wikipedia.org/wiki/Arduino", page_id: null, node_id: "node-a" },
        { url: "https://en.wikipedia.org/wiki/Breadboard", page_id: null, node_id: "node-b" },
      ]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "Arduino - Wikipedia" })).toBeInTheDocument());
      expect(screen.getByRole("link", { name: "Breadboard - Wikipedia" })).toBeInTheDocument();
      expect(screen.queryAllByRole("link", { name: "en.wikipedia.org" })).toHaveLength(0);
    });

    it("falls back to the hostname when node_id doesn't match any node in the loaded graph (unresolvable)", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockResolvedValue(false);
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue({
        nodes: [node("some-other-node", "Unrelated Page - Wikipedia")],
        links: [],
        clusters: [],
        super_clusters: [],
        groups: [],
      });
      sendWithSources([{ url: "https://example.com/x", page_id: null, node_id: "node-not-in-graph" }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      // Wait for the graph fetch to have settled (so this isn't just
      // catching the "not loaded yet" window) before asserting the
      // negative -- the mocked payload has no node matching this id at all.
      await waitFor(() => expect(apiModule.fetchGraph).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
    });

    it("shows the hostname synchronously before the graph payload has loaded (render hostname first, upgrade once resolved)", async () => {
      vi.spyOn(chatInterop, "hasGraphNode").mockResolvedValue(false);
      // A fetchGraph promise that never resolves during this test --
      // stands in for "graph not loaded yet" without racing a real timer.
      vi.spyOn(apiModule, "fetchGraph").mockReturnValue(new Promise<GraphPayload>(() => {}));
      sendWithSources([{ url: "https://example.com/x", page_id: null, node_id: "node-x" }]);

      render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
    });
  });

  // Transcript persistence (chat parity fix 1): a completed answer must
  // stay on screen when a new turn starts, interleaved in send order --
  // see hooks/useAgentChat.ts's `turns` restructure and Dash's
  // addUserMessage()/per-run assistantRow reference in search_stream.js,
  // which never shares one "current answer" slot across turns.
  it("keeps every completed answer visible across sequential sends, interleaved in order", async () => {
    vi.spyOn(stream, "streamAgentQuery")
      .mockImplementationOnce(async (_q, h) => {
        h.onToken?.("first answer");
        h.onComplete?.({
          type: "complete", sources: [], cluster_ids: [], images: [],
          tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
        });
      })
      .mockImplementationOnce(async (_q, h) => {
        h.onToken?.("second answer");
        h.onComplete?.({
          type: "complete", sources: [], cluster_ids: [], images: [],
          tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
        });
      });
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/ask/i);

    await userEvent.type(input, "first query");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("first answer")).toBeInTheDocument());

    await userEvent.type(input, "second query");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("second answer")).toBeInTheDocument());

    // The bug being fixed: the second send used to REPLACE the first
    // answer on screen. Both must be present now.
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("first query")).toBeInTheDocument();
    expect(screen.getByText("second query")).toBeInTheDocument();

    // Interleaved, not grouped by type: user1, assistant1, user2,
    // assistant2 -- matches Dash's DOM append order in runStreamingQuery.
    const conv = document.querySelector("#search-conversation")!;
    const rowClasses = Array.from(conv.children).map((el) => el.className);
    expect(rowClasses).toEqual([
      "search-msg-user",
      "search-msg-assistant",
      "search-msg-user",
      "search-msg-assistant",
    ]);
  });

  it("survives a redacted complete event (no tool_calls_made) in an acting session", async () => {
    // The backend's _redact_complete_event strips tool_calls_made and
    // total_cost_usd whenever get_role(user_id) != "admin" -- and while
    // acting-as-demo, user_id IS the demo row, so acting sessions always
    // receive the redacted shape even though the client-side adminContext
    // (role === "admin" || actingAsDemo) still renders the admin chrome.
    // Regression: 2026-07-28, chat-send while acting crashed on
    // meta.tool_calls_made.length. Correct outcome: answer renders, no
    // trace block (matches Dash, whose acting sessions never receive
    // trace data either).
    mockSession({ role: "demo", actingAsDemo: true });
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("hi there");
      h.onComplete?.({ type: "complete", sources: [], iterations: 1, model: "m" });
    });
    render(<SearchBar />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
    expect(screen.queryByText(/Trace:/)).not.toBeInTheDocument();
  });

  it("shows an error when the stream rejects", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockRejectedValue(new Error("boom 500"));
    render(<SearchBar />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText(/boom 500/)).toBeInTheDocument());
  });

  it("starts minimized and toggles via the #search-tab button", async () => {
    const { container } = render(<SearchBar />);
    const bar = container.querySelector("#search-bar")!;
    const tab = screen.getByRole("button", { name: /compendium search/i });

    expect(bar).toHaveClass("minimized");
    expect(tab).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(tab);
    expect(bar).not.toHaveClass("minimized");
    expect(tab).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(tab);
    expect(bar).toHaveClass("minimized");
    expect(tab).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the empty conversation in the flex column when maximized so the input row stays at the bottom", async () => {
    const { container } = render(<SearchBar />);
    await userEvent.click(screen.getByRole("button", { name: /compendium search/i }));

    const bar = container.querySelector("#search-bar")!;
    const conv = container.querySelector("#search-conversation")!;
    expect(bar).not.toHaveClass("minimized");
    expect(conv).toBeInTheDocument();
    expect(conv).not.toHaveClass("has-messages");

    // jsdom does not load the stylesheet, so assert on the CSS source: the
    // base rule must not hide the empty conversation (that removed the flex
    // spacer and let the input row rise to the top); only the minimized bar
    // may hide it.
    const css = readFileSync(join(__dirname, "../app/styles/search-bar.css"), "utf8");
    const base = css.match(/\n\.search-conversation\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toMatch(/flex:\s*1/);
    expect(base).not.toMatch(/display:\s*none/);
    expect(css).not.toMatch(/\.search-conversation\.has-messages\s*\{[^}]*display/);
    expect(css).toMatch(/\.search-bar\.minimized \.search-conversation\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("auto-expands the bar when a query is sent while minimized", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: [], cluster_ids: [], images: [],
        tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    const { container } = render(<SearchBar />);
    const bar = container.querySelector("#search-bar")!;
    expect(bar).toHaveClass("minimized");

    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(bar).not.toHaveClass("minimized"));
  });

  it("does not expand or send when the search button is clicked with an empty input while minimized", async () => {
    const streamSpy = vi.spyOn(stream, "streamAgentQuery");
    const { container } = render(<SearchBar />);
    const bar = container.querySelector("#search-bar")!;
    expect(bar).toHaveClass("minimized");

    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(bar).toHaveClass("minimized");
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("does not expand or send when the input is whitespace-only while minimized", async () => {
    const streamSpy = vi.spyOn(stream, "streamAgentQuery");
    const { container } = render(<SearchBar />);
    const bar = container.querySelector("#search-bar")!;
    expect(bar).toHaveClass("minimized");

    await userEvent.type(screen.getByPlaceholderText(/ask/i), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(bar).toHaveClass("minimized");
    expect(streamSpy).not.toHaveBeenCalled();
  });

  // Busy-guard parity (item 1): Dash's runStreamingQuery validates
  // `if (!query || isStreaming) return;` -- busy is ALWAYS a no-op, not
  // just "no-op when there's also nothing to send". Enter is the exercised
  // path here (not the search button, whose onClick swaps to `cancel`
  // while busy) since search_keyboard.js wires Enter straight to
  // handleSend/runStreamingQuery regardless of streaming state.
  it("busy is always a no-op: Enter mid-stream with the bar re-collapsed does not expand or re-send", async () => {
    let resolveStream!: () => void;
    const streamSpy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(
      () => new Promise<void>((resolve) => { resolveStream = resolve; })
    );
    const { container } = render(<SearchBar />);
    const bar = container.querySelector("#search-bar")!;
    const tab = screen.getByRole("button", { name: /compendium search/i });
    const input = screen.getByPlaceholderText(/ask/i);

    await userEvent.type(input, "first query");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(bar).not.toHaveClass("minimized"));
    expect(streamSpy).toHaveBeenCalledTimes(1);

    // Manually re-minimize while the stream is still in flight (busy=true).
    await userEvent.click(tab);
    expect(bar).toHaveClass("minimized");

    // Enter while busy: must not expand and must not call streamAgentQuery
    // a second time.
    await userEvent.type(input, "second query");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(bar).toHaveClass("minimized");
    expect(streamSpy).toHaveBeenCalledTimes(1);

    resolveStream();
  });

  // Textarea auto-grow (item 2): port of search_keyboard.js:34-38. jsdom
  // never computes real layout, so scrollHeight is stubbed per-test to
  // exercise both clamp edges.
  it("auto-grows the textarea on input, clamped to the 26px floor", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 10 });

    fireEvent.change(input, { target: { value: "hi" } });

    expect(input.style.height).toBe("26px");
  });

  it("auto-grows the textarea on input, clamped to the 80px ceiling", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 500 });

    fireEvent.change(input, { target: { value: "a much longer multi-line query" } });

    expect(input.style.height).toBe("80px");
  });

  it("does not reset textarea height on the programmatic input clear after send (Dash's input-event-only quirk)", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: [], cluster_ids: [], images: [],
        tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 60 });
    fireEvent.change(input, { target: { value: "hi" } });
    expect(input.style.height).toBe("60px");

    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(input).toHaveValue(""));

    // useAgentChat's setInput("") is a React state write, not a DOM
    // 'input' event -- the height must stay wherever the last real
    // keystroke left it.
    expect(input.style.height).toBe("60px");
  });

  // Clear-conversation button (item 3).
  describe("#search-clear-btn", () => {
    it("resets the conversation without touching the input text", async () => {
      vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete", sources: [], cluster_ids: [], images: [],
          tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
        });
      });
      const { container } = render(<SearchBar />);
      const input = screen.getByPlaceholderText(/ask/i);

      await userEvent.type(input, "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));
      await waitFor(() => expect(container.querySelector(".search-msg-user-text")).toBeInTheDocument());

      await userEvent.type(input, "leftover");
      await userEvent.click(screen.getByRole("button", { name: "Clear conversation" }));

      expect(container.querySelector(".search-msg-user-text")).not.toBeInTheDocument();
      expect(container.querySelector(".search-msg-assistant")).not.toBeInTheDocument();
      expect(input).toHaveValue("leftover");
    });

    it("cancels an in-flight stream before resetting state, instead of letting it resurrect the cleared turn", async () => {
      const streamSpy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(
        (_q, _h, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          })
      );
      const { container } = render(<SearchBar />);
      const input = screen.getByPlaceholderText(/ask/i);

      await userEvent.type(input, "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));
      await waitFor(() => expect(container.querySelector(".search-msg-assistant")).toBeInTheDocument());

      await userEvent.click(screen.getByRole("button", { name: "Clear conversation" }));

      expect(container.querySelector(".search-msg-user-text")).not.toBeInTheDocument();
      expect(container.querySelector(".search-msg-assistant")).not.toBeInTheDocument();
      expect(streamSpy).toHaveBeenCalled();
    });
  });

  // Admin-gated internals gear + panel (item 4). Predicate mirrors
  // app.py's clientside callback: role === 'admin' || actingAsDemo.
  describe("#agent-internals-btn / #agent-internals-panel", () => {
    const internalsBody = {
      system_prompt: "You are the compendium agent.",
      tools: [
        {
          type: "function",
          function: {
            name: "search_compendium",
            description: "Search the knowledge compendium.",
            parameters: {
              properties: {
                query: { type: "string", description: "search text" },
              },
            },
          },
        },
      ],
    };

    it("gear stays hidden for a non-admin, non-acting viewer", () => {
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#agent-internals-btn")).toHaveAttribute("hidden");
      expect(screen.queryByRole("button", { name: "Agent Internals" })).not.toBeInTheDocument();
    });

    it("gear is unhidden for an admin", () => {
      mockSession({ role: "admin" });
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#agent-internals-btn")).not.toHaveAttribute("hidden");
      expect(screen.getByRole("button", { name: "Agent Internals" })).toBeInTheDocument();
    });

    it("gear is hidden for an admin acting as demo (the plain-demo chat)", () => {
      mockSession({ role: "demo", actingAsDemo: true });
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#agent-internals-btn")).toHaveAttribute("hidden");
    });

    it("gear is hidden for a plain (non-acting) demo login", () => {
      mockSession({ role: "demo", actingAsDemo: false });
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#agent-internals-btn")).toHaveAttribute("hidden");
    });

    it("fetches internals lazily on first open, renders the system prompt + tools, and does not re-fetch on a second open", async () => {
      mockSession({ role: "admin" });
      const fetchSpy = vi.spyOn(apiModule, "apiFetch").mockResolvedValue(jsonResponse(internalsBody));
      const { container } = render(<SearchBar />);
      const gear = screen.getByRole("button", { name: "Agent Internals" });

      expect(fetchSpy).not.toHaveBeenCalled();

      await userEvent.click(gear);
      expect(fetchSpy).toHaveBeenCalledWith("/api/agent/internals");
      await waitFor(() => expect(screen.getByText("You are the compendium agent.")).toBeInTheDocument());
      expect(screen.getByText("search_compendium")).toBeInTheDocument();
      expect(container.querySelector("#agent-internals-panel")).toHaveStyle({ display: "block" });

      // Close then reopen -- cached, no second fetch.
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(container.querySelector("#agent-internals-panel")).toHaveStyle({ display: "none" });
      await userEvent.click(gear);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("renders a short error line on a 403 and retries the fetch on the next open", async () => {
      mockSession({ role: "admin" });
      const fetchSpy = vi
        .spyOn(apiModule, "apiFetch")
        .mockResolvedValueOnce(jsonResponse({ detail: "Admin context required" }, 403))
        .mockResolvedValueOnce(jsonResponse(internalsBody));
      render(<SearchBar />);
      const gear = screen.getByRole("button", { name: "Agent Internals" });

      await userEvent.click(gear);
      await waitFor(() => expect(screen.getByText(/admin access required/i)).toBeInTheDocument());

      // Close and reopen: the earlier failure left `internals` null, so
      // this retries rather than permanently wedging on the error.
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(gear);
      await waitFor(() => expect(screen.getByText("You are the compendium agent.")).toBeInTheDocument());
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("force-closes the panel if adminContext is lost while it's open (CSS [hidden]-vs-inline-display hardening)", async () => {
      mockSession({ role: "admin" });
      vi.spyOn(apiModule, "apiFetch").mockResolvedValue(jsonResponse(internalsBody));
      const { container, rerender } = render(<SearchBar />);
      await userEvent.click(screen.getByRole("button", { name: "Agent Internals" }));
      await waitFor(() =>
        expect(container.querySelector("#agent-internals-panel")).toHaveStyle({ display: "block" })
      );

      mockSession({ role: "user" });
      rerender(<SearchBar />);

      await waitFor(() =>
        expect(container.querySelector("#agent-internals-panel")).toHaveStyle({ display: "none" })
      );
    });
  });

  // Trace gating / data-show-trace parity (item 5). Same admin-context
  // predicate as the gear above.
  describe("trace gating", () => {
    function mockCompleteWithTrace() {
      return vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete",
          sources: [],
          cluster_ids: [],
          images: [],
          tool_calls_made: [{ iteration: 1, tool: "search_compendium", arguments: {}, result_preview: "ok" }],
          total_cost_usd: 0.01,
          iterations: 1,
          model: "m",
        });
      });
    }

    it("data-show-trace is 0 and the trace block does not render for a non-admin viewer", async () => {
      mockCompleteWithTrace();
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#search-bar")).toHaveAttribute("data-show-trace", "0");

      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(container.querySelector(".search-msg-assistant")).toBeInTheDocument());
      expect(screen.queryByText(/^Trace:/)).not.toBeInTheDocument();
    });

    it("trace entries use the ported Dash classes and cap the preview at TRACE_PREVIEW_MAX_CHARS", async () => {
      const long = "x".repeat(TRACE_PREVIEW_MAX_CHARS + 50);
      mockSession({ role: "admin" });
      vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete",
          sources: [],
          cluster_ids: [],
          images: [],
          tool_calls_made: [{ iteration: 1, tool: "search_compendium", arguments: { query: "v" }, result_preview: long }],
          total_cost_usd: 0.01,
          iterations: 1,
          model: "m",
        });
      });
      const { container } = render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));
      await waitFor(() => expect(screen.getByText(/^Trace:/)).toBeInTheDocument());
      expect(container.querySelector(".search-trace-entry .search-trace-tool")).toHaveTextContent("search_compendium");
      expect(container.querySelector(".search-trace-args")).toHaveTextContent('args: {"query":"v"}');
      const result = container.querySelector(".search-trace-result");
      expect(result?.textContent).toBe("x".repeat(TRACE_PREVIEW_MAX_CHARS) + "...");
    });

    it("data-show-trace is 1 and the trace block renders for an admin viewer", async () => {
      mockSession({ role: "admin" });
      mockCompleteWithTrace();
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#search-bar")).toHaveAttribute("data-show-trace", "1");

      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByText(/^Trace:/)).toBeInTheDocument());
    });

    it("data-show-trace is 0 and no trace block renders for an admin acting as demo, even with trace data", async () => {
      mockSession({ role: "demo", actingAsDemo: true });
      const spy = mockCompleteWithTrace();
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#search-bar")).toHaveAttribute("data-show-trace", "0");

      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      // Wait for the mocked reply to finish, so "no trace" is not vacuous.
      await waitFor(() => expect(spy).toHaveBeenCalled());
      await act(async () => { await spy.mock.results[0].value; });
      expect(screen.queryByText(/^Trace:/)).not.toBeInTheDocument();
    });
  });
});

describe("SearchBar chat polish round 2", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetGraphCacheForTest();
    mockSession();
    sessionStorage.clear();
  });

  async function askWithImages(images: { thumb_url: string; source_url?: string | null }[]) {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: ["https://example.com/x"], cluster_ids: [],
        images, tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    const utils = render(<SearchBar />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText("sources:")).toBeInTheDocument());
    return utils;
  }

  describe("images row (2b)", () => {
    it("renders one anchor per image with the thumb src and source href, after the sources row", async () => {
      const { container } = await askWithImages([
        { thumb_url: "https://img.test/a.jpg", source_url: "https://img.test/full-a.jpg" },
        { thumb_url: "https://img.test/b.jpg", source_url: "https://img.test/full-b.jpg" },
      ]);
      const row = container.querySelector(".chat-images-row") as HTMLElement;
      expect(row).toBeInTheDocument();
      expect(row.querySelector(".chat-images-label")).toHaveTextContent("images:");
      const anchors = row.querySelectorAll("a");
      expect(anchors).toHaveLength(2);
      expect(anchors[0]).toHaveAttribute("href", "https://img.test/full-a.jpg");
      expect(anchors[0]).toHaveAttribute("target", "_blank");
      expect(anchors[0]).toHaveAttribute("rel", "noopener noreferrer");
      expect(anchors[0]).toHaveAttribute("title", "Open full image");
      const img = anchors[0].querySelector("img") as HTMLImageElement;
      expect(img).toHaveAttribute("src", "https://img.test/a.jpg");
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("alt", "");
      const sources = container.querySelector(".chat-sources-row") as HTMLElement;
      expect(sources.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("falls back to the thumb url when source_url is missing", async () => {
      const { container } = await askWithImages([{ thumb_url: "https://img.test/a.jpg", source_url: null }]);
      expect(container.querySelector(".chat-images-row a")).toHaveAttribute("href", "https://img.test/a.jpg");
    });

    it("caps the row at 6 images", async () => {
      const many = Array.from({ length: 9 }, (_, i) => ({
        thumb_url: `https://img.test/${i}.jpg`, source_url: `https://img.test/full-${i}.jpg`,
      }));
      const { container } = await askWithImages(many);
      expect(container.querySelectorAll(".chat-images-row a")).toHaveLength(6);
    });

    it("is hidden when there are no images", async () => {
      const { container } = await askWithImages([]);
      expect(container.querySelector(".chat-images-row")).not.toBeInTheDocument();
    });

    it("is hidden for restored turns", async () => {
      sessionStorage.setItem(
        "compendium-search-history",
        JSON.stringify({
          nextId: 1,
          turns: [{
            user: "old q", restored: true,
            assistant: { text: "a", done: true, status: "", meta: { sources: [], images: [{ thumb_url: "https://img.test/a.jpg", source_url: "https://img.test/f.jpg" }] } },
          }],
        }),
      );
      const { container } = render(<SearchBar />);
      await waitFor(() => expect(container.querySelector(".search-msg-restored")).toBeInTheDocument());
      expect(container.querySelector(".chat-images-row")).not.toBeInTheDocument();
    });

    it("renders no anchor for a javascript: source_url", async () => {
      const { container } = await askWithImages([
        { thumb_url: "https://img.test/a.jpg", source_url: "javascript:alert(1)" },
      ]);
      expect(container.querySelector(".chat-images-row")).not.toBeInTheDocument();
      expect(container.querySelector("a[href^='javascript']")).not.toBeInTheDocument();
    });

    it("renders nothing for a data: thumb", async () => {
      const { container } = await askWithImages([
        { thumb_url: "data:image/svg+xml;base64,AAAA", source_url: "https://img.test/f.jpg" },
      ]);
      expect(container.querySelector(".chat-images-row")).not.toBeInTheDocument();
      expect(container.querySelector("img")).not.toBeInTheDocument();
    });

    it("keeps the safe pairs and drops the unsafe one", async () => {
      const { container } = await askWithImages([
        { thumb_url: "https://img.test/a.jpg", source_url: "https://img.test/fa.jpg" },
        { thumb_url: "https://img.test/b.jpg", source_url: "javascript:alert(1)" },
      ]);
      expect(container.querySelectorAll(".chat-images-row a")).toHaveLength(1);
    });

    it("does not render a source pill whose URL is javascript:", async () => {
      vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
        h.onComplete?.({
          type: "complete", sources: ["javascript:alert(1)", "https://example.com/ok"], cluster_ids: [],
          images: [], tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
        });
      });
      const { container } = render(<SearchBar />);
      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));
      await waitFor(() => expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument());
      expect(container.querySelectorAll(".chat-source-pill")).toHaveLength(1);
      expect(container.querySelector("a[href^='javascript']")).not.toBeInTheDocument();
    });

    it("hides an image's anchor when it fails to load", async () => {
      const { container } = await askWithImages([
        { thumb_url: "https://img.test/a.jpg", source_url: "https://img.test/fa.jpg" },
        { thumb_url: "https://img.test/b.jpg", source_url: "https://img.test/fb.jpg" },
      ]);
      const imgs = container.querySelectorAll<HTMLImageElement>(".chat-images-row img");
      fireEvent.error(imgs[0]);
      const anchors = container.querySelectorAll<HTMLElement>(".chat-images-row a");
      expect(anchors[0]).toHaveStyle({ display: "none" });
      expect(anchors[1]).not.toHaveStyle({ display: "none" });
    });
  });

  describe("agent internals labels (2d) and anchoring (2e)", () => {
    const body = {
      system_prompt: "sys",
      tools: [
        {
          type: "function",
          function: {
            name: "search_compendium", description: "Search.",
            parameters: { properties: { query: { type: "string", description: "text" } } },
          },
        },
        { type: "function", function: { name: "list_clusters", description: "List." } },
      ],
    };

    async function openPanel() {
      mockSession({ role: "admin" });
      vi.spyOn(apiModule, "apiFetch").mockResolvedValue(jsonResponse(body));
      const utils = render(<SearchBar />);
      await userEvent.click(screen.getByRole("button", { name: "Agent Internals" }));
      await waitFor(() => expect(screen.getByText("search_compendium")).toBeInTheDocument());
      return utils;
    }

    it("explains the boxes at the top of the tools section", async () => {
      await openPanel();
      expect(screen.getByText("Each box lists the arguments the agent can pass to that tool.")).toBeInTheDocument();
    });

    it("captions each tool's box with 'arguments'", async () => {
      const { container } = await openPanel();
      const tools = container.querySelectorAll("#agent-internals-panel details details");
      expect(tools).toHaveLength(2);
      tools.forEach((t) => expect(t.querySelector(".internals-tool-caption")).toHaveTextContent("arguments"));
    });

    it("shows '(takes no arguments)' for a tool without parameters", async () => {
      const { container } = await openPanel();
      const tools = container.querySelectorAll("#agent-internals-panel details details");
      expect(tools[1].querySelector("pre")).toHaveTextContent("(takes no arguments)");
      expect(tools[0].querySelector("pre")).toHaveTextContent("query: string");
      expect(container.querySelector("#agent-internals-panel")).not.toHaveTextContent("(none)");
    });

    it("positions the panel from the gear button's rect when opened", async () => {
      mockSession({ role: "admin" });
      vi.spyOn(apiModule, "apiFetch").mockResolvedValue(jsonResponse(body));
      const rect = (l: number, t: number, r: number, b: number) =>
        ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;
      const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.id === "agent-internals-btn") return rect(900, 700, 930, 728);
        if (this.classList.contains("search-bar-wrapper")) return rect(8, 300, 1000, 760);
        return rect(0, 0, 0, 0);
      });
      const { container } = render(<SearchBar />);
      const panel = container.querySelector("#agent-internals-panel") as HTMLElement;
      const wrapper = container.querySelector(".search-bar-wrapper") as HTMLElement;
      expect(wrapper.contains(panel)).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Agent Internals" }));
      // bottom = wrapper.bottom - gear.top + 8 ; right = wrapper.right - gear.right
      await waitFor(() => expect(panel.style.bottom).toBe("68px"));
      expect(panel.style.right).toBe("70px");
      spy.mockRestore();
    });
  });
});

describe("ChatImagesRow (unit)", () => {
  it("filters unsafe urls and caps at 6", () => {
    const images = [
      { thumb_url: "javascript:x", source_url: "https://a.test/f" },
      { thumb_url: "https://a.test/1", source_url: "data:text/html,x" },
      ...Array.from({ length: 8 }, (_, i) => ({ thumb_url: `https://a.test/t${i}`, source_url: null })),
    ];
    const { container } = render(<ChatImagesRow images={images} />);
    expect(container.querySelectorAll("a")).toHaveLength(6);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://a.test/t0");
  });
  it("renders nothing for undefined images", () => {
    const { container } = render(<ChatImagesRow images={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("internals panel re-measure on bar size change", () => {
  it("updates bottom when the observed bar resizes while open", async () => {
    vi.restoreAllMocks();
    __resetGraphCacheForTest();
    mockSession({ role: "admin" });
    vi.spyOn(apiModule, "apiFetch").mockResolvedValue(jsonResponse({ system_prompt: "s", tools: [] }));
    let cb: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(f: () => void) { cb = f; }
      observe() {}
      disconnect = disconnect;
    });
    let gearTop = 100;
    const rect = (l: number, t: number, r: number, b: number) =>
      ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "agent-internals-btn") return rect(900, gearTop, 930, gearTop + 28);
      if (this.classList.contains("search-bar-wrapper")) return rect(8, 0, 1000, 760);
      return rect(0, 0, 0, 0);
    });
    const { container, unmount } = render(<SearchBar />);
    const panel = container.querySelector("#agent-internals-panel") as HTMLElement;
    await userEvent.click(screen.getByRole("button", { name: "Agent Internals" }));
    await waitFor(() => expect(panel.style.bottom).toBe("668px"));
    gearTop = 700;
    act(() => cb?.());
    await waitFor(() => expect(panel.style.bottom).toBe("68px"));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(disconnect).toHaveBeenCalled();
    unmount();
    vi.unstubAllGlobals();
  });
});
