import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import SessionProvider, { HYDRATION_RETRY_MS, useSession } from "./SessionProvider";
import Header from "./Header";
import * as api from "@/lib/api";
import * as ThemeProviderModule from "./ThemeProvider";
import * as StarfieldProviderModule from "./StarfieldProvider";

// D4/D5 (batch 04 auth/session parity): useSession() context, hydrated from
// GET /api/auth/me via apiFetch (established mock convention -- see
// lib/api.test.ts, components/SessionKeeper.test.tsx). Header consumes the
// context directly now (no more of its own fetch) for `account` and to host
// SettingsMenu -- the admin/demo view-as/return-to-admin role-gating matrix
// that used to live (and get tested) here moved into GraphPlaceholder (gate
// 2 walkthrough fix 2, Dash parity: the graph-canvas debug overlay), so
// that gating coverage now lives in GraphPlaceholder.test.tsx instead. What
// remains here is SessionKeeper suspension wiring, which only needs SOME
// useSession() consumer in the tree -- Header still qualifies.

const CHECK_INTERVAL_MS = 60_000;
const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";

function setSessionExpiresAtCookie(epochMs: number) {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=${epochMs}; path=/`;
}

// Named for what it actually clears (fix-round minor: the old name
// "clearAllCookies" overclaimed -- this file only ever sets/reads
// session_expires_at).
function clearSessionExpiresAtCookie() {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Routes apiFetch calls by URL: /api/auth/me gets `meBody`, anything else
// (SessionKeeper's /api/auth/refresh) gets a generic 200 -- lets a single
// mock cover both SessionProvider's own hydration call and the
// SessionKeeper it mounts internally.
function mockApiFetch(meBody: unknown, meStatus = 200) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/me")) return jsonResponse(meBody, meStatus);
    return jsonResponse({ ok: true });
  });
}

function Consumer() {
  const { role, account, actingAsDemo, adminOriginEmail } = useSession();
  return (
    <div>
      <span data-testid="role">{role ?? "null"}</span>
      <span data-testid="account">{account}</span>
      <span data-testid="acting">{String(actingAsDemo)}</span>
      <span data-testid="origin-email">{adminOriginEmail ?? ""}</span>
    </div>
  );
}

describe("SessionProvider / useSession", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearSessionExpiresAtCookie();
  });

  // Regression guard: SessionProvider wraps the ENTIRE app in app/layout.tsx
  // (including /login, which renders no AppShell/Header and so has no
  // useSession() consumer at all). If hydration fired there anyway, a
  // genuinely unauthenticated prod-mode visit would get a 401 from
  // /api/auth/me, and apiFetch's interceptor would window.location.assign
  // ("/login") -- an immediate reload loop on the page the user is already
  // on. proxy.ts treats "/login" as the same kind of exempt route for the
  // same reason (see its own comment on redirect-loop guarding).
  it("does not call apiFetch on the /login route", async () => {
    vi.stubGlobal("location", { ...window.location, pathname: "/login" });
    const fetchMock = mockApiFetch({ error: "unauthorized" }, 401);

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the pre-resolution placeholder (…) synchronously, before the /me fetch settles", () => {
    // Deliberately never resolves during this test -- isolates the
    // synchronous initial render from the async hydration path covered by
    // every other test here. Mirrors Header's own pre-context behavior
    // (frontend/dash/app.py:2918-2919: "…" pre-resolution, "—" once
    // resolved with no username/email).
    vi.spyOn(api, "apiFetch").mockImplementation(() => new Promise(() => {}));

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    expect(screen.getByTestId("account")).toHaveTextContent("…");
  });

  it("hydrates role/account/actingAsDemo from GET /api/auth/me", async () => {
    mockApiFetch({ id: 1, email: "admin@example.com", name: "Admin", role: "admin", acting_as_demo: false });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("admin"));
    expect(screen.getByTestId("account")).toHaveTextContent("Admin");
    expect(screen.getByTestId("acting")).toHaveTextContent("false");
  });

  it("falls back to email when name is absent (Header's original fallback chain)", async () => {
    mockApiFetch({ id: 1, email: "user@example.com", role: "user", acting_as_demo: false });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent("user@example.com"));
  });

  it("surfaces adminOriginEmail when acting as demo", async () => {
    mockApiFetch({
      id: 2,
      email: "demo@example.com",
      role: "demo",
      acting_as_demo: true,
      admin_origin_email: "admin@example.com",
    });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("acting")).toHaveTextContent("true"));
    expect(screen.getByTestId("origin-email")).toHaveTextContent("admin@example.com");
  });

  // View-as provenance marker: acting_as_demo=true means /me returned the
  // DEMO user's own row -- without a suffix, an acting admin is
  // indistinguishable in the header from a plain demo login.
  it("appends \" (admin)\" to the account label while acting as demo", async () => {
    mockApiFetch({
      id: 2,
      email: "demo@example.com",
      name: "demo",
      role: "demo",
      acting_as_demo: true,
      admin_origin_email: "admin@example.com",
    });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("acting")).toHaveTextContent("true"));
    expect(screen.getByTestId("account")).toHaveTextContent("demo (admin)");
  });

  it("does not append the admin suffix for a plain (non-acting) session", async () => {
    mockApiFetch({ id: 2, email: "demo@example.com", name: "demo", role: "demo", acting_as_demo: false });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("acting")).toHaveTextContent("false"));
    expect(screen.getByTestId("account")).toHaveTextContent("demo");
    expect(screen.getByTestId("account")).not.toHaveTextContent("(admin)");
  });

  it("signed-out default is safe when apiFetch resolves non-ok (e.g. 401)", async () => {
    mockApiFetch({ error: "unauthorized" }, 401);

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("null"));
    expect(screen.getByTestId("account")).toHaveTextContent("—");
    expect(screen.getByTestId("acting")).toHaveTextContent("false");
  });

  it("signed-out default is safe when apiFetch rejects (network/backend down)", async () => {
    vi.spyOn(api, "apiFetch").mockRejectedValue(new Error("network down"));

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("null"));
    expect(screen.getByTestId("account")).toHaveTextContent("—");
  });

  it("signed-out default is safe when the response body isn't an object", async () => {
    vi.spyOn(api, "apiFetch").mockResolvedValue(jsonResponse(["not", "an", "object"]));

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("null"));
  });

  it("treats an unrecognized role string as the signed-out default rather than trusting it", async () => {
    mockApiFetch({ id: 1, email: "x@example.com", role: "superuser", acting_as_demo: false });

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>
    );

    // Wait for hydration to actually complete (account resolves from the
    // fetch) before asserting role stayed null -- otherwise this could
    // pass trivially on the pre-hydration render.
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent("x@example.com"));
    expect(screen.getByTestId("role")).toHaveTextContent("null");
  });

  it("refresh() re-fetches and updates state", async () => {
    const spy = mockApiFetch({ id: 1, email: "a@example.com", role: "user", acting_as_demo: false });

    function RefreshConsumer() {
      const { account, refresh } = useSession();
      return (
        <div>
          <span data-testid="account">{account}</span>
          <button onClick={() => void refresh()}>refresh</button>
        </div>
      );
    }

    render(
      <SessionProvider>
        <RefreshConsumer />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent("a@example.com"));

    spy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/me")) {
        return jsonResponse({ id: 1, email: "a@example.com", name: "Renamed", role: "admin", acting_as_demo: false });
      }
      return jsonResponse({ ok: true });
    });

    await act(async () => {
      screen.getByText("refresh").click();
    });

    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent("Renamed"));
  });

  it("useSession throws when called outside a SessionProvider", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useSession();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/SessionProvider/);
    errSpy.mockRestore();
  });
});

describe("Header + session wiring (via SessionProvider)", () => {
  // Header renders SettingsMenu, which consumes useTheme()/useStarfield()
  // directly -- same mocking convention SettingsMenu.test.tsx already
  // established (mock the hooks rather than standing up real
  // ThemeProvider/StarfieldProvider, which need their own DOM/preferences
  // setup unrelated to what these tests actually exercise).
  beforeEach(() => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({ variant: "Green", setVariant: vi.fn() });
    vi.spyOn(StarfieldProviderModule, "useStarfield").mockReturnValue({ variant: "twinkle", setVariant: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearSessionExpiresAtCookie();
  });

  // Wiring regression guard (design decision 2): SessionProvider mounts
  // SessionKeeper internally with suspended={actingAsDemo}. An
  // acting-as-demo access token is deliberately non-renewable (60-min hard
  // cap, view-as never issues a refresh_token) -- if SessionKeeper's
  // sliding refresh ran anyway, its rotation would mint a fresh admin
  // token pair and silently resurrect the admin identity mid-view-as. This
  // proves the prop actually reaches SessionKeeper via context, not just
  // that SessionKeeper's own suspended-prop unit tests pass in isolation.
  it("suspension wiring: acting_as_demo=true reaches SessionKeeper, so it never refreshes even near expiry with recent activity", async () => {
    vi.useFakeTimers();
    // Cookie starts far from expiry so SessionKeeper's mount-time immediate
    // check (which fires before SessionProvider's async hydration settles,
    // while suspended is still the initial `false`) is a no-op regardless
    // of suspension -- isolates this test to the periodic-check path,
    // mirroring SessionKeeper.test.tsx's own established pattern.
    setSessionExpiresAtCookie(Date.now() + 90 * 60_000);
    const fetchMock = mockApiFetch({
      id: 2,
      email: "demo@example.com",
      role: "demo",
      acting_as_demo: true,
      admin_origin_email: "admin@example.com",
    });

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    // Let hydration settle (actingAsDemo -> true propagates into
    // SessionKeeper's suspended prop) before the token nears expiry.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      setSessionExpiresAtCookie(Date.now() + 2 * 60_000); // now near expiry
      window.dispatchEvent(new Event("pointerdown")); // recent activity
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // periodic tick
    });

    const refreshCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as RequestInfo | URL).toString();
      return url.includes("/api/auth/refresh");
    });
    expect(refreshCalls).toHaveLength(0);
  });

  it("suspension wiring positive control: acting_as_demo=false DOES refresh under the same conditions", async () => {
    vi.useFakeTimers();
    setSessionExpiresAtCookie(Date.now() + 90 * 60_000);
    const fetchMock = mockApiFetch({ id: 1, email: "admin@example.com", role: "admin", acting_as_demo: false });

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      setSessionExpiresAtCookie(Date.now() + 2 * 60_000);
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    });

    const refreshCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as RequestInfo | URL).toString();
      return url.includes("/api/auth/refresh");
    });
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  // Fix-round regression guards (design review, batch 04 task 5): the
  // review found the actingAsDemo-only derivation above had two reachable
  // holes where SessionKeeper could still refresh mid-acting-session --
  // rotating the admin's still-live, untouched refresh_token cookie and
  // silently resurrecting the admin identity. The fix flips `suspended`
  // to fail-closed: refresh is allowed ONLY once hydration has SETTLED
  // successfully and confirmed actingAsDemo === false (status ===
  // "hydrated" && !actingAsDemo). These three tests are the ones the
  // review specifically asked for.
  describe("fail-closed suspension (fix round)", () => {
    function refreshCallCount(fetchMock: ReturnType<typeof mockApiFetch>): number {
      return fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : (input as RequestInfo | URL).toString();
        return url.includes("/api/auth/refresh");
      }).length;
    }

    it("(1) no refresh fires while hydration is still pending, even with near-expiry + the mount-time check", async () => {
      vi.useFakeTimers();
      // Near-expiry from the very start (not "far out, then updated
      // later" like the tests above) -- SessionKeeper's own "checks
      // immediately on mount" behavior (SessionKeeper.test.tsx) fires in
      // the SAME tick SessionProvider mounts it, before the async /me
      // hydration below has any chance to resolve. This is exactly the
      // mount-time race the fix closes: a page load/reload during the
      // acting token's final 3 minutes must not slip a refresh through
      // while status is still "pending".
      setSessionExpiresAtCookie(Date.now() + 2 * 60_000);
      window.dispatchEvent(new Event("pointerdown")); // recent activity, pre-mount

      let resolveMe!: (body: unknown) => void;
      const fetchMock = vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/me")) {
          return new Promise<Response>((resolve) => {
            resolveMe = (body) => resolve(jsonResponse(body));
          });
        }
        return jsonResponse({ ok: true });
      });

      render(
        <SessionProvider>
          <Header />
        </SessionProvider>
      );

      // Flush the synchronous mount + SessionKeeper's mount-time immediate
      // check without ever letting /me resolve -- status stays "pending".
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(refreshCallCount(fetchMock)).toBe(0);

      // Resolve the hanging /me so this test doesn't leak an unresolved
      // promise/act warning into later tests.
      await act(async () => {
        resolveMe({ id: 1, email: "a@example.com", role: "user", acting_as_demo: false });
      });
    });

    it("(2) a hydration FAILURE while acting does NOT un-suspend", async () => {
      vi.useFakeTimers();
      setSessionExpiresAtCookie(Date.now() + 90 * 60_000); // far out for the first (successful) hydration

      const spy = vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/me")) {
          return jsonResponse({
            id: 2,
            email: "demo@example.com",
            role: "demo",
            acting_as_demo: true,
            admin_origin_email: "admin@example.com",
          });
        }
        return jsonResponse({ ok: true });
      });

      function RefreshTrigger() {
        const { refresh } = useSession();
        return <button onClick={() => void refresh()}>manual-refresh</button>;
      }

      render(
        <SessionProvider>
          <Header />
          <RefreshTrigger />
        </SessionProvider>
      );

      // Let the first hydration (successful, acting) settle: status
      // "hydrated", actingAsDemo true, suspended true -- as expected.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Now a transient /me failure on the NEXT attempt -- the pre-fix bug
      // reset actingAsDemo to false here (SIGNED_OUT_STATE) and, since
      // suspended used to be derived from actingAsDemo alone, that
      // silently un-suspended SessionKeeper even though the acting
      // session (and the admin's still-live refresh_token cookie) is very
      // much still real.
      spy.mockRejectedValue(new Error("network down"));
      await act(async () => {
        screen.getByText("manual-refresh").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        setSessionExpiresAtCookie(Date.now() + 2 * 60_000); // now near expiry
        window.dispatchEvent(new Event("pointerdown")); // recent activity
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // periodic tick
      });

      expect(refreshCallCount(spy)).toBe(0);
    });

    it("(3) a failed hydration retries and un-suspends a normal user once the retry succeeds", async () => {
      vi.useFakeTimers();
      setSessionExpiresAtCookie(Date.now() + 90 * 60_000); // far out during the failed first attempt

      const spy = vi.spyOn(api, "apiFetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/me")) return new Response("boom", { status: 500 });
        return jsonResponse({ ok: true });
      });

      render(
        <SessionProvider>
          <Header />
        </SessionProvider>
      );

      // First hydration attempt fails -- status "failed", fail-closed.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Phase A -- proves suspension is REAL while consistently failing,
      // not just "never suspended in the first place" (a naive version of
      // this test that skips straight to the success case would pass even
      // against the pre-fix code, since ITS mount-time race already leaves
      // SessionKeeper unsuspended from t=0 regardless of hydration
      // outcome -- confirmed by literally reverting the fix and re-running
      // this suite during the fix review). This window is long enough
      // (CHECK_INTERVAL_MS = 60s) that at least one scheduled retry
      // (HYDRATION_RETRY_MS = 45s) fires and fails again in the middle of
      // it -- still suspended throughout.
      await act(async () => {
        setSessionExpiresAtCookie(Date.now() + 2 * 60_000); // near expiry
        window.dispatchEvent(new Event("pointerdown")); // recent activity
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      });
      expect(refreshCallCount(spy)).toBe(0);

      // Phase B -- now let the NEXT scheduled retry succeed, as a normal
      // (non-acting) user.
      spy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/me")) {
          return jsonResponse({ id: 1, email: "a@example.com", role: "user", acting_as_demo: false });
        }
        return jsonResponse({ ok: true });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HYDRATION_RETRY_MS);
      });

      // status is now "hydrated", actingAsDemo false -> no longer suspended.
      await act(async () => {
        setSessionExpiresAtCookie(Date.now() + 2 * 60_000); // near expiry again
        window.dispatchEvent(new Event("pointerdown")); // recent activity
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // periodic tick
      });

      expect(refreshCallCount(spy)).toBeGreaterThan(0);
    });
  });
});
