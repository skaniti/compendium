import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";

// D2 correction #2 (batch 04 auth/session parity): logout now revokes the
// refresh_token server-side (best-effort -- clear cookies regardless of the
// backend's response) before clearing both HttpOnly cookies plus the
// readable expiry cookie.

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

describe("POST /api/auth/logout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("POSTs the refresh_token to the backend for revocation when the cookie exists", async () => {
    const jar = makeFakeCookieJar({ access_token: "a", refresh_token: "r", session_expires_at: "123" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/logout"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ refresh_token: "r" }),
      })
    );
    expect(res.status).toBe(200);
    expect(jar.get("access_token")).toBeUndefined();
    expect(jar.get("refresh_token")).toBeUndefined();
    expect(jar.get("session_expires_at")).toBeUndefined();
  });

  it("does not call the backend when there is no refresh_token cookie, and still clears cookies", async () => {
    const jar = makeFakeCookieJar({ access_token: "a" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(jar.get("access_token")).toBeUndefined();
  });

  it("clears cookies even when the backend revocation call fails (best-effort)", async () => {
    const jar = makeFakeCookieJar({ access_token: "a", refresh_token: "r" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(jar.get("access_token")).toBeUndefined();
    expect(jar.get("refresh_token")).toBeUndefined();
  });

  it("pauses automatic tailnet sign-in when this browser is trusted", async () => {
    const jar = makeFakeCookieJar({ trusted_browser: "bt" });
    vi.mocked(cookies).mockResolvedValue(jar as never);
    await POST();
    expect(jar.get("tailnet_login_paused")?.value).toBe("1");
    expect(jar.get("trusted_browser")?.value).toBe("bt");
  });

  it("sets no pause for a browser that is not trusted", async () => {
    const jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    await POST();
    expect(jar.get("tailnet_login_paused")).toBeUndefined();
  });
});
