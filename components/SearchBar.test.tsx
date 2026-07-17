import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
