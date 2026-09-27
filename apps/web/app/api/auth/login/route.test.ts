import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";
import { INGRESS_HEADER } from "@/lib/ingress";
import { PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER } from "@/lib/proxy-attest";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

// D2 correction #1 (batch 04 auth/session parity): the Slice-1 login route
// discarded the backend's refresh_token entirely. This pins the fix
// (refresh_token + session_expires_at now set alongside access_token) and
// the aligned-with-Dash error copy, at the handler level -- mirrors the
// thin-unit-test-with-mocked-cookies() idiom introduced for the refresh
// route (task-4-brief correction #3), since no route-handler test idiom
// existed before this task.

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

function makeFakeCookieJar() {
  const store = new Map<string, StoredCookie>();
  return {
    set(name: string, value: string, options?: Record<string, unknown>) {
      store.set(name, { value, options });
    },
    get(name: string) {
      const entry = store.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    delete(name: string) {
      store.delete(name);
    },
    _store: store,
  };
}

function mockFetchResponse(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function makeAccessToken(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeLoginRequest(body: { email: string; password: string }, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("on success, sets access_token, refresh_token, and session_expires_at cookies", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const accessToken = makeAccessToken(futureExpSeconds);
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));

    expect(res.status).toBe(200);
    expect(jar.get("access_token")?.value).toBe(accessToken);
    expect(jar._store.get("access_token")?.options).toMatchObject({ httpOnly: true });
    expect(jar.get("refresh_token")?.value).toBe("refresh-xyz");
    expect(jar._store.get("refresh_token")?.options).toMatchObject({ httpOnly: true });
    expect(jar.get("session_expires_at")?.value).toBe(String(futureExpSeconds * 1000));
    expect(jar._store.get("session_expires_at")?.options).toMatchObject({ httpOnly: false });
  });

  it("on failure, returns the Dash-aligned 'Invalid credentials.' error with a period", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ error: "bad creds" }) });

    const res = await POST(makeLoginRequest({ email: "alice", password: "wrong" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(jar.get("access_token")).toBeUndefined();
  });

  it("on a 403, also returns 'Invalid credentials.' with the upstream status", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) });

    const res = await POST(makeLoginRequest({ email: "alice", password: "wrong" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(403);
    expect(body.error).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  // Task 7a (post-flip-closeout): during the batch-06 rollback rehearsal an
  // upstream 503 surfaced as "Invalid credentials." -- a thrown fetch
  // (connection refused, DNS, abort) and any upstream 5xx must instead
  // report the outage distinctly, at a fixed 503 so the client only ever
  // has one branch to handle. Console noise silenced the same way the
  // component test suites do (e.g. TimeWindowProvider.test.tsx).
  it("when the backend is unreachable (fetch throws), returns 503 with the unreachable message and logs it", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe(BACKEND_UNREACHABLE_MESSAGE);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("on an upstream 503, returns a fixed 503 with the unreachable message (not the upstream body)", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 503, json: async () => ({ error: "boom" }) });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe(BACKEND_UNREACHABLE_MESSAGE);
    errSpy.mockRestore();
  });

  it("on an upstream 502, also returns 503 with the unreachable message (fixed status, not relayed)", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 502, json: async () => ({ error: "bad gateway" }) });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe(BACKEND_UNREACHABLE_MESSAGE);
    errSpy.mockRestore();
  });

  // The login rate limit (5/minute) is server-side truth the user should
  // see, not a generic "Invalid credentials." -- distinct from other
  // non-OK, non-5xx statuses (e.g. 422), which keep today's behaviour.
  it("on an upstream 429 (login rate limit), returns 429 with the too-many-attempts message", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 429, json: async () => ({ error: "rate limited" }) });

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(429);
    expect(body.error).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
  });

  it("on any other non-OK status (e.g. 422), keeps today's behaviour: 'Invalid credentials.' with the upstream status", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 422, json: async () => ({ error: "unprocessable" }) });

    const res = await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(422);
    expect(body.error).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  // D1/D4 (session-expiry-tuning, 2026-09-10 amendment): the login form's
  // "Keep me signed in on this device" checkbox and `remember` body field
  // are gone -- the backend derives `remembered` itself from the ingress
  // header, never from a client-supplied flag.
  it("forwards exactly {email, password} to the backend, with no remember field", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/login"),
      expect.objectContaining({
        body: JSON.stringify({ email: "alice", password: "hunter2" }),
      })
    );
  });

  // batch-06 deploy-flip fix wave: Vercel has no trusted edge in front of
  // apps/web, so the route must NOT relay a client-supplied ingress header
  // -- even the trusted-looking value -- to the backend.
  it("does not forward the X-Compendium-Ingress header to the backend, even when the inbound request carries it", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    await POST(makeLoginRequest({ email: "alice", password: "hunter2" }, { [INGRESS_HEADER]: "tailnet" }));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  it("omits the X-Compendium-Ingress header from the backend call when the inbound request has none", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  // Task 7e (post-flip-closeout): the login route builds its headers object
  // from scratch (never spreads the inbound request's own headers), so a
  // browser-supplied attest header can never reach the backend call --
  // pinned here the same way the sibling ingress tests pin it. When
  // BACKEND_PROXY_SECRET is configured, the real attested pair must be
  // added instead.
  describe("proxy attest headers", () => {
    const ORIGINAL_SECRET = process.env.BACKEND_PROXY_SECRET;

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) delete process.env.BACKEND_PROXY_SECRET;
      else process.env.BACKEND_PROXY_SECRET = ORIGINAL_SECRET;
    });

    it("never forwards a browser-supplied attest pair, even when BACKEND_PROXY_SECRET is unset", async () => {
      delete process.env.BACKEND_PROXY_SECRET;
      const jar = makeFakeCookieJar();
      vi.mocked(cookies).mockResolvedValue(jar as never);
      const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
      const fetchMock = mockFetchResponse({
        ok: true,
        json: async () => ({
          access_token: accessToken,
          refresh_token: "refresh-xyz",
          user: { id: 1, email: "alice@example.com", name: "Alice" },
        }),
      });

      await POST(
        makeLoginRequest(
          { email: "alice", password: "hunter2" },
          { [PROXY_SECRET_HEADER]: "browser-supplied", [PROXY_CLIENT_IP_HEADER]: "9.9.9.9" }
        )
      );

      const call = fetchMock.mock.calls[0];
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(Object.keys(headers)).not.toContain(PROXY_SECRET_HEADER);
      expect(Object.keys(headers)).not.toContain(PROXY_CLIENT_IP_HEADER);
    });

    it("forwards the attested pair to the backend when BACKEND_PROXY_SECRET is configured", async () => {
      process.env.BACKEND_PROXY_SECRET = "real-shared-secret";
      const jar = makeFakeCookieJar();
      vi.mocked(cookies).mockResolvedValue(jar as never);
      const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
      const fetchMock = mockFetchResponse({
        ok: true,
        json: async () => ({
          access_token: accessToken,
          refresh_token: "refresh-xyz",
          user: { id: 1, email: "alice@example.com", name: "Alice" },
        }),
      });

      await POST(
        makeLoginRequest(
          { email: "alice", password: "hunter2" },
          { "x-forwarded-for": "198.51.100.9" }
        )
      );

      const call = fetchMock.mock.calls[0];
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers[PROXY_SECRET_HEADER]).toBe("real-shared-secret");
      expect(headers[PROXY_CLIENT_IP_HEADER]).toBe("198.51.100.9");
    });
  });

  it("sets the session_policy cookie from the backend's session_policy on success", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
        session_policy: { idle_minutes: 720, resume: true, remembered: false },
      }),
    });

    await POST(makeLoginRequest({ email: "demo", password: "demo" }));

    expect(jar.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 720, resume: true, remembered: false })
    );
  });

  // Item 3 (session-expiry-tuning review fixes): login is genuine activity
  // -- a stale session_last_active from a PREVIOUS session in this browser
  // (e.g. one that idled out hours ago) must not carry over, but the fix is
  // to STAMP it to "now" rather than delete it: a session with zero
  // recorded activity must not read as "always active" against the
  // permissive no-last-active fallbacks in session-policy-client.ts.
  it("stamps session_last_active to a recent timestamp (not deleted) on successful login", async () => {
    const jar = makeFakeCookieJar();
    jar._store.set("session_last_active", { value: String(Date.now() - 999_999_999) });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    const before = Date.now();
    await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));
    const after = Date.now();

    const stamped = Number(jar.get("session_last_active")?.value);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    expect(jar._store.get("session_last_active")?.options).toMatchObject({ httpOnly: false });
  });

  it("does not set a session_policy cookie when the backend response has no session_policy", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const accessToken = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: "refresh-xyz",
        user: { id: 1, email: "alice@example.com", name: "Alice" },
      }),
    });

    await POST(makeLoginRequest({ email: "alice", password: "hunter2" }));

    expect(jar.get("session_policy")).toBeUndefined();
  });
});
