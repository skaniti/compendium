import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { GET } from "./route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const SECRET = "s".repeat(32);

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

function req(query: string, headers: Record<string, string> = { "tailscale-user-login": "owner@example.com" }) {
  return new Request(`http://localhost/api/auth/tailnet/login${query}`, { headers });
}

describe("GET /api/auth/tailnet/login", () => {
  let jar: ReturnType<typeof makeFakeCookieJar>;
  beforeEach(() => {
    vi.stubEnv("AUTH_REQUIRED", "1");
    vi.stubEnv("TAILNET_LOGIN", "1");
    vi.stubEnv("TAILNET_ASSERT_SECRET", SECRET);
    jar = makeFakeCookieJar();
    jar.set("trusted_browser", "browser-token");
    vi.mocked(cookies).mockResolvedValue(jar as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("signs in, sets the session cookies and redirects to next", async () => {
    const access = makeAccessToken(Math.floor(Date.now() / 1000) + 900);
    const fetchMock = mockFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ access_token: access, refresh_token: "r", session_policy: { idle_minutes: 0, resume: true, remembered: true } }),
    });
    const res = await GET(req("?next=%2Fgraph%3Fx%3D1"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/graph?x=1");
    expect(jar.get("access_token")?.value).toBe(access);
    expect(jar.get("refresh_token")?.value).toBe("r");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/auth\/tailnet\/login$/);
    expect((init.headers as Record<string, string>)["X-Compendium-Tailnet-Assert"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ tailnet_login: "owner@example.com", browser_token: "browser-token" });
  });

  it("refuses an unsafe next", async () => {
    mockFetchResponse({ ok: true, status: 200, json: async () => ({ access_token: makeAccessToken(9e9), refresh_token: "r" }) });
    const res = await GET(req("?next=%2F%2Fevil.example"));
    expect(res.headers.get("location")).toBe("/");
  });

  it("on 401 forgets the browser and lands on /login?tailnet=failed", async () => {
    mockFetchResponse({ ok: false, status: 401, json: async () => ({}) });
    const res = await GET(req("?next=%2F"));
    expect(res.headers.get("location")).toBe("/login?tailnet=failed");
    expect(jar.get("trusted_browser")).toBeUndefined();
  });

  it("on a backend error keeps the browser and lands on /login?tailnet=error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await GET(req("?next=%2F"));
    expect(res.headers.get("location")).toBe("/login?tailnet=error");
    expect(jar.get("trusted_browser")?.value).toBe("browser-token");
  });

  it("stays out while paused unless resume=1, which clears the pause", async () => {
    jar.set("tailnet_login_paused", "1");
    const fetchMock = mockFetchResponse({ ok: true, status: 200, json: async () => ({ access_token: makeAccessToken(9e9), refresh_token: "r" }) });
    expect((await GET(req("?next=%2F"))).headers.get("location")).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
    const res = await GET(req("?resume=1"));
    expect(res.headers.get("location")).toBe("/");
    expect(jar.get("tailnet_login_paused")).toBeUndefined();
  });

  it.each(["cross-site", "same-site"])("ignores resume=1 on a %s request", async (site) => {
    jar.set("tailnet_login_paused", "1");
    const fetchMock = mockFetchResponse({ ok: true, status: 200, json: async () => ({}) });
    const res = await GET(req("?resume=1", { "tailscale-user-login": "owner@example.com", "sec-fetch-site": site }));
    expect(res.headers.get("location")).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jar.get("tailnet_login_paused")).toBeDefined();
  });

  it.each(["same-origin", "none"])("honours resume=1 when Sec-Fetch-Site is %s", async (site) => {
    jar.set("tailnet_login_paused", "1");
    mockFetchResponse({ ok: true, status: 200, json: async () => ({ access_token: makeAccessToken(9e9), refresh_token: "r" }) });
    const res = await GET(req("?resume=1", { "tailscale-user-login": "owner@example.com", "sec-fetch-site": site }));
    expect(res.headers.get("location")).toBe("/");
    expect(jar.get("tailnet_login_paused")).toBeUndefined();
  });

  it.each([
    ["no header", {}],
    ["via Cloudflare", { "tailscale-user-login": "owner@example.com", "cf-connecting-ip": "203.0.113.9" }],
  ])("sends %s to /login without calling the API", async (_l, headers) => {
    const fetchMock = mockFetchResponse({ ok: true, status: 200, json: async () => ({}) });
    const res = await GET(req("?next=%2F", headers as Record<string, string>));
    expect(res.headers.get("location")).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a browser without a trusted cookie to /login", async () => {
    jar.delete("trusted_browser");
    const res = await GET(req("?next=%2F"));
    expect(res.headers.get("location")).toBe("/login");
  });
});
