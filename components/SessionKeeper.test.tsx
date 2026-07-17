import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import SessionKeeper from "./SessionKeeper";

// D2 (batch 04 auth/session parity): activity-scoped sliding refresh.
// Deliberately FIXES the Dash quirk where background polling/visibility
// counted as "activity" (Dash sessions never idled out) -- the
// visibilitychange test below is the direct regression guard for that
// intentional behavior change, flagged to the user at the batch gate.
//
// CHECK_INTERVAL/NEAR_EXPIRY match the component's own constants (1 min /
// 3 min); IDLE_MINUTES is overridden per test via NEXT_PUBLIC_IDLE_MINUTES
// so idle-lapse scenarios don't require advancing fake timers 60+ minutes.

const CHECK_INTERVAL_MS = 60_000;
const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";

function setSessionExpiresAtCookie(epochMs: number) {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=${epochMs}; path=/`;
}

function clearAllCookies() {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

function mockFetch() {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("SessionKeeper", () => {
  const originalIdleMinutes = process.env.NEXT_PUBLIC_IDLE_MINUTES;

  beforeEach(() => {
    vi.useFakeTimers();
    clearAllCookies();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAllCookies();
    if (originalIdleMinutes === undefined) delete process.env.NEXT_PUBLIC_IDLE_MINUTES;
    else process.env.NEXT_PUBLIC_IDLE_MINUTES = originalIdleMinutes;
  });

  it("is inert (never refreshes) when session_expires_at cookie is absent -- dev no-auth mode", async () => {
    const fetchMock = mockFetch();
    render(<SessionKeeper />);

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks immediately on mount, without waiting for the first interval tick", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionExpiresAtCookie(now + 2 * 60_000); // near expiry from the start

    render(<SessionKeeper />);

    // No timer advance at all -- flush only the microtask the mount-time
    // check's internal `await apiFetch(...)` needs to actually invoke fetch.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("refreshes on the periodic check when near expiry and the user was recently active", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    // Far out at mount so the mount-time immediate check (tested above) is
    // a no-op here -- isolates this test to the recurring interval path,
    // not the mount-time check.
    setSessionExpiresAtCookie(now + 90 * 60_000);

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled(); // sanity: mount check found "not near expiry"

    await act(async () => {
      setSessionExpiresAtCookie(Date.now() + 2 * 60_000); // now near expiry
      window.dispatchEvent(new Event("pointerdown")); // recent activity
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // first periodic tick
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("does not refresh when the token is not yet near expiry", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionExpiresAtCookie(now + 30 * 60_000); // far out

    render(<SessionKeeper />);

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lapses (does not refresh) once idle time exceeds IDLE_MINUTES, even near expiry", async () => {
    process.env.NEXT_PUBLIC_IDLE_MINUTES = "5";
    const fetchMock = mockFetch();
    const now = Date.now();
    // Expiry crosses into the 3-min near-expiry window only at t=6min (gap
    // drops below 3min just after t=5min) -- by which point idle (6min,
    // measured from mount with no activity dispatched) already exceeds the
    // 5-min threshold, isolating the lapse from "not near expiry yet".
    setSessionExpiresAtCookie(now + 8 * 60_000);

    render(<SessionKeeper />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 9);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat a visibilitychange as user activity (anti-Dash-quirk)", async () => {
    process.env.NEXT_PUBLIC_IDLE_MINUTES = "5";
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionExpiresAtCookie(now + 30 * 60_000); // far out during the idle-accumulation phase

    render(<SessionKeeper />);

    // Let genuine idle time pass well beyond the 5-min threshold, with no
    // activity and no visibilitychange yet -- nearExpiry is false throughout
    // this phase (gap > 3min), so nothing fires regardless.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Now bring the cookie's expiry close (simulate the token nearing
    // expiry) and repeatedly dispatch visibilitychange -- if visibilitychange
    // incorrectly reset lastActivity, idle would drop to ~0 and the next
    // check (immediate or on the next tick) would refresh. It must not:
    // lastActivity should still reflect mount time, 10+ minutes ago.
    await act(async () => {
      setSessionExpiresAtCookie(Date.now() + 2 * 60_000);
      for (let i = 0; i < 3; i++) {
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      }
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never refreshes when suspended=true, even near expiry with recent activity", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionExpiresAtCookie(now + 2 * 60_000);

    render(<SessionKeeper suspended />);

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start a second refresh while one is already in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.now();
    setSessionExpiresAtCookie(now + 2 * 60_000);

    render(<SessionKeeper />);
    // The mount-time immediate check already starts a refresh here (cookie
    // is near expiry, no idle time yet) and it never resolves (resolveFetch
    // is never called mid-test) -- fetchMock is at 1 call before the first
    // act() block below even runs.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // tick 1: previous refresh still in flight
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); // tick 2: still in flight
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await Promise.resolve();
    });
  });
});
