import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { POST } from "./route";

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

function makeLoginRequest(body: { email: string; password: string }): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
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
    expect(body.error).toBe("Invalid credentials.");
    expect(jar.get("access_token")).toBeUndefined();
  });
});
