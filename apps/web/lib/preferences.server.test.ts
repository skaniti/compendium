import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import {
  getInitialCompendiumLoaderSeen,
  getInitialPanelWidths,
  getInitialSessionRole,
  getInitialStarfieldVariant,
  getInitialThemeVariant,
  getInitialTimeWindow,
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

  // Sibling fix to the getInitialPanelWidths/getInitialCompendiumLoaderSeen
  // cookie-gate fixes above: this used to short-circuit to
  // {role: null, actingAsDemo: false} whenever `token` was absent, so a
  // cookie-less dev session (AUTH_REQUIRED unset, no forced /login) never
  // even attempted the read that would have resolved its real role --
  // same root cause and same fix shape (fetchMeRow now only conditionally
  // adds the Authorization header, mirroring fetchPreferencesRow's
  // "inject if present" idiom, instead of requiring a token up front).
  it("attempts the backend WITHOUT an Authorization header when there is no access_token cookie, and returns the resolved identity if the backend allows it (dev-mode auth bypass)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ id: 1, role: "user", acting_as_demo: false }),
    });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "user", actingAsDemo: false });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/me"),
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      })
    );
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
    // Unique token per test below -- fetchMeRow is now memoized by token via
    // the mocked react.cache() (see that mock's own comment above), so
    // reusing a token across tests in this describe block would silently
    // serve one test's cached fetch response to the next.
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-1" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 1, role: "admin", acting_as_demo: false }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "admin", actingAsDemo: false });
  });

  it("maps an admin-launched acting-as-demo session", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-2" }) as never);
    mockFetchResponse({
      ok: true,
      json: async () => ({ id: 2, role: "demo", acting_as_demo: true, admin_origin_email: "admin@example.com" }),
    });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "demo", actingAsDemo: true });
  });

  it("maps a plain (direct login) demo session", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-3" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 2, role: "demo", acting_as_demo: false }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: "demo", actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} on a non-ok response", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-4" }) as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ detail: "Unauthorized" }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} when fetch itself rejects", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-5" }) as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
    );

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("falls back to {role: null, actingAsDemo: false} when the body isn't a JSON object", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-6" }) as never);
    mockFetchResponse({ ok: true, json: async () => ["not", "an", "object"] });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: false });
  });

  it("treats an unrecognized role string as null but still reads acting_as_demo faithfully", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "role-token-7" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ id: 1, role: "superuser", acting_as_demo: true }) });

    await expect(getInitialSessionRole()).resolves.toEqual({ role: null, actingAsDemo: true });
  });
});

describe("getInitialSessionRole (React.cache dedup)", () => {
  // app/layout.tsx (canPersist seed for ThemeProvider) and AppShell.tsx
  // (canPersist seed for StarfieldProvider/PanelGrid, plus the existing
  // CompendiumLoader force-return-mode logic) both call
  // getInitialSessionRole() in the SAME server render pass -- without
  // wrapping the underlying /api/auth/me fetch in cache(), that's two
  // redundant round-trips per page load instead of one. Same per-token
  // memoization idiom as fetchPreferencesRow above (mocked react.cache()
  // real per-argument memoizer; see that mock's own comment).
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("shares a single backend fetch across multiple getInitialSessionRole calls for the same token", async () => {
    vi.mocked(cookies).mockResolvedValue(
      makeFakeCookieJar({ access_token: "role-dedup-token-1" }) as never
    );
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ id: 1, role: "admin", acting_as_demo: false }),
    });

    await Promise.all([getInitialSessionRole(), getInitialSessionRole()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/me"),
      expect.objectContaining({ headers: { authorization: "Bearer role-dedup-token-1" } })
    );
  });

  it("does not share a cached fetch across two DIFFERENT tokens", async () => {
    vi.mocked(cookies).mockResolvedValueOnce(
      makeFakeCookieJar({ access_token: "role-dedup-token-2a" }) as never
    );
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ id: 1, role: "user", acting_as_demo: false }),
    });

    await getInitialSessionRole();

    vi.mocked(cookies).mockResolvedValueOnce(
      makeFakeCookieJar({ access_token: "role-dedup-token-2b" }) as never
    );
    await getInitialSessionRole();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getInitialThemeVariant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // Sibling fix to getInitialPanelWidths/getInitialCompendiumLoaderSeen: this
  // used to short-circuit to null whenever `token` was absent instead of
  // attempting the read (same root cause, same fix shape -- see those two
  // readers' own comments in lib/preferences.server.ts). The no-cookie
  // discriminating test lives in the "getInitialPanelWidths" describe block
  // below, NOT here -- fetchPreferencesRow's mocked cache (this file's own
  // top comment) is keyed by token, and a bare no-cookie call here would
  // collide with (and be shadowed by) that block's own no-cookie test
  // (same token=undefined key, same shared cache) rather than exercising an
  // independent fetch.

  it("returns the normalized, validated theme name from the preferences row", async () => {
    // Unique token per test below -- fetchPreferencesRow is memoized by
    // token via the mocked react.cache() (see that mock's own comment
    // above), so reusing a token across tests in this describe block would
    // silently serve one test's cached fetch response to the next.
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-1" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ theme: "Purple" }) });

    await expect(getInitialThemeVariant()).resolves.toBe("Purple");
  });

  it("normalizes a legacy ' Dark'-suffixed theme name", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-2" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ theme: "Purple Dark" }) });

    await expect(getInitialThemeVariant()).resolves.toBe("Purple");
  });

  it("returns null when the theme value doesn't match any known palette", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-3" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ theme: "not-a-real-palette-!!" }) });

    await expect(getInitialThemeVariant()).resolves.toBeNull();
  });

  it("returns null when the response is not ok", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-4" }) as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ detail: "Unauthorized" }) });

    await expect(getInitialThemeVariant()).resolves.toBeNull();
  });

  it("returns null when the body isn't a JSON object", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-5" }) as never);
    mockFetchResponse({ ok: true, json: async () => ["not", "an", "object"] });

    await expect(getInitialThemeVariant()).resolves.toBeNull();
  });

  it("returns null when the theme field is missing", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "theme-token-6" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({}) });

    await expect(getInitialThemeVariant()).resolves.toBeNull();
  });
});

