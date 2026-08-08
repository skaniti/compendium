import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchBar from "./SearchBar";
import * as stream from "@/lib/agent-stream";
import * as SessionProviderModule from "@/components/SessionProvider";
import * as apiModule from "@/lib/api";
import type { SessionRole } from "@/components/SessionProvider";

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
// mockSession({ role: "admin" }) or mockSession({ actingAsDemo: true })
// explicitly before rendering.
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

describe("SearchBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSession();
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

    it("gear is unhidden for an admin acting as demo", () => {
      mockSession({ role: "demo", actingAsDemo: true });
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#agent-internals-btn")).not.toHaveAttribute("hidden");
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

    it("data-show-trace is 1 and the trace block renders for an admin viewer", async () => {
      mockSession({ role: "admin" });
      mockCompleteWithTrace();
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#search-bar")).toHaveAttribute("data-show-trace", "1");

      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByText(/^Trace:/)).toBeInTheDocument());
    });

    it("data-show-trace is 1 and the trace block renders for an admin acting as demo", async () => {
      mockSession({ role: "demo", actingAsDemo: true });
      mockCompleteWithTrace();
      const { container } = render(<SearchBar />);
      expect(container.querySelector("#search-bar")).toHaveAttribute("data-show-trace", "1");

      await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
      await userEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(screen.getByText(/^Trace:/)).toBeInTheDocument());
    });
  });
});
