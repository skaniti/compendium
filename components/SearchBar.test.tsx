import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchBar from "./SearchBar";
import * as stream from "@/lib/agent-stream";

// Ported from the old full-page Chat.test.tsx (Task 10: re-home into the
// search-bar overlay -- see graph_canvas.py's _render_search_bar()). Selector
// changes vs. the original: the send control is now the single
// #agent-search-btn icon button (aria-label "Search", matching Dash's
// title="Search" -- exact-string match so it doesn't also catch the
// #search-tab button, whose accessible name is "Compendium Search ...").
describe("SearchBar", () => {
  beforeEach(() => vi.restoreAllMocks());

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
    expect(screen.getByText(/example\.com/)).toBeInTheDocument(); // source pill
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
});
