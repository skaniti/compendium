import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentChat } from "./useAgentChat";
import * as stream from "@/lib/agent-stream";
import * as chatInterop from "@/lib/graph/chat-interop";

// Hook-level tests for clear() (item 3, P4 clear-chat port of
// search_stream.js's clearHistory()) and for the transcript-persistence
// restructure (chat parity fix 1, 2026-07-28: userMsgs[]/single-assistant
// state replaced by a `turns: Turn[]` array so completed exchanges persist
// instead of each send() replacing the prior answer -- see useAgentChat.ts's
// top-of-file comment and Turn's own doc comment for the id-addressing
// rationale). SearchBar.test.tsx's "#search-clear-btn" suite and its own
// transcript-persistence test cover the same contracts end-to-end through
// the rendered UI; these isolate the state-reset/turn-addressing behavior
// at the hook boundary, including the deliberate sane-deviation from Dash
// (cancelling an in-flight stream before resetting state -- see clear()'s
// own comment in useAgentChat.ts for why).
describe("useAgentChat clear()", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resets turns but leaves input untouched", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: [], cluster_ids: [], images: [],
        tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("hi"));
    await act(async () => {
      await result.current.send();
    });
    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    expect(result.current.turns.map((t) => t.user)).toEqual(["hi"]);

    act(() => result.current.setInput("leftover"));
    act(() => result.current.clear());

    expect(result.current.turns).toEqual([]);
    expect(result.current.input).toBe("leftover");
  });

  it("aborts an in-flight stream before resetting state, so the abort-catch can't resurrect the cleared turn", async () => {
    const streamSpy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(
      (_q, _h, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("hi"));
    act(() => {
      void result.current.send();
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    act(() => result.current.clear());

    expect(result.current.turns).toEqual([]);
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(streamSpy).toHaveBeenCalled();
    // The in-flight send()'s catch fires AFTER clear() already emptied
    // `turns` -- its id-addressed update (see updateAssistant in
    // useAgentChat.ts) must be a no-op at that point (no turn with a
    // matching id left to update), not resurrect a "Cancelled." bubble
    // by e.g. appending a new turn or writing into a same-index turn
    // from a later send.
    expect(result.current.turns).toEqual([]);
  });
});

describe("useAgentChat transcript persistence (chat parity fix 1)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps a completed turn in `turns` when a second send starts, addressed by its own id", async () => {
    const streamSpy = vi
      .spyOn(stream, "streamAgentQuery")
      .mockImplementationOnce(async (_q, h) => {
        h.onComplete?.({
          type: "complete", sources: [], cluster_ids: [], images: [],
          tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m1",
        });
      })
      .mockImplementationOnce(
        () => new Promise<void>(() => {}), // second send stays in flight
      );
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("first"));
    await act(async () => {
      await result.current.send();
    });
    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));

    act(() => result.current.setInput("second"));
    act(() => {
      void result.current.send();
    });
    await waitFor(() => expect(result.current.turns).toHaveLength(2));

    // The parity bug: a single shared `assistant` slot meant the second
    // send's initial {text:"", done:false} object REPLACED the first
    // turn's completed answer. Each turn must now be its own array
    // entry, so turn 0 stays exactly as it finished while turn 1 starts
    // fresh alongside it.
    expect(result.current.turns[0].user).toBe("first");
    expect(result.current.turns[0].assistant.done).toBe(true);
    expect(result.current.turns[0].assistant.meta?.model).toBe("m1");
    expect(result.current.turns[1].user).toBe("second");
    expect(result.current.turns[1].assistant.done).toBe(false);
    expect(streamSpy).toHaveBeenCalledTimes(2);
  });
});

// Task group C, C1 (cluster-cite framing): port of search_stream.js's
// `if (metadata && metadata.cluster_ids) { highlightClusters(metadata.cluster_ids); }`
// (:831-832). These tests isolate the WIRING -- that onComplete calls
// lib/graph/chat-interop.ts's frameCitedClusters with the event's
// cluster_ids and never lets it crash the turn -- against a mocked
// chat-interop module. frameCitedClusters' own union/frame/absent-module
// logic is covered independently in lib/graph/chat-interop.test.ts.
describe("useAgentChat cluster-cite framing (C1)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("calls frameCitedClusters with the complete event's cluster_ids once the turn completes", async () => {
    const frameSpy = vi.spyOn(chatInterop, "frameCitedClusters").mockResolvedValue(undefined);
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: [], cluster_ids: ["slug-a", "slug-b"], images: [],
        tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("hi"));
    await act(async () => {
      await result.current.send();
    });

    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    expect(frameSpy).toHaveBeenCalledWith(["slug-a", "slug-b"]);
  });

  it("still calls frameCitedClusters (with undefined) on an early-exit complete event missing cluster_ids -- relies on its own no-op guard, does not special-case here", async () => {
    const frameSpy = vi.spyOn(chatInterop, "frameCitedClusters").mockResolvedValue(undefined);
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      // Early-exit complete shape (no OpenAI key / empty compendium,
      // backend/services/agent.py ~697-706/715-724): cluster_ids absent.
      h.onComplete?.({ type: "complete", sources: [], iterations: 0, model: "m" });
    });
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("hi"));
    await act(async () => {
      await result.current.send();
    });

    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    expect(frameSpy).toHaveBeenCalledWith(undefined);
  });

  it("does not surface an error on the turn when frameCitedClusters unexpectedly rejects -- chat must never crash while the graph module is loading/missing", async () => {
    vi.spyOn(chatInterop, "frameCitedClusters").mockRejectedValue(new Error("graph module unavailable"));
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onComplete?.({
        type: "complete", sources: [], cluster_ids: ["slug-a"], images: [],
        tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
      });
    });
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("hi"));
    await act(async () => {
      await result.current.send();
    });

    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    expect(result.current.turns[0]?.assistant.error).toBeUndefined();
  });
});
