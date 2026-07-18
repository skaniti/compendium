import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import SessionProvider, { useSession } from "./SessionProvider";
import Header from "./Header";
import * as api from "@/lib/api";
import * as ThemeProviderModule from "./ThemeProvider";
import * as StarfieldProviderModule from "./StarfieldProvider";

// D4/D5 (batch 04 auth/session parity): useSession() context, hydrated from
// GET /api/auth/me via apiFetch (established mock convention -- see
// lib/api.test.ts, components/SessionKeeper.test.tsx). Header consumes the
// context directly now (no more of its own fetch), so the role-gating
// matrix (admin sees "view demo", an acting session sees the floating
// "Return to admin" button, a plain user/demo sees neither) is exercised
// here by rendering Header inside a real SessionProvider rather than
// against a bare Consumer -- that's the only place the gated DOM lives.

const CHECK_INTERVAL_MS = 60_000;
const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";

function setSessionExpiresAtCookie(epochMs: number) {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=${epochMs}; path=/`;
}

function clearAllCookies() {
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
    clearAllCookies();
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

describe("Header role-gated UI (via SessionProvider)", () => {
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
    clearAllCookies();
  });

  it("admin: sees the view-demo action, not the return-to-admin button", async () => {
    mockApiFetch({ id: 1, email: "admin@example.com", name: "Admin", role: "admin", acting_as_demo: false });

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    await waitFor(() => expect(screen.getByText("view demo")).toBeInTheDocument());
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
  });

  it("acting-as-demo: sees the floating return-to-admin button, not the view-demo action", async () => {
    mockApiFetch({
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

    await waitFor(() => expect(screen.getByText("Return to admin")).toBeInTheDocument());
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
  });

  it("plain user: sees neither the view-demo action nor the return-to-admin button", async () => {
    mockApiFetch({ id: 3, email: "user@example.com", role: "user", acting_as_demo: false });

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    await waitFor(() => expect(document.getElementById("account-display")).toHaveTextContent("user@example.com"));
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
  });

  it("plain (direct) demo login: sees neither -- role demo but acting_as_demo false", async () => {
    mockApiFetch({ id: 2, email: "demo@example.com", role: "demo", acting_as_demo: false });

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    await waitFor(() => expect(document.getElementById("account-display")).toHaveTextContent("demo@example.com"));
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
  });

  it("signed-out default: renders safely with neither gated action", async () => {
    mockApiFetch({ error: "unauthorized" }, 401);

    render(
      <SessionProvider>
        <Header />
      </SessionProvider>
    );

    await waitFor(() => expect(document.getElementById("account-display")).toHaveTextContent("—"));
    expect(screen.queryByText("view demo")).not.toBeInTheDocument();
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
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
});
