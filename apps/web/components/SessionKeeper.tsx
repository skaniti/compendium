"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import {
  effectiveIdleMinutes,
  readLastActiveMs,
  readSessionExpiresAtMs,
  readSessionPolicy,
  writeLastActiveMs,
} from "@/lib/session-policy-client";

// D2 (batch 04 auth/session parity; re-tuned session-expiry-tuning D2/D3):
// activity-scoped sliding refresh, policy-gated.
//
// Deliberately FIXES a Dash quirk -- Dash's background polling (and, in
// some builds, tab-visibility pings) counted as "activity", so a session
// left open in a background tab never idled out. Here, ONLY real user
// input (pointer/keyboard/wheel/scroll) resets the idle clock;
// `visibilitychange` may trigger an immediate *check* when the tab becomes
// visible again, but never resets `lastActivity` itself. This is a real UX
// change from Dash and is flagged to the user at the batch gate.
//
// Every CHECK_INTERVAL, this reads the backend's session_policy cookie
// (spec D1: per-role idle window + whether an already-expired token may
// still be resumed) and decides whether to POST /api/auth/refresh
// (rotates both cookies server-side). Idle is measured from
// session_last_active -- a cookie this component itself writes on real
// activity (see markActive below), NOT a per-mount useRef seed -- so a
// user who returns after 2 idle hours reads a 2-hour-old timestamp and is
// refused, while a user who merely closed the tab for 20 minutes is still
// within the window and resumes, even past the access token's own exp.
// With NO session_policy cookie (dev no-auth mode, or a cookie set before
// this upgrade), idleMinutes falls back to NEXT_PUBLIC_IDLE_MINUTES/60 and
// an already-expired token is never refreshed -- byte-identical to the
// pre-policy behaviour this replaces.

const CHECK_INTERVAL_MS = 60_000; // 1 minute
const NEAR_EXPIRY_MS = 3 * 60_000; // 3 minutes

// Passive, non-blocking activity signals -- deliberately excludes anything
// that could fire from background/programmatic activity (no `focus`, no
// `visibilitychange`; see the anti-Dash-quirk note above).
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll"] as const;

interface SessionKeeperProps {
  // Disables refreshing entirely while true. Wired by the next task to
  // actingAsDemo: an acting-as-demo session must never refresh, since
  // rotation would swap in a fresh access/refresh token pair and silently
  // resurrect the admin's own identity mid-view-as.
  suspended?: boolean;
}

export default function SessionKeeper({ suspended = false }: SessionKeeperProps) {
  // useRef's initializer only runs on the FIRST render (React's own
  // contract), so Date.now() here just seeds the mount timestamp -- it is
  // not re-evaluated on later renders.
  // eslint-disable-next-line react-hooks/purity -- useRef init-only read, not a per-render impure call
  const lastActivityRef = useRef<number>(Date.now());
  const refreshInFlightRef = useRef(false);

  // Activity listeners: separate effect so they mount once and never
  // depend on `suspended` -- lastActivity should keep tracking real input
  // even while suspended, so a resumed (un-suspended) session isn't
  // treated as having been idle the whole time it was suspended.
  useEffect(() => {
    function markActive() {
      const now = Date.now();
      lastActivityRef.current = now;
      // Throttled (30s) inside writeLastActiveMs itself -- safe to call on
      // every pointermove/scroll without flooding document.cookie writes.
      writeLastActiveMs(now);
    }
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, markActive, { passive: true });
    }
    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, markActive);
      }
    };
  }, []);

  useEffect(() => {
    async function maybeRefresh() {
      if (suspended || refreshInFlightRef.current) return;

      const expiresAtMs = readSessionExpiresAtMs();
      if (expiresAtMs === null) return; // No cookie -- dev no-auth mode, inert.

      const nowMs = Date.now();
      const policy = readSessionPolicy();
      // D2 (session-expiry-tuning): idle is measured from the PERSISTED
      // session_last_active cookie (falling back to this mount's own
      // lastActivityRef only when that cookie has never been written --
      // e.g. no activity yet this tab, or a policy cookie set before this
      // upgrade), not a per-mount useRef seed -- this is what lets a user
      // who closed the tab for 20 minutes resume past the access token's
      // own exp, instead of every reload effectively resetting the idle
      // clock to "just now".
      const idleMinutes = effectiveIdleMinutes(policy);
      const lastActive = readLastActiveMs() ?? lastActivityRef.current;
      const active = idleMinutes === 0 || nowMs - lastActive < idleMinutes * 60_000;
      if (!active) return; // Idle lapse: do nothing.

      const expired = expiresAtMs <= nowMs;
      const nearExpiry = expiresAtMs - nowMs < NEAR_EXPIRY_MS;
      if (!nearExpiry) return;
      // Batch-04 fix-round bug, now a policy check instead of a hard latch:
      // an ALREADY-EXPIRED token used to be latched shut unconditionally
      // (refuse forever, regardless of activity) to stop a return-from-idle
      // pointerdown from silently resurrecting a lapsed session via the
      // still-live refresh token. That latch is now the backend's own call
      // (spec D1's session_policy.resume -- false for an acting-as-demo
      // session, so view-as can never rotate the admin's refresh token
      // mid-act; true for every normal login). With NO policy cookie,
      // `policy?.resume` is undefined -> the `?? false` fallback below
      // reproduces the old unconditional latch exactly.
      if (expired && !(policy?.resume ?? false)) return;

      refreshInFlightRef.current = true;
      try {
        const res = await apiFetch("/api/auth/refresh", { method: "POST" });
        // `active` gated this call (the early return above), so a
        // successful refresh here is always backed by genuine tracked
        // activity (or an idleMinutes===0 policy that never needed any) --
        // extending the resume window is not fabricating activity that
        // didn't happen, just persisting the one that already gated this
        // very refresh.
        if (res.ok) writeLastActiveMs(Date.now(), { force: true });
      } catch (err) {
        console.error("SessionKeeper: refresh failed:", err);
      } finally {
        refreshInFlightRef.current = false;
      }
    }

    // Immediate check on mount: a fresh page load (or a tab restored after
    // being asleep) might already be within the near-expiry window --
    // don't make it wait up to a full CHECK_INTERVAL_MS for the first
    // check. Re-fires whenever `suspended` flips (this effect's only dep),
    // which also covers "resumed from suspension" getting an immediate
    // check rather than waiting for the next tick.
    void maybeRefresh();

    const intervalId = window.setInterval(() => {
      void maybeRefresh();
    }, CHECK_INTERVAL_MS);

    // Tab regaining visibility MAY trigger an immediate check (no reason to
    // wait up to a full minute) -- it must NOT feed lastActivityRef itself.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void maybeRefresh();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [suspended]);

  return null;
}