// Task V3 item 5 fix: root-caused "panel width not restored after hard
// refresh" (task-V3-report.md) to this function's own pre-fix
// `if (!token) return {};` short-circuit -- the ONLY of the five
// getInitialX readers in this module lacking any dedicated no-cookie test
// before this fix landed, matching the coverage gap that let the bug slip
// through. hooks/usePanelResize.ts's own mouseup PATCH was ALREADY
// persisting panel_left_width/panel_right_width correctly without a
// cookie (live-verified via CDP) -- the bug was entirely on this read
// side, discarding an already-saved drag on every load.
describe("getInitialPanelWidths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("attempts the backend WITHOUT an Authorization header when there is no access_token cookie, and returns the persisted widths if the backend allows it (dev-mode auth bypass)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar() as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      // V3 fix-round (coordinator review after item 3), extended by the
      // starfield/theme sibling fix: also carries compendium_loader_seen,
      // starfield, and theme so this SAME shared, no-cookie fetch can
      // double as getInitialCompendiumLoaderSeen/getInitialStarfieldVariant/
      // getInitialThemeVariant's own no-cookie discriminating tests below --
      // fetchPreferencesRow's mocked cache (this file's own top comment) is
      // keyed by token, and token is undefined for every no-cookie call
      // regardless of which reader makes it, so a SEPARATE no-cookie test
      // for any of those readers would silently collide with (and be
      // shadowed by) THIS test's own cached entry rather than exercising an
      // independent fetch.
      json: async () => ({
        panel_left_width: "32%",
        panel_right_width: "20%",
        compendium_loader_seen: true,
        starfield: "pan",
        theme: "Purple",
      }),
    });

    await expect(getInitialPanelWidths()).resolves.toEqual({
      panelLeftWidth: "32%",
      panelRightWidth: "20%",
    });
    // Same shared fetch, same no-cookie request -- getInitialCompendiumLoaderSeen
    // (V3 fix-round fix) now also resolves the real persisted value instead
    // of the pre-fix {hasSeen:false, canPersist:false} short-circuit.
    await expect(getInitialCompendiumLoaderSeen()).resolves.toEqual({
      hasSeen: true,
      canPersist: true,
    });
    // Sibling fix: getInitialStarfieldVariant/getInitialThemeVariant used to
    // short-circuit to their own defaults (DEFAULT_STARFIELD_VARIANT / null)
    // whenever `token` was absent, discarding a cookie-less dev session's
    // real persisted values on every load, same class of bug as the two
    // reads above.
    await expect(getInitialStarfieldVariant()).resolves.toBe("pan");
    await expect(getInitialThemeVariant()).resolves.toBe("Purple");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/preferences"),
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      })
    );
  });

  it("forwards the caller's access token as Bearer auth when a cookie is present (unchanged from before this fix)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "panel-token-1" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ panel_left_width: "35%", panel_right_width: "22%" }),
    });

    await expect(getInitialPanelWidths()).resolves.toEqual({
      panelLeftWidth: "35%",
      panelRightWidth: "22%",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/preferences"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer panel-token-1" }) })
    );
  });
});

