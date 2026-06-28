import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Chat from "./Chat";
import * as stream from "@/lib/agent-stream";

describe("Chat", () => {
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
    render(<Chat />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument()); // markdown-rendered bold
    expect(screen.getByText(/example\.com/)).toBeInTheDocument(); // source pill
  });

  it("shows an error when the stream rejects", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockRejectedValue(new Error("boom 500"));
    render(<Chat />);
    await userEvent.type(screen.getByPlaceholderText(/ask/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/boom 500/)).toBeInTheDocument());
  });
});
