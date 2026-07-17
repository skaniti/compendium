import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";

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

function mockFetchResponse(response: { ok: boolean; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("POST /api/auth/refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("returns 401 without calling the backend when there is no refresh_token cookie", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    const res = await POST();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
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

    const res = await POST();

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

  it("on backend 401, clears all three session cookies and returns 401", async () => {
    const jar = makeFakeCookieJar({
      access_token: "old-access",
      refresh_token: "stale-refresh",
      session_expires_at: "12345",
    });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    mockFetchResponse({ ok: false, json: async () => ({ error: "invalid" }) });

    const res = await POST();

    expect(res.status).toBe(401);
    expect(jar.get("access_token")).toBeUndefined();
    expect(jar.get("refresh_token")).toBeUndefined();
    expect(jar.get("session_expires_at")).toBeUndefined();
  });
});
