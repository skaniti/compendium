import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentChat } from "./useAgentChat";
import * as stream from "@/lib/agent-stream";

// Hook-level tests for clear() (item 3, P4 clear-chat port of
// search_stream.js's clearHistory()). SearchBar.test.tsx's
// "#search-clear-btn" suite covers the same contract end-to-end through the
// rendered button; these isolate the state-reset behavior at the hook
// boundary, including the deliberate sane-deviation from Dash (cancelling
// an in-flight stream before resetting state -- see clear()'s own comment
// in useAgentChat.ts for why).
describe("useAgentChat clear()", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resets userMsgs and assistant but leaves input untouched", async () => {
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
    await waitFor(() => expect(result.current.assistant?.done).toBe(true));
    expect(result.current.userMsgs).toEqual(["hi"]);

    act(() => result.current.setInput("leftover"));
    act(() => result.current.clear());

    expect(result.current.userMsgs).toEqual([]);
    expect(result.current.assistant).toBeNull();
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

    expect(result.current.userMsgs).toEqual([]);
    expect(result.current.assistant).toBeNull();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(streamSpy).toHaveBeenCalled();
    // The in-flight send()'s catch fires AFTER clear() already reset
    // assistant to null -- its `a ? ... : a` update pattern must be a
    // no-op at that point, not resurrect a "Cancelled." bubble.
    expect(result.current.assistant).toBeNull();
  });
});
