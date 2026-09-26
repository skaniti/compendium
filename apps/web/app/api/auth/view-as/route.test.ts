import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";
import { INGRESS_HEADER } from "@/lib/ingress";

// D5 (batch 04 auth/session parity): admin-only demo switch. Same
// route-handler test idiom as app/api/auth/refresh/route.test.ts (task-4
// brief correction #3) -- a fake cookie jar stands in for next/headers'
// cookies(), no mock of the route's own logic.

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
function makeViewAsRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/view-as", { method: "POST", headers });
}

describe("POST /api/auth/view-as", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // Task V3 item 4 fix: flipped from the pre-fix "401 without calling the
  // backend" behavior (task-V3-report.md) -- that self-imposed gate was
  // STRICTER than what the backend actually requires (its verify_api_key
  // bypasses auth entirely in dev mode), and tripped lib/api.ts's apiFetch
  // 401 -> redirect-to-/login interceptor for an admin session that
  // AUTH_REQUIRED=unset never forces through /login to begin with (so it
  // never acquires a cookie) -- live-reproduced via CDP: "view demo" as
  // admin with no cookie landed on /login, 100% reproducible. Now forwards
  // WITHOUT an Authorization header instead of self-rejecting, matching
  // app/api/[...path]/route.ts's own "inject if present" idiom -- the
  // backend's own auth policy (dev bypass, or a real 401 in production)
  // decides from here, not this route.
  it("forwards to the backend WITHOUT an Authorization header when there is no access_token cookie (backend's own auth policy decides, not this route)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeViewAsRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/view-as"),
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      })
    );
  });

  it("forwards the caller's access token as Bearer auth with profile:demo", async () => {
    const jar = makeFakeCookieJar({ access_token: "admin-access" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const demoAccessToken = `${header}.${payload}.sig`;
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: demoAccessToken,
        token_type: "bearer",
        user: { id: 2, email: "demo@example.com", name: "demo" },
      }),
    });

    await POST(makeViewAsRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/view-as"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          authorization: "Bearer admin-access",
        }),
        body: JSON.stringify({ profile: "demo" }),
      })
    );
  });

  it("on backend success, sets the NEW access_token + session_expires_at but PRESERVES the existing refresh_token cookie", async () => {
    const jar = makeFakeCookieJar({
      access_token: "admin-access",
      refresh_token: "admins-refresh",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const demoAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: demoAccessToken,
        token_type: "bearer",
        user: { id: 2, email: "demo@example.com", name: "demo" },
      }),
    });

    const res = await POST(makeViewAsRequest());

    expect(res.status).toBe(200);
    expect(jar.get("access_token")?.value).toBe(demoAccessToken);
    expect(jar.get("session_expires_at")?.value).toBe(String(futureExpSeconds * 1000));
    // Untouched -- the admin's refresh_token stays live through the acting
    // session and becomes usable again after return-to-admin.
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh");
  });

  it("on backend 403 (not admin / already acting / demo unavailable), passes through as 403 WITHOUT touching cookies", async () => {
    const jar = makeFakeCookieJar({
      access_token: "admin-access",
      refresh_token: "admins-refresh",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, status: 403, json: async () => ({ detail: "Admin role required" }) });

    const res = await POST(makeViewAsRequest());

    expect(res.status).toBe(403);
    expect(jar.get("access_token")?.value).toBe("admin-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh");
  });

  it("when the backend is unreachable, returns 502 without touching cookies", async () => {
    const jar = makeFakeCookieJar({
      access_token: "admin-access",
      refresh_token: "admins-refresh",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const res = await POST(makeViewAsRequest());

    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("admin-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh");
  });

  // D1 (session-expiry-tuning): the acting policy (resume: false) is what
  // stops SessionKeeper from ever resuming an expired acting token by
  // rotating the admin's own still-live refresh_token cookie mid-view-as.
  it("on backend success, sets the session_policy cookie from the backend's acting-as-demo policy", async () => {
    const jar = makeFakeCookieJar({ access_token: "admin-access", refresh_token: "admins-refresh" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExpSeconds })).toString("base64url");
    const demoAccessToken = `${header}.${payload}.sig`;
    mockFetchResponse({
      ok: true,
      json: async () => ({
        access_token: demoAccessToken,
        token_type: "bearer",
        user: { id: 2, email: "demo@example.com", name: "demo" },
        session_policy: { idle_minutes: 60, resume: false, remembered: false },
      }),
    });

    await POST(makeViewAsRequest());

    expect(jar.get("session_policy")?.value).toBe(
      JSON.stringify({ idleMinutes: 60, resume: false, remembered: false })
    );
  });

  // batch-06 deploy-flip fix wave: Vercel has no trusted edge in front of
  // apps/web, so the route must NOT relay a client-supplied ingress header
  // -- even the trusted-looking value -- to the backend.
  it("does not forward the X-Compendium-Ingress header to the backend, even when the inbound request carries it", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeViewAsRequest({ [INGRESS_HEADER]: "tailnet" }));

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });

  it("omits the X-Compendium-Ingress header from the backend call when the inbound request has none", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await POST(makeViewAsRequest());

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers)).not.toContain(INGRESS_HEADER);
  });
});
