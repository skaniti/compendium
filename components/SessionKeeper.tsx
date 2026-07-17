"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";

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
const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";

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
