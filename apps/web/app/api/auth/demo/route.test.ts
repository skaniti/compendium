import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";
import { PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER } from "@/lib/proxy-attest";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  CHALLENGE_FAILED_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

interface StoredCookie { value: string; options?: Record<string, unknown> }

function makeFakeCookieJar() {
  const store = new Map<string, StoredCookie>();
  return {
    set(name: string, value: string, options?: Record<string, unknown>) { store.set(name, { value, options }); },
    get(name: string) { const e = store.get(name); return e ? { name, value: e.value } : undefined; },
    delete(name: string) { store.delete(name); },
    _store: store,
  };
}

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/demo", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const OK_BODY = {
  access_token: "a.b.c",
  refresh_token: "r-token",
  token_type: "bearer",
  user: { id: 2, email: "demo@test.local", name: "Demo" },
  session_policy: { remembered: false, idle_minutes: 30, resume_window_minutes: 0 },
};

describe("POST /api/auth/demo (web route)", () => {
  let jar: ReturnType<typeof makeFakeCookieJar>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const envBackup = { ...process.env };

  beforeEach(() => {
    jar = makeFakeCookieJar();
    vi.mocked(cookies).mockResolvedValue(jar as never);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.BACKEND_URL = "http://api.test.local";
    process.env.BACKEND_PROXY_SECRET = "proxy-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  it("forwards the token with attest headers and stores the session cookies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(OK_BODY), { status: 200 }));
    const res = await POST(makeReq({ turnstileToken: "tok-1" }, { "x-forwarded-for": "203.0.113.9" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: OK_BODY.user });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/demo$/);
    expect(JSON.parse(init.body as string)).toEqual({ turnstile_token: "tok-1" });
    const h = init.headers as Record<string, string>;
    expect(h[PROXY_SECRET_HEADER]).toBe("proxy-secret");
    expect(h[PROXY_CLIENT_IP_HEADER]).toBe("203.0.113.9");
    expect(jar.get("access_token")?.value).toBe("a.b.c");
    expect(jar.get("refresh_token")?.value).toBe("r-token");
    expect(jar.get("session_last_active")).toBeDefined();
  });

  it("maps 403 to the challenge copy", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: "Challenge failed" }), { status: 403 }));
    const res = await POST(makeReq({ turnstileToken: "tok-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHALLENGE_FAILED_MESSAGE });
    expect(jar._store.size).toBe(0);
  });

  it("maps 404 (entry off) to 404", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect((await POST(makeReq({ turnstileToken: "tok-1" }))).status).toBe(404);
  });

  it("maps 429 to the too-many copy", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const res = await POST(makeReq({ turnstileToken: "tok-1" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: TOO_MANY_ATTEMPTS_MESSAGE });
  });

  it("maps 503 and network errors to the unreachable copy", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    expect(await (await POST(makeReq({ turnstileToken: "tok-1" }))).json()).toEqual({ error: BACKEND_UNREACHABLE_MESSAGE });
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(makeReq({ turnstileToken: "tok-1" }));
    expect(res.status).toBe(503);
  });

  it("rejects a missing token without calling the backend", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
