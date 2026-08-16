"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { SESSION_EXPIRES_AT_COOKIE } from "@/lib/session-cookies";

// D2 (batch 04 auth/session parity): activity-scoped sliding refresh.
//
// Deliberately FIXES a Dash quirk -- Dash's background polling (and, in
// some builds, tab-visibility pings) counted as "activity", so a session
// left open in a background tab never idled out. Here, ONLY real user
// input (pointer/keyboard/wheel/scroll) resets the idle clock;
// `visibilitychange` may trigger an immediate *check* when the tab becomes
// visible again, but never resets `lastActivity` itself. This is a real UX
// change from Dash and is flagged to the user at the batch gate.
//
// Every CHECK_INTERVAL, if the access token (read via the readable
// session_expires_at cookie -- the token itself is HttpOnly) is within
// NEAR_EXPIRY_MS of expiring AND the user has been active within
// IDLE_MINUTES, this POSTs /api/auth/refresh (which rotates both cookies
// server-side). If idle time has been exceeded, this does nothing -- the
// session lapses by omission, and the 401 interceptor (lib/api.ts
// apiFetch) handles the eventual bounce to /login once the dead access
// token actually gets rejected by the backend.

const CHECK_INTERVAL_MS = 60_000; // 1 minute
const NEAR_EXPIRY_MS = 3 * 60_000; // 3 minutes
const DEFAULT_IDLE_MINUTES = 60;

// Passive, non-blocking activity signals -- deliberately excludes anything
// that could fire from background/programmatic activity (no `focus`, no
// `visibilitychange`; see the anti-Dash-quirk note above).
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll"] as const;

// Read live each check (not cached at module scope) so a test -- or a
// runtime env change -- overriding NEXT_PUBLIC_IDLE_MINUTES takes effect
// immediately. Written as a literal `process.env.NEXT_PUBLIC_IDLE_MINUTES`
// reference (not an indirected lookup) so Next's client build can still
// statically inline it per the NEXT_PUBLIC_* convention.
function readIdleMinutes(): number {
  const raw = process.env.NEXT_PUBLIC_IDLE_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MINUTES;
}

const SESSION_EXPIRES_AT_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${SESSION_EXPIRES_AT_COOKIE}=([^;]*)`);

function readSessionExpiresAtMs(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(SESSION_EXPIRES_AT_COOKIE_PATTERN);
  if (!match) return null;
  const value = Number(decodeURIComponent(match[1]));
  return Number.isFinite(value) ? value : null;
}

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
      lastActivityRef.current = Date.now();
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
      // Batch-04 fix-round bug: an ALREADY-EXPIRED token (expiresAtMs <=
      // nowMs) also satisfies "expiresAtMs - nowMs < NEAR_EXPIRY_MS" (the
      // gap is negative), so a user who idled PAST the window and only
      // returns hours later -- well outside IDLE_MINUTES -- would still
      // hit the idle check below with a huge idleMinutes... except the
      // real bug is activity on return resets lastActivityRef BEFORE this
      // runs, so idleMinutes reads ~0 and the lapse gets silently
      // resurrected via the 7-day refresh token, defeating D2's
      // idle-lapse-is-final design. The lapse must latch once the token
      // has actually expired: refuse to refresh, full stop, and let the
      // 401 interceptor (lib/api.ts apiFetch) handle the bounce on the
      // next authed request. Sliding refresh for still-active users is
      // unchanged -- near-expiry-but-not-yet-expired still refreshes.
      if (expiresAtMs <= nowMs) return;
      const nearExpiry = expiresAtMs - nowMs < NEAR_EXPIRY_MS;
      if (!nearExpiry) return;

      const idleMinutes = (nowMs - lastActivityRef.current) / 60_000;
      if (idleMinutes >= readIdleMinutes()) return; // Idle lapse: do nothing.

      refreshInFlightRef.current = true;
      try {
        await apiFetch("/api/auth/refresh", { method: "POST" });
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
