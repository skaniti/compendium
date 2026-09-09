import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import SessionKeeper from "./SessionKeeper";
import { __resetThrottleForTests } from "../lib/session-policy-client";

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
const SESSION_POLICY_COOKIE = "session_policy";
const SESSION_LAST_ACTIVE_COOKIE = "session_last_active";

function setSessionExpiresAtCookie(epochMs: number) {
  document.cookie = `${SESSION_EXPIRES_AT_COOKIE}=${epochMs}; path=/`;
}

// D1/D2 (session-expiry-tuning): the backend's per-role policy, camelCase
// (matches lib/session-cookies.ts's SessionPolicy -- this is what
// applySessionCookies actually writes into the cookie, not the backend's
// raw snake_case body).
function setSessionPolicyCookie(policy: { idleMinutes: number; resume: boolean; remembered: boolean }) {
  document.cookie = `${SESSION_POLICY_COOKIE}=${encodeURIComponent(JSON.stringify(policy))}; path=/`;
}

function setLastActiveCookie(epochMs: number) {
  document.cookie = `${SESSION_LAST_ACTIVE_COOKIE}=${epochMs}; path=/`;
}

// All three session cookies SessionKeeper reads (and, since D2, itself
// writes via markActive/writeLastActiveMs) -- must be cleared between every
// test, not just session_expires_at, or a refresh triggered by one test's
// activity would leak session_last_active into the next.
function clearAllCookies() {
  for (const name of [SESSION_EXPIRES_AT_COOKIE, SESSION_POLICY_COOKIE, SESSION_LAST_ACTIVE_COOKIE]) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
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

  it("latches an idle lapse permanently: no refresh even after activity resumes post-expiry", async () => {
    // Batch-04 fix-round bug: idle-lapse is supposed to be FINAL (D2) -- once
    // a session lapses, only re-authenticating should revive it. Before this
    // fix, maybeRefresh treated an ALREADY-EXPIRED token the same as a
    // near-expiry one (a negative expiresAtMs-nowMs gap still satisfies
    // "< NEAR_EXPIRY_MS"), so a user who idled past the window and only
    // returns hours later -- resetting lastActivityRef on the very
    // pointerdown that "returns" them -- got idleMinutes reading ~0 on the
    // next check, silently resurrecting the lapsed session via the still-live
    // 7-day refresh token. The fix refuses refresh outright once
    // expiresAtMs <= nowMs, independent of any activity that follows.
    process.env.NEXT_PUBLIC_IDLE_MINUTES = "5";
    const fetchMock = mockFetch();
    const now = Date.now();
    // Same setup as the idle-lapse test above: expiry crosses into the
    // 3-min near-expiry window only at t=6min, by which point idle (6min,
    // measured from mount with no activity dispatched) already exceeds the
    // 5-min threshold -- the lapse fires correctly here too (pre-fix
    // behavior), same sanity check as that test.
    setSessionExpiresAtCookie(now + 8 * 60_000);

    render(<SessionKeeper />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 9); // t=9min: idle-lapsed, token now expired too
    });
    expect(fetchMock).not.toHaveBeenCalled(); // sanity: matches the plain idle-lapse test

    // The user returns hours later (well outside any idle window in
    // spirit) and starts interacting again. This resets lastActivityRef to
    // "now" -- exactly the condition that resurrected the lapsed session
    // pre-fix. It must not, regardless of how many periodic checks follow.
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
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

// D1/D2 (session-expiry-tuning): the session_policy cookie turns the old
// hard latch (above) into a backend-decided check, and idle is now read
// from the persisted session_last_active cookie instead of only the
// per-mount lastActivityRef. These tests exercise the new decision table;
// the suite above (no policy cookie set) is the regression guard that the
// no-policy fallback stays byte-identical to the pre-D1 behaviour.
describe("SessionKeeper -- session_policy-driven resume (D2/D3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllCookies();
    // Item 2 (session-expiry-tuning review fixes): writeLastActiveMs's
    // throttle (lib/session-policy-client.ts) is module-level state that
    // otherwise survives across tests in this file -- without resetting it,
    // the "D2 finality" test below can pass vacuously because the throttle
    // silently drops the pointerdown-triggered cookie write before the
    // sessionLapsed guard it's meant to exercise ever runs.
    __resetThrottleForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAllCookies();
  });

  it("resumes an already-expired token when policy.resume is true and the user is within the idle window", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(now - 5_000); // active 5s ago -- well within 60min
    setSessionExpiresAtCookie(now - 1_000); // already expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("refuses to resume an expired token once idle time exceeds the policy's idleMinutes", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 5, resume: true, remembered: false });
    setLastActiveCookie(now - 10 * 60_000); // idle 10min > 5min policy window
    setSessionExpiresAtCookie(now - 1_000); // already expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lapses on idle when policy.idleMinutes is 0 (remembered device), even long-idle and expired", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 0, resume: true, remembered: true });
    setLastActiveCookie(now - 30 * 24 * 60 * 60_000); // idle 30 days
    setSessionExpiresAtCookie(now - 1_000); // already expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("refuses to resume an expired token when policy.resume is false (e.g. an acting-as-demo session), even within the idle window", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: false, remembered: false });
    setLastActiveCookie(now - 5_000);
    setSessionExpiresAtCookie(now - 1_000); // already expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refreshes a NOT-YET-expired, near-expiry token under a policy (sliding refresh unchanged)", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(now - 5_000);
    setSessionExpiresAtCookie(now + 2 * 60_000); // near expiry, not yet expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("never refreshes when suspended=true, even with a resumable policy and an expired token", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(now - 5_000);
    setSessionExpiresAtCookie(now - 1_000);

    render(<SessionKeeper suspended />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Item 1 (session-expiry-tuning review fixes): the policy-cookie analog
  // of the plain-cookie "latches an idle lapse permanently" test above.
  // Before this fix, markActive's writeLastActiveMs(now) call on the
  // returning pointerdown would silently overwrite the stale, already-past-
  // idleMinutes session_last_active cookie with "now" -- making the NEXT
  // check read a fresh timestamp and (with policy.resume true and an
  // already-expired token) resurrect the lapsed session via the still-live
  // refresh token. The fix refuses that cookie write outright once the
  // session has already lapsed, independent of any activity that follows.
  it("D2 finality under a policy cookie: pointerdown after the stored last-active is already stale does not revive an idle-lapsed session", async () => {
    const fetchMock = mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(now - 2 * 60 * 60_000); // stored last-active: 2h ago, already outside the 60min window
    setSessionExpiresAtCookie(now - 1_000); // already expired

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled(); // sanity: matches the plain "refuses to resume" test above

    // The user returns and starts interacting again -- exactly the
    // condition that resurrected the lapsed session pre-fix.
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("after a successful policy-driven refresh, force-writes session_last_active (extends the resume window)", async () => {
    mockFetch();
    const now = Date.now();
    setSessionPolicyCookie({ idleMinutes: 60, resume: true, remembered: false });
    setLastActiveCookie(now - 5_000);
    setSessionExpiresAtCookie(now - 1_000);

    render(<SessionKeeper />);
    await act(async () => {
      await Promise.resolve();
    });

    const match = document.cookie.match(/session_last_active=([^;]*)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(now);
  });
});
