import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";
import { INGRESS_HEADER } from "@/lib/ingress";
import { clearAllSingleFlights } from "@/lib/refresh-single-flight";

// D2 (batch 04 auth/session parity): the refresh route SessionKeeper polls.
// No route-handler test idiom exists yet in this repo (task-4-brief
// correction #3) -- this is a thin unit test around the real handler with
// next/headers' cookies() mocked to a fake jar, not a mock of the route's
// own logic.

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}

function makeFakeCookieJar(initial?: Record<string, string>) {
  const store = new Map<string, StoredCookie>();
  for (const [name, value] of Object.entries(initial ?? {})) {
    store.set(name, { value });
  }
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
  };
}

function mockFetchResponse(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

// D6 (session-expiry-tuning, 2026-09-10 amendment): the refresh route's
// POST() now reads the inbound request's ingress header (see the two tests
// at the bottom of this file); every other test just needs SOME request,
// with no ingress header, since they aren't exercising that behavior.
function makeRefreshRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/refresh", { method: "POST", headers });
}

describe("POST /api/auth/refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.mocked(cookies).mockReset();
    // The route retains a settled success for a few seconds (see the
    // late-caller tests below); drop it so tests sharing a token value stay
    // independent.
    clearAllSingleFlights();
  });

  it("returns 401 without calling the backend when there is no refresh_token cookie", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    const res = await POST(makeRefreshRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Item 4 (session-expiry-tuning review fixes): with no refresh_token, a
  // stale session_policy/session_last_active cookie pair (left over from a
  // session that has since been fully lost, e.g. a browser restart that
  // dropped a non-persistent refresh_token cookie) would otherwise keep
  // telling apiFetch/SessionKeeper "this is resumable" forever, triggering
  // doomed refresh attempts against a request that never even reaches the
  // backend. Clear all five session cookies here too, same as the
  // auth-failed branch below.
  it("clears stale session_policy/session_last_active cookies when there is no refresh_token cookie", async () => {
    const jar = makeFakeCookieJar({
      session_policy: JSON.stringify({ idleMinutes: 60, resume: true, remembered: false }),
      session_last_active: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    const res = await POST(makeRefreshRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jar.get("session_policy")).toBeUndefined();
    expect(jar.get("session_last_active")).toBeUndefined();
  });

  it("on backend success, rotates both cookies and returns 200", async () => {
    const jar = makeFakeCookieJar({ refresh_token: "old-refresh" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const newAccessToken = `${header}.${payload}.sig`;
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: newAccessToken,
        refresh_token: "new-refresh",
        token_type: "bearer",
      }),
    });

    const res = await POST(makeRefreshRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/refresh"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ refresh_token: "old-refresh" }),
      })
    );
    expect(res.status).toBe(200);
    expect(jar.get("access_token")?.value).toBe(newAccessToken);
    expect(jar.get("refresh_token")?.value).toBe("new-refresh");
    expect(jar.get("session_expires_at")?.value).toBe(String(futureExpSeconds * 1000));
  });

  it("on backend 401, clears all five session cookies and returns 401", async () => {
    const jar = makeFakeCookieJar({
      access_token: "old-access",
      refresh_token: "stale-refresh",
      session_expires_at: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ error: "invalid" }) });

    const res = await POST(makeRefreshRequest());

    expect(res.status).toBe(401);
    expect(jar.get("access_token")).toBeUndefined();
    expect(jar.get("refresh_token")).toBeUndefined();
    expect(jar.get("session_expires_at")).toBeUndefined();
  });

  it("on backend 403 (revoked token), also clears all five session cookies and returns 401", async () => {
    const jar = makeFakeCookieJar({
      access_token: "old-access",
      refresh_token: "revoked-refresh",
      session_expires_at: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 403, json: async () => ({ error: "revoked" }) });

    const res = await POST(makeRefreshRequest());

    expect(res.status).toBe(401);
    expect(jar.get("access_token")).toBeUndefined();
    expect(jar.get("refresh_token")).toBeUndefined();
    expect(jar.get("session_expires_at")).toBeUndefined();
  });

  it("on a transient backend error (500), leaves cookies intact and returns a non-401 error", async () => {
    const jar = makeFakeCookieJar({
      access_token: "old-access",
      refresh_token: "still-good-refresh",
      session_expires_at: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 500, json: async () => ({ error: "boom" }) });

    const res = await POST(makeRefreshRequest());

    // Must NOT be 401: apiFetch's client-side interceptor (lib/api.ts)
    // treats any 401 as "session is dead, bounce to /login" -- a transient
    // backend blip must not trigger that.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("old-access");
    expect(jar.get("refresh_token")?.value).toBe("still-good-refresh");
    expect(jar.get("session_expires_at")?.value).toBe("12345");
  });

  it("when the backend is unreachable (fetch rejects), returns 502 without touching cookies", async () => {
    const jar = makeFakeCookieJar({
      access_token: "old-access",
      refresh_token: "still-good-refresh",
      session_expires_at: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
    );

    const res = await POST(makeRefreshRequest());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("old-access");
    expect(jar.get("refresh_token")?.value).toBe("still-good-refresh");
    expect(jar.get("session_expires_at")?.value).toBe("12345");
  });

  // D1 (session-expiry-tuning): the backend's session_policy body passes
  // through to applySessionCookies, which writes the readable session_policy
  // cookie -- see lib/session-cookies.test.ts for that cookie's own shape
  // assertions (camelCase, non-httpOnly, 90-day maxAge).
  it("passes the backend's session_policy through to the policy cookie", async () => {
    const jar = makeFakeCookieJar({ refresh_token: "old-refresh" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const newAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: newAccessToken,
        refresh_token: "new-refresh",
        token_type: "bearer",
        session_policy: { idle_minutes: 60, resume: true, remembered: false },
      }),
    });

    await POST(makeRefreshRequest());

    expect(jar.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
    );
  });

  it("leaves the session_policy cookie untouched when the backend response has no session_policy (rollout backward-compat)", async () => {
    const jar = makeFakeCookieJar({ refresh_token: "old-refresh", session_policy: "pre-existing" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const newAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: newAccessToken,
        refresh_token: "new-refresh",
        token_type: "bearer",
      }),
    });

    await POST(makeRefreshRequest());

    expect(jar.get("session_policy")?.value).toBe("pre-existing");
  });

  // D3 (session-expiry-tuning): two concurrent POST()s presenting the SAME
  // refresh_token (two tabs restored together, or apiFetch's silent
  // recovery firing alongside SessionKeeper's own check) must share ONE
  // backend call -- rotating the same token twice trips the backend's
  // reuse-detection and revokes every token for the user. Each caller still
  // gets cookies applied to its OWN jar (a real Next.js request context per
  // call), not just the first one in.
  it("single-flights two concurrent calls presenting the same refresh_token: one backend call, every caller's own jar gets the cookies", async () => {
    const jarA = makeFakeCookieJar({ refresh_token: "shared-refresh" });
    const jarB = makeFakeCookieJar({ refresh_token: "shared-refresh" });
    vi.mocked(cookies)
      .mockImplementationOnce(async () => jarA as never)
      .mockImplementationOnce(async () => jarB as never);

    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const newAccessToken = `${header}.${payload}.sig`;
    let backendCalls = 0;
    const fetchMock = vi.fn(async () => {
      backendCalls += 1;
      return {
        ok: true,
        json: async () => ({
          access_token: newAccessToken,
          refresh_token: "new-refresh",
          token_type: "bearer",
          session_policy: { idle_minutes: 60, resume: true, remembered: false },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const [resA, resB] = await Promise.all([POST(makeRefreshRequest()), POST(makeRefreshRequest())]);

    expect(backendCalls).toBe(1);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(jarA.get("access_token")?.value).toBe(newAccessToken);
    expect(jarB.get("access_token")?.value).toBe(newAccessToken);
    expect(jarA.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
    );
    expect(jarB.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
    );
  });

  it("does NOT single-flight two concurrent calls with DIFFERENT refresh tokens: one backend call each", async () => {
    const jarA = makeFakeCookieJar({ refresh_token: "refresh-a" });
    const jarB = makeFakeCookieJar({ refresh_token: "refresh-b" });
    vi.mocked(cookies)
      .mockImplementationOnce(async () => jarA as never)
      .mockImplementationOnce(async () => jarB as never);

    const futureExpSeconds = Math.floor(Date.now() / 1000) + 900;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const accessToken = `${header}.${payload}.sig`;
    let backendCalls = 0;
    const fetchMock = vi.fn(async () => {
      backendCalls += 1;
      return {
        ok: true,
        json: async () => ({ access_token: accessToken, refresh_token: "new-refresh", token_type: "bearer" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([POST(makeRefreshRequest()), POST(makeRefreshRequest())]);

    expect(backendCalls).toBe(2);
  });

  // Refresh-token reuse (backlog #43): a second tab can reach the route just
  // AFTER the first backend call settled while still carrying the old cookie
  // (its request was sent before the first response's Set-Cookie landed). The
  // in-flight entry is gone by then, so without retention it would rotate an
  // already-rotated token and the backend would see a replay. The settled
  // success is kept for a few seconds and handed to that late caller.
  describe("late callers after the first refresh settled", () => {
    function accessToken() {
      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }),
      ).toString("base64url");
      return `${header}.${payload}.sig`;
    }

    function okBackend(refreshToken = "new-refresh") {
      const token = accessToken();
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: token,
          refresh_token: refreshToken,
          token_type: "bearer",
          session_policy: { idle_minutes: 60, resume: true, remembered: false },
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      return { fetchMock, token };
    }

    it("hands the same successor tokens to a late caller still holding the old cookie, with no second backend call", async () => {
      const jarA = makeFakeCookieJar({ refresh_token: "late-old" });
      const jarB = makeFakeCookieJar({ refresh_token: "late-old" });
      vi.mocked(cookies)
        .mockImplementationOnce(async () => jarA as never)
        .mockImplementationOnce(async () => jarB as never);
      const { fetchMock, token } = okBackend("late-new");

      const first = await POST(makeRefreshRequest());
      const second = await POST(makeRefreshRequest());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(jarB.get("access_token")?.value).toBe(token);
      expect(jarB.get("refresh_token")?.value).toBe("late-new");
    });

    it("stops handing them out after the retention window (10 s by default)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(cookies).mockImplementation(
        async () => makeFakeCookieJar({ refresh_token: "expiry-old" }) as never,
      );
      const { fetchMock } = okBackend();

      await POST(makeRefreshRequest());
      vi.advanceTimersByTime(9_999);
      await POST(makeRefreshRequest());
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await POST(makeRefreshRequest());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("REFRESH_SINGLE_FLIGHT_RETAIN_MS=0 turns retention off", async () => {
      vi.stubEnv("REFRESH_SINGLE_FLIGHT_RETAIN_MS", "0");
      vi.mocked(cookies).mockImplementation(
        async () => makeFakeCookieJar({ refresh_token: "off-old" }) as never,
      );
      const { fetchMock } = okBackend();

      await POST(makeRefreshRequest());
      await POST(makeRefreshRequest());

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("REFRESH_SINGLE_FLIGHT_RETAIN_MS sets the window, and an unusable value falls back to the default", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(cookies).mockImplementation(
        async () => makeFakeCookieJar({ refresh_token: "env-old" }) as never,
      );
      const { fetchMock } = okBackend();

      vi.stubEnv("REFRESH_SINGLE_FLIGHT_RETAIN_MS", "2000");
      await POST(makeRefreshRequest());
      vi.advanceTimersByTime(2_001);
      await POST(makeRefreshRequest());
      expect(fetchMock).toHaveBeenCalledTimes(2);

      clearAllSingleFlights();
      vi.stubEnv("REFRESH_SINGLE_FLIGHT_RETAIN_MS", "soon");
      await POST(makeRefreshRequest());
      vi.advanceTimersByTime(5_000);
      await POST(makeRefreshRequest());
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("never retains an auth failure: the next caller asks the backend again", async () => {
      vi.mocked(cookies).mockImplementation(
        async () => makeFakeCookieJar({ refresh_token: "dead-old" }) as never,
      );
      const fetchMock = mockFetchResponse({ ok: false, status: 401, json: async () => ({}) });

      const first = await POST(makeRefreshRequest());
      const second = await POST(makeRefreshRequest());

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never retains a transient backend failure: the next caller retries for real", async () => {
      vi.mocked(cookies).mockImplementation(
        async () => makeFakeCookieJar({ refresh_token: "blip-old" }) as never,
      );
      const flaky = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: accessToken(), refresh_token: "blip-new", token_type: "bearer" }),
        });
      vi.stubGlobal("fetch", flaky);

      const first = await POST(makeRefreshRequest());
      const second = await POST(makeRefreshRequest());

      expect(first.status).toBe(502);
      expect(second.status).toBe(200);
      expect(flaky).toHaveBeenCalledTimes(2);
    });
  });

  // batch-06 deploy-flip fix wave: Vercel has no trusted edge in front of
  // apps/web, so the route must NOT relay a client-supplied ingress header
  // -- even the trusted-looking value -- to the backend.
  it("does not forward the X-Compendium-Ingress header to the backend, even when the inbound request carries it", async () => {
    const jar = makeFakeCookieJar({ refresh_token: "old-refresh" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ access_token: "a.b.c", refresh_token: "new-refresh", token_type: "bearer" }),
    });

    await POST(makeRefreshRequest({ [INGRESS_HEADER]: "tailnet" }));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  it("omits the X-Compendium-Ingress header from the backend call when the inbound request has none", async () => {
    const jar = makeFakeCookieJar({ refresh_token: "old-refresh" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ access_token: "a.b.c", refresh_token: "new-refresh", token_type: "bearer" }),
    });

    await POST(makeRefreshRequest());

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  it("refuses a same-site POST before calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(new Request("https://app.test/api/auth/refresh", {
      method: "POST",
      headers: { "sec-fetch-site": "same-site", "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
