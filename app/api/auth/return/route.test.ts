import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";

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

describe("POST /api/auth/return", () => {
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

    await POST();

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

    const res = await POST();

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

    const res = await POST();

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

    const res = await POST();

    expect(res.status).toBe(502);
    expect(jar.get("access_token")?.value).toBe("demo-acting-access");
    expect(jar.get("refresh_token")?.value).toBe("admins-refresh-still-here");
  });
});
