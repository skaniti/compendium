import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { historyFromTurns, useAgentChat } from "./useAgentChat";
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
// 2026-09-28: conversation continuity -- each send() passes the finished
// prior exchanges to streamAgentQuery as history (Dash parity; the port
// used to send only the query).
describe("useAgentChat history", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  const complete = {
    type: "complete" as const, sources: [], cluster_ids: [], images: [],
    tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
  };

  it("historyFromTurns keeps only finished, non-empty exchanges", () => {
    const turns = [
      { id: 0, user: "a", assistant: { text: "A", done: true, status: "" } },
      { id: 1, user: "b", assistant: { text: "", done: true, status: "" } },
      { id: 2, user: "c", assistant: { text: "C", done: true, status: "", error: "boom" } },
      { id: 3, user: "d", assistant: { text: "D", done: false, status: "Thinking..." } },
      { id: 4, user: "e", assistant: { text: "E", done: true, status: "" } },
    ];
    expect(historyFromTurns(turns)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "A" },
      { role: "user", content: "e" },
      { role: "assistant", content: "E" },
    ]);
  });

  it("the first send carries no history and the second carries the first exchange", async () => {
    const spy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("answer one");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());

    act(() => result.current.setInput("first"));
    await act(async () => {
      await result.current.send();
    });
    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    expect(spy.mock.calls[0][3]).toEqual([]);

    act(() => result.current.setInput("second"));
    await act(async () => {
      await result.current.send();
    });
    expect(spy.mock.calls[1][0]).toBe("second");
    expect(spy.mock.calls[1][3]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
    ]);
  });

  it("clear() empties the history sent by the next send", async () => {
    const spy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("x");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    act(() => result.current.setInput("first"));
    await act(async () => {
      await result.current.send();
    });
    await waitFor(() => expect(result.current.turns[0]?.assistant.done).toBe(true));
    act(() => result.current.clear());
    act(() => result.current.setInput("fresh"));
    await act(async () => {
      await result.current.send();
    });
    expect(spy.mock.calls[1][3]).toEqual([]);
  });
});

describe("useAgentChat clear()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

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
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

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
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

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

describe("useAgentChat rolling history + reload persistence", () => {
  const KEY = "compendium-search-history";
  const complete = {
    type: "complete" as const, sources: [], cluster_ids: [], images: [],
    tool_calls_made: [], total_cost_usd: 0, iterations: 1, model: "m",
  };
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  async function sendOne(result: { current: ReturnType<typeof useAgentChat> }, q: string) {
    act(() => result.current.setInput(q));
    await act(async () => {
      await result.current.send();
    });
  }

  it("a long conversation still carries a condensed trace of the first exchange", async () => {
    const long = "Opening fact one. " + "filler words ".repeat(200);
    const spy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.(long);
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    for (let i = 0; i < 14; i++) await sendOne(result, i === 0 ? "the very first question" : `question ${i}`);
    const history = spy.mock.calls[13][3]!;
    expect(history[0]).toEqual({ role: "user", content: "the very first question" });
    expect(history[1].role).toBe("assistant");
    expect(history[1].content.startsWith("Opening fact one.")).toBe(true);
    expect(history.reduce((s, t) => s + t.content.length, 0)).toBeLessThanOrEqual(7500);
  });

  it("restores turns from sessionStorage on mount, marked restored, and feeds them into history", async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        nextId: 1,
        turns: [{ user: "old q", assistant: { text: "old a", done: true, status: "" }, restored: true }],
      }),
    );
    const spy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("new a");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    expect(result.current.turns[0]).toMatchObject({ user: "old q", restored: true });
    expect(result.current.turns[0].assistant).toMatchObject({ text: "old a", done: true });
    await sendOne(result, "new q");
    expect(spy.mock.calls[0][3]).toEqual([
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a" },
    ]);
    expect(new Set(result.current.turns.map((t) => t.id)).size).toBe(2);
  });

  it("forces restored entries to done: true even if stored otherwise", async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        nextId: 1,
        turns: [{ user: "q", assistant: { text: "a", done: false, status: "Thinking..." }, restored: true }],
      }),
    );
    const { result } = renderHook(() => useAgentChat());
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    expect(result.current.turns[0].assistant).toEqual({ text: "a", done: true, status: "" });
    expect(historyFromTurns(result.current.turns)).toHaveLength(2);
  });

  it("ignores corrupt stored data", async () => {
    sessionStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useAgentChat());
    expect(result.current.turns).toEqual([]);
  });

  it("persists a completed turn, caps at 40, and does not persist errored turns", async () => {
    const spy = vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("ans");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    await sendOne(result, "q0");
    let stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored.turns).toEqual([
      { user: "q0", assistant: { text: "ans", done: true, status: "" }, restored: true },
    ]);
    expect(stored.nextId).toBe(1);

    spy.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await sendOne(result, "bad");
    stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored.turns).toHaveLength(1);

    for (let i = 1; i < 45; i++) await sendOne(result, `q${i}`);
    stored = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(stored.turns).toHaveLength(40);
    expect(stored.turns[39].user).toBe("q44");
    expect(stored.turns[0].user).toBe("q5");
  });

  it("clear() removes the key", async () => {
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("ans");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    await sendOne(result, "q");
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    act(() => result.current.clear());
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("a throwing sessionStorage does not break send", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(stream, "streamAgentQuery").mockImplementation(async (_q, h) => {
      h.onToken?.("ans");
      h.onComplete?.(complete);
    });
    const { result } = renderHook(() => useAgentChat());
    await sendOne(result, "q");
    expect(result.current.turns[0].assistant).toMatchObject({ text: "ans", done: true });
    act(() => result.current.clear());
    expect(result.current.turns).toEqual([]);
  });
});
