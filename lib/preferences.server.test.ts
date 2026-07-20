import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { getInitialSessionRole } from "./preferences.server";

// Gate-2 walkthrough fix 3: AppShell's new server-side session read, used to
// force CompendiumLoader into "return" mode for the demo role (Dash never
// serves first-run to demo, direct or admin-launched-acting) and to skip a
// pointless preferences PATCH for a plain (non-acting) demo session. Same
// vi.mock("next/headers") + fake cookie jar idiom as the route-handler tests
// (app/api/auth/return/route.test.ts, etc.) -- this module runs server-side
// too (next/headers's cookies()), even though it isn't a route handler.

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

function makeFakeCookieJar(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    get(name: string) {
      const value = store.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  };
}

function mockFetchResponse(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("getInitialSessionRole", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("returns {role: null, actingAsDemo: false} without calling the backend when there is no access_token cookie", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({ ok: true, json: async () => ({}) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the access token as Bearer auth to GET /api/auth/me", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "admin-access" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ id: 1, role: "admin", acting_as_demo: false }),
    });

    await getInitialSessionRole();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/me"),
      expect.objectContaining({ headers: { authorization: "Bearer admin-access" } })
    );
  });

  it("maps an admin session (not acting)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 1, role: "admin", acting_as_demo: false }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "admin", actingAsDemo: false });
  });

  it("maps an admin-launched acting-as-demo session", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({
      ok: true,
      json: async () => ({ id: 2, role: "demo", acting_as_demo: true, admin_origin_email: "admin@example.com" }),
    });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "demo", actingAsDemo: true });
  });

  it("maps a plain (direct login) demo session", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 2, role: "demo", acting_as_demo: false }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "demo", actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} on a non-ok response", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ detail: "Unauthorized" }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} when fetch itself rejects", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
    );

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} when the body isn't a JSON object", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({ ok: true, json: async () => ["not", "an", "object"] });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("treats an unrecognized role string as null but still reads acting_as_demo faithfully", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "t" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 1, role: "superuser", acting_as_demo: true }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: true });
  });
});
