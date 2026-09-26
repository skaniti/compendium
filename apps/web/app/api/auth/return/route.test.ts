import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";
import { INGRESS_HEADER } from "@/lib/ingress";

// D5 (batch 04 auth/session parity): the return-to-admin route. Same
// route-handler test idiom as app/api/auth/refresh/route.test.ts.

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

// D6 (session-expiry-tuning, 2026-09-10 amendment): the route now reads the
// inbound request's ingress header (see the two tests at the bottom of this
// file); every other test just needs SOME request, with no ingress header.
function makeReturnRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/return", { method: "POST", headers });
}

describe("POST /api/auth/return", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // Task V3 item 4 fix: same flip as the sibling /api/auth/view-as route's
  // own test (see that file's own comment for the full root-cause
  // writeup) -- forwards WITHOUT an Authorization header instead of
  // self-rejecting with 401, matching app/api/[...path]/route.ts's own
  // "inject if present" idiom.
  it("forwards to the backend WITHOUT an Authorization header when there is no access_token cookie (backend's own auth policy decides, not this route)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeReturnRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/return-to-admin"),
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      })
    );
  });

  it("forwards the caller's (acting) access token as Bearer auth to return-to-admin", async () => {
    const jar = makeFakeCookieJar({ access_token: "demo-acting-access" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const adminAccessToken = `${header}.${payload}.sig`;
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: adminAccessToken,
        token_type: "bearer",
        user: { id: 1, email: "admin@example.com", name: "admin" },
      }),
    });

    await POST(makeReturnRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/return-to-admin"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer demo-acting-access" }),
      })
    );
  });

  it("on backend success, sets the NEW (admin) access_token + session_expires_at but PRESERVES the existing refresh_token cookie", async () => {
    const jar = makeFakeCookieJar({
      access_token: "demo-acting-access",
      refresh_token: "admins-refresh-still-here",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const adminAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: adminAccessToken,
        token_type: "bearer",
        user: { id: 1, email: "admin@example.com", name: "admin" },
      }),
    });

    const res = await POST(makeReturnRequest());

    expect(res.status).toBe(200);
    expect(jar.get("access_token")?.value).toBe(adminAccessToken);
    expect(jar.get("session_expires_at")?.value).toBe(String(futureExpSeconds * 1000));
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh-still-here");
  });

  it("on backend 403 (not currently acting / demoted origin admin), passes through as 403 WITHOUT touching cookies", async () => {
    const jar = makeFakeCookieJar({
      access_token: "demo-acting-access",
      refresh_token: "admins-refresh-still-here",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 403, json: async () => ({ detail: "Not currently viewing as demo" }) });

    const res = await POST(makeReturnRequest());

    expect(res.status).toBe(403);
    expect(jar.get("access_token")?.value).toBe("demo-acting-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh-still-here");
  });

  it("when the backend is unreachable, returns 502 without touching cookies", async () => {
    const jar = makeFakeCookieJar({
      access_token: "demo-acting-access",
      refresh_token: "admins-refresh-still-here",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const res = await POST(makeReturnRequest());

    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("demo-acting-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh-still-here");
  });

  // D1 (session-expiry-tuning): the backend returns the default admin
  // policy here (it can't know from this endpoint whether the underlying
  // refresh token was ever marked remembered -- see route.ts's own comment)
  // -- this pins that the response's session_policy, whatever it is, still
  // makes it into the cookie the same way every other route does.
  it("on backend success, sets the session_policy cookie from the backend's response", async () => {
    const jar = makeFakeCookieJar({ access_token: "demo-acting-access", refresh_token: "admins-refresh-still-here" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const adminAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: adminAccessToken,
        token_type: "bearer",
        user: { id: 1, email: "admin@example.com", name: "admin" },
        session_policy: { idle_minutes: 60, resume: true, remembered: false },
      }),
    });

    await POST(makeReturnRequest());

    expect(jar.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 60, resume: true, remembered: false })
    );
  });

  // batch-06 deploy-flip fix wave: Vercel has no trusted edge in front of
  // apps/web, so the route must NOT relay a client-supplied ingress header
  // -- even the trusted-looking value -- to the backend.
  it("does not forward the X-Compendium-Ingress header to the backend, even when the inbound request carries it", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeReturnRequest({ [INGRESS_HEADER]: "tailnet" }));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  it("omits the X-Compendium-Ingress header from the backend call when the inbound request has none", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeReturnRequest());

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });
});
