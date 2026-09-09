import { afterEach, describe, it, expect, vi } from "vitest";
import { extractEvents, streamAgentQuery } from "./agent-stream";
import * as api from "./api";

// D3 (session-expiry-tuning): streamAgentQuery's recovery attempt is gated
// by sessionMayResume (lib/session-policy-client.ts), read from
// document.cookie -- same gate apiFetch itself uses. Tests that exercise
// the recovery/retry path need a resumable policy cookie present; tests
// that don't set one are exercising (and rely on) the "no policy cookie"
// no-recovery path.
function setResumablePolicyCookie() {
  document.cookie = `session_policy=${encodeURIComponent(
    JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
  )}; path=/`;
}

function clearSessionCookies() {
  document.cookie = "session_policy=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "session_last_active=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

describe("extractEvents", () => {
  it("parses status, token, complete from standard \\n\\n framing", () => {
    const buf =
      'data: {"type":"status","text":"Using search_compendium..."}\n\n' +
      'data: {"type":"token","text":"The "}\n\n' +
      'data: {"type":"token","text":"compendium"}\n\n' +
      'data: {"type":"complete","sources":["https://x"],"cluster_ids":["slug-a"],"images":[],"tool_calls_made":[{"iteration":1,"tool":"search_compendium","arguments":{"q":"x"},"result_preview":"..."}],"total_cost_usd":0.001,"iterations":1,"model":"gpt-4o-mini"}\n\n';
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
  afterEach(() => {
    clearSessionCookies();
  });

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

  // Item 2 (session-expiry-tuning review fixes): the recovery attempt
  // itself is gated by sessionMayResume, exactly like apiFetch's own 401
  // handling -- with no policy cookie, a 401 must bounce straight to
  // /login without ever calling /api/auth/refresh.
  it("on a 401 with no policy cookie, skips recovery entirely (no /api/auth/refresh call) and redirects to /login", async () => {
    // Typed explicitly (item 5, session-expiry-tuning review fixes): an
    // arg-less callback makes vi.fn's inferred mock.calls element type `[]`,
    // and destructuring `[input]` below from an empty tuple is a tsc error
    // (TS2493).
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const redirectSpy = vi.spyOn(api, "redirectToLogin").mockImplementation(() => {});

    await expect(streamAgentQuery("q", {})).resolves.toBeUndefined();

    const refreshCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url === "/api/auth/refresh";
    });
    expect(refreshCalls).toHaveLength(0);
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    redirectSpy.mockRestore();
  });

  // D3 (session-expiry-tuning): before that bounce, streamAgentQuery now
  // tries the same silent recoverSession() every other 401 handler uses,
  // and retries the stream request once on success -- no more unconditional
  // bounce on the first 401.
  it("on a 401, recovers via recoverSession and retries the stream request once on success", async () => {
    setResumablePolicyCookie();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/refresh") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        call += 1;
        if (call === 1) return new Response("unauthorized", { status: 401 });
        return sseResponse(['data: {"type":"token","text":"hi"}\n\n']);
      })
    );
    const redirectSpy = vi.spyOn(api, "redirectToLogin").mockImplementation(() => {});
    const tokens: string[] = [];

    await streamAgentQuery("q", { onToken: (t) => tokens.push(t) });

    expect(tokens.join("")).toBe("hi");
    expect(redirectSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    redirectSpy.mockRestore();
  });

  it("on a 401, redirects to /login if the retried request 401s again", async () => {
    setResumablePolicyCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/refresh") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("still unauthorized", { status: 401 });
      })
    );
    const redirectSpy = vi.spyOn(api, "redirectToLogin").mockImplementation(() => {});

    await expect(streamAgentQuery("q", {})).resolves.toBeUndefined();

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    redirectSpy.mockRestore();
  });
});
