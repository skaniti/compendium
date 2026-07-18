import { describe, it, expect, vi } from "vitest";
import { extractEvents, streamAgentQuery } from "./agent-stream";
import * as api from "./api";

describe("extractEvents", () => {
  it("parses status, token, complete from standard \\n\\n framing", () => {
    const buf =
      'data: {"type":"status","text":"Using search_compendium..."}\n\n' +
      'data: {"type":"token","text":"The "}\n\n' +
      'data: {"type":"token","text":"compendium"}\n\n' +
      'data: {"type":"complete","sources":["https://x"],"cluster_ids":[1],"images":[],"tool_calls_made":[{"iteration":1,"tool":"search_compendium","arguments":{"q":"x"},"result_preview":"..."}],"total_cost_usd":0.001,"iterations":1,"model":"gpt-4o-mini"}\n\n';
    const { events, rest } = extractEvents(buf);
    expect(events.map((e) => e.type)).toEqual(["status", "token", "token", "complete"]);
    expect(rest).toBe("");
  });

  it("tolerates single \\n framing", () => {
    const buf = 'data: {"type":"token","text":"a"}\ndata: {"type":"token","text":"b"}\n';
    const { events } = extractEvents(buf);
    expect(events).toHaveLength(2);
  });

  it("keeps a partial trailing line in rest", () => {
    const buf = 'data: {"type":"token","text":"a"}\n\ndata: {"type":"to';
    const { events, rest } = extractEvents(buf);
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"type":"to');
  });

  it("ignores malformed and non-data lines", () => {
    const buf = ': keep-alive\n\ndata: not-json\n\ndata: {"type":"token","text":"ok"}\n\n';
    const { events } = extractEvents(buf);
    expect(events).toHaveLength(1);
  });
});

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamAgentQuery", () => {
  it("dispatches status, token, complete handlers", async () => {
    const tokens: string[] = [];
    let completed = false;
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        'data: {"type":"status","text":"thinking"}\n\n',
        'data: {"type":"token","text":"hi"}\n\n',
        'data: {"type":"complete","sources":[],"cluster_ids":[],"images":[],"tool_calls_made":[],"total_cost_usd":0,"iterations":1,"model":"m"}\n\n',
      ]),
    ));
    await streamAgentQuery("q", {
      onToken: (t) => tokens.push(t),
      onComplete: () => { completed = true; },
    });
    expect(tokens.join("")).toBe("hi");
    expect(completed).toBe(true);
    vi.unstubAllGlobals();
  });

  it("throws on non-200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500, statusText: "err" })));
    await expect(streamAgentQuery("q", {})).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });

  // Batch-04 fix-round bug: this function talks to fetch directly (not
  // apiFetch, since it needs the raw stream body), so a post-lapse 401
  // response never went through apiFetch's bounce-to-/login handling -- it
  // just threw a generic Error that useAgentChat rendered as a chat error
  // bubble, leaving the user stranded on a dead page instead of sent to
  // /login. Fix: on a 401, reuse lib/api.ts's guarded redirectToLogin and
  // resolve without throwing (a 500 still throws, unchanged -- see above).
  it("on a 401, navigates to /login via the shared guard instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })));
    const redirectSpy = vi.spyOn(api, "redirectToLogin").mockImplementation(() => {});

    await expect(streamAgentQuery("q", {})).resolves.toBeUndefined();

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    redirectSpy.mockRestore();
  });
});
