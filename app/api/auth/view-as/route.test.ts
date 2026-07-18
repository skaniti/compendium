import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";

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

describe("POST /api/auth/view-as", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("returns 401 without calling the backend when there is no access_token cookie", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    const res = await POST();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
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

    await POST();

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

    const res = await POST();

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

    const res = await POST();

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

    const res = await POST();

    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("admin-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh");
  });
});
