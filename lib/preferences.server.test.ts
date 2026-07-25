import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import {
  getInitialCompendiumLoaderSeen,
  getInitialPanelWidths,
  getInitialSessionRole,
  getInitialStarfieldVariant,
} from "./preferences.server";

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

// react's `cache()` only memoizes inside a real React Server Component
// render pass (a per-request cache the RSC runtime sets up) -- the plain
// client "react" package Vitest resolves here is a pure passthrough (no
// memoization at all, verified against node_modules/react/cjs directly).
// So this module's own dedup can't be observed by calling its exported
// functions directly in this test file the way it behaves in production;
// instead, mock `cache` with a real per-argument memoizer for these tests
// only, which lets us verify that lib/preferences.server.ts actually wires
// its three preferences readers through ONE shared cache() call (the thing
// that matters for correctness) independent of react's real runtime
// behavior, which is out of this module's control either way.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <Args extends unknown[], R>(fn: (...args: Args) => R) => {
      const store = new Map<string, R>();
      return ((...args: Args) => {
        const key = JSON.stringify(args);
        if (!store.has(key)) store.set(key, fn(...args));
        return store.get(key) as R;
      }) as typeof fn;
    },
  };
});

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

describe("preferences fetch deduplication (React.cache)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // Each test below uses its own unique token so the mocked cache()'s Map
  // (module-scoped, created once when preferences.server.ts's top-level
  // `cache(...)` call runs) can't accidentally serve one test's cached
  // response to another.

  it("shares a single backend fetch across getInitialPanelWidths, getInitialStarfieldVariant, and getInitialCompendiumLoaderSeen for the same token", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "dedup-token-1" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        panel_left_width: "24%",
        panel_right_width: "18%",
        starfield: "pan",
        compendium_loader_seen: true,
      }),
    });

    await Promise.all([
      getInitialPanelWidths(),
      getInitialStarfieldVariant(),
      getInitialCompendiumLoaderSeen(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/preferences"),
      expect.objectContaining({ headers: { authorization: "Bearer dedup-token-1" } })
    );
  });

  it("still returns each reader's own fields correctly off the shared fetch", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "dedup-token-2" }) as never);
    mockFetchResponse({
      ok: true,
      json: async () => ({
        panel_left_width: "30%",
        panel_right_width: "15%",
        starfield: "hyperspace",
        compendium_loader_seen: true,
      }),
    });

    const [panels, starfield, loaderSeen] = await Promise.all([
      getInitialPanelWidths(),
      getInitialStarfieldVariant(),
      getInitialCompendiumLoaderSeen(),
    ]);

    expect(panels).toEqual({ panelLeftWidth: "30%", panelRightWidth: "15%" });
    expect(starfield).toBe("hyperspace");
    expect(loaderSeen).toEqual({ hasSeen: true, canPersist: true });
  });

  it("does not share a cached fetch across two DIFFERENT tokens", async () => {
    vi.mocked(cookies).mockResolvedValueOnce(makeFakeCookieJar({ access_token: "dedup-token-3a" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ starfield: "none" }),
    });

    await getInitialStarfieldVariant();

    vi.mocked(cookies).mockResolvedValueOnce(makeFakeCookieJar({ access_token: "dedup-token-3b" }) as never);
    await getInitialStarfieldVariant();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still falls back to each reader's own default when the shared fetch is not ok, without caching a false canPersist across a later non-object body", async () => {
    // Regression for a shortcut that would have collapsed
    // getInitialCompendiumLoaderSeen's ok-but-non-object-body branch
    // (canPersist: true) into the same bucket as a non-ok response
    // (canPersist: false) -- the shared fetcher must keep these
    // distinguishable even though it now backs three call sites.
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "dedup-token-4" }) as never);
    mockFetchResponse({ ok: true, json: async () => ["not", "an", "object"] });

    const [panels, starfield, loaderSeen] = await Promise.all([
      getInitialPanelWidths(),
      getInitialStarfieldVariant(),
      getInitialCompendiumLoaderSeen(),
    ]);

    expect(panels).toEqual({});
    expect(starfield).toBe("twinkle");
    expect(loaderSeen).toEqual({ hasSeen: false, canPersist: true });
  });
});