// V3 fix-round (coordinator review after item 3): same class of bug as
// getInitialPanelWidths (item 5) -- a cookie-less dev session still has a
// real, persisted compendium_loader_seen value on the backend row, but
// this function used to discard it unconditionally, forcing first-run to
// replay on EVERY refresh for such a session (independent of item 3's
// vendor-side onFirstPaint fix, a separate bug) and leaving canPersist
// false so the dismiss-time persist write never even attempted. The
// no-cookie discriminating test lives in the "preferences fetch
// deduplication" describe block below, NOT here -- fetchPreferencesRow's
// mocked cache (this file's own top comment) is keyed by token, and a
// bare no-cookie call here would collide with getInitialPanelWidths's own
// no-cookie test (same token=undefined key, same shared cache) rather
// than exercising an independent fetch; testing both readers together
// against ONE shared no-cookie fetch is the architecturally correct
// (and simpler) way to cover this, matching that describe block's own
// existing "shares a single backend fetch... for the same token" pattern.
describe("getInitialCompendiumLoaderSeen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  it("forwards the caller's access token as Bearer auth when a cookie is present (unchanged from before this fix)", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "loader-token-1" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({ compendium_loader_seen: false }),
    });

    await expect(getInitialCompendiumLoaderSeen()).resolves.toEqual({
      hasSeen: false,
      canPersist: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/preferences"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer loader-token-1" }) })
    );
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

  it("shares a single backend fetch across getInitialPanelWidths, getInitialStarfieldVariant, getInitialCompendiumLoaderSeen, and getInitialThemeVariant for the same token", async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "dedup-token-1" }) as never);
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        panel_left_width: "24%",
        panel_right_width: "18%",
        starfield: "pan",
        compendium_loader_seen: true,
        theme: "Purple",
      }),
    });

    await Promise.all([
      getInitialPanelWidths(),
      getInitialStarfieldVariant(),
      getInitialCompendiumLoaderSeen(),
      getInitialThemeVariant(),
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
        theme: "Teal",
      }),
    });

    const [panels, starfield, loaderSeen, theme] = await Promise.all([
      getInitialPanelWidths(),
      getInitialStarfieldVariant(),
      getInitialCompendiumLoaderSeen(),
      getInitialThemeVariant(),
    ]);

    expect(panels).toEqual({ panelLeftWidth: "30%", panelRightWidth: "15%" });
    expect(starfield).toBe("hyperspace");
    expect(loaderSeen).toEqual({ hasSeen: true, canPersist: true });
    expect(theme).toBe("Teal");
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

describe("getInitialTimeWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(cookies).mockReset();
  });

  // Unique token per test: fetchPreferencesRow is memoized by token (see the
  // mocked cache() above).
  it.each(["7", "30", "90", "all"])("returns the persisted %s window", async (tw) => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: `tw-token-${tw}` }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ time_window: tw }) });
    await expect(getInitialTimeWindow()).resolves.toBe(tw);
  });

  it('falls back to "all" for an unknown value', async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "tw-token-bad" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({ time_window: "365" }) });
    await expect(getInitialTimeWindow()).resolves.toBe("all");
  });

  it('falls back to "all" when the field is missing', async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "tw-token-missing" }) as never);
    mockFetchResponse({ ok: true, json: async () => ({}) });
    await expect(getInitialTimeWindow()).resolves.toBe("all");
  });

  it('falls back to "all" when the response is not ok', async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "tw-token-401" }) as never);
    mockFetchResponse({ ok: false, status: 401, json: async () => ({ detail: "Unauthorized" }) });
    await expect(getInitialTimeWindow()).resolves.toBe("all");
  });

  it('falls back to "all" when the body is not an object', async () => {
    vi.mocked(cookies).mockResolvedValue(makeFakeCookieJar({ access_token: "tw-token-arr" }) as never);
    mockFetchResponse({ ok: true, json: async () => ["x"] });
    await expect(getInitialTimeWindow()).resolves.toBe("all");
  });
});
