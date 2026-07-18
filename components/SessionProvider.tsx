"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import SessionKeeper from "@/components/SessionKeeper";

// D4 (batch 04 auth/session parity, spec.md D4): server-hydrated,
// client-gated role context -- the Next equivalent of Dash's
// `user-role-ctx` Store ({role, admin_launched_demo, account}), hydrated
// here from GET /api/auth/me instead of a per-request Dash callback. The
// backend stays the sole enforcement point for anything this gates
// (view-as/return-to-admin re-check role from the DB; preference writes
// re-check plain-demo server-side) -- this state only drives what the UI
// SHOWS, never a second authorization layer.

export type SessionRole = "admin" | "demo" | "user";

// pending: mount, before the first GET /api/auth/me has resolved either
// way. hydrated: last attempt succeeded -- role/account/actingAsDemo/
// adminOriginEmail reflect the backend's response. failed: last attempt
// (non-2xx, network error, or an unparseable/non-object body) did not
// resolve -- a retry is scheduled (see HYDRATION_RETRY_MS below).
export type SessionHydrationStatus = "pending" | "hydrated" | "failed";

export interface SessionState {
  // null = signed out / unknown (backend unreachable, a non-2xx /me, or a
  // response shape/role string we don't recognize) -- deliberately
  // distinct from the literal backend role "user" (authenticated, no
  // elevated role), so callers can gate admin/demo-only UI with a single
  // `role === "admin"` check that's safe in every one of those cases.
  role: SessionRole | null;
  account: string;
  actingAsDemo: boolean;
  adminOriginEmail?: string;
  status: SessionHydrationStatus;
  refresh: () => Promise<void>;
}

// Pre-resolution placeholder vs. resolved-but-empty/signed-out -- mirrors
// the distinction Header itself used to draw before this context existed
// (frontend/dash/app.py:2918-2919: "…" pre-resolution, "—" once resolved
// with no username/email).
const ACCOUNT_PLACEHOLDER = "…";
const ACCOUNT_EMPTY = "—";

const INITIAL_STATE: Omit<SessionState, "refresh"> = {
  role: null,
  account: ACCOUNT_PLACEHOLDER,
  actingAsDemo: false,
  adminOriginEmail: undefined,
  status: "pending",
};

const FAILED_STATE: Omit<SessionState, "refresh"> = {
  role: null,
  account: ACCOUNT_EMPTY,
  actingAsDemo: false,
  adminOriginEmail: undefined,
  status: "failed",
};

// Retry cadence for a failed hydration attempt (security-review fix,
// batch 04 task 5 fix round). A transient /me blip must not permanently
// strand a normal, non-acting user in the fail-closed "no refresh" state
// the `suspended` derivation below produces for anything short of a
// CONFIRMED successful hydration -- so a failure keeps retrying here
// until one succeeds. Deliberately NOT the same value as SessionKeeper's
// own CHECK_INTERVAL_MS (60_000): these are two independent timers for
// two different concerns ("how often do we retry a failed hydration" vs.
// "how often do we check whether the access token needs refreshing"), and
// giving them different periods keeps their firing order unambiguous
// (useful for reasoning about behavior, and for tests that exercise both
// without needing to arbitrate a tie).
export const HYDRATION_RETRY_MS = 45_000;

const SessionContext = createContext<SessionState | undefined>(undefined);

interface MeResponse {
  email?: unknown;
  name?: unknown;
  role?: unknown;
  acting_as_demo?: unknown;
  admin_origin_email?: unknown;
}

function isSessionRole(value: unknown): value is SessionRole {
  return value === "admin" || value === "demo" || value === "user";
}

// Same fallback chain Header's own fetch used to compute directly
// (user.name || user.email || "—") -- centralized here now. Returns null
// for a body we can't make sense of (non-object) -- explicit signal to the
// caller that this is a failed hydration, not a "hydrated" state with
// generic fallback field values.
function deriveState(data: unknown): Omit<SessionState, "refresh" | "status"> | null {
  if (typeof data !== "object" || data === null) return null;
  const me = data as MeResponse;
  const name = typeof me.name === "string" && me.name ? me.name : undefined;
  const email = typeof me.email === "string" && me.email ? me.email : undefined;
  const adminOriginEmail = typeof me.admin_origin_email === "string" ? me.admin_origin_email : undefined;
  return {
    // An unrecognized role string (backend contract drift, a proxy error
    // page that happens to be valid JSON, etc.) is treated as signed-out
    // rather than trusted -- never surface a role we don't understand.
    role: isSessionRole(me.role) ? me.role : null,
    account: name || email || ACCOUNT_EMPTY,
    actingAsDemo: me.acting_as_demo === true,
    adminOriginEmail,
  };
}

export default function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, "refresh">>(INITIAL_STATE);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    function scheduleRetryIfNeeded() {
      if (retryTimeoutRef.current !== null) return; // already scheduled
      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null;
        void refresh();
      }, HYDRATION_RETRY_MS);
    }

    function markFailedAndRetry() {
      setState(FAILED_STATE);
      scheduleRetryIfNeeded();
    }

    try {
      const res = await apiFetch("/api/auth/me");
      if (!res.ok) {
        markFailedAndRetry();
        return;
      }
      const data: unknown = await res.json();
      const derived = deriveState(data);
      if (derived === null) {
        // 2xx but a body we can't make sense of (non-object) -- still a
        // failure for suspension purposes, NOT a confirmed
        // actingAsDemo=false: treating this as "hydrated" would unsuspend
        // SessionKeeper on the strength of a response we couldn't parse.
        markFailedAndRetry();
        return;
      }
      setState({ ...derived, status: "hydrated" });
      // A previously scheduled retry (from an earlier failure) is now
      // moot -- this success already re-hydrated.
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    } catch (err) {
      // Backend unreachable, dev-bypass returning something unparseable,
      // whatever -- never let a failed hydration throw past this provider.
      console.error("SessionProvider: failed to hydrate session:", err);
      markFailedAndRetry();
    }
  }, []);

  useEffect(() => {
    // /login renders no AppShell/Header (app/login/page.tsx is a standalone
    // form), so nothing there ever consumes this context -- but this
    // provider wraps the ENTIRE app in app/layout.tsx, /login included.
    // Skip hydration there: /api/auth/me is authenticated-only, so a
    // genuinely unauthenticated prod-mode (AUTH_REQUIRED) visitor would get
    // a 401, and apiFetch's interceptor would window.location.assign
    // ("/login") -- an immediate reload loop on the page already showing.
    // proxy.ts treats "/login" as the same kind of exempt route for the
    // same class of reason (see its own redirect-loop comment).
    if (window.location.pathname === "/login") return;
    void refresh();
  }, [refresh]);

  // Cleanup on unmount: don't let a scheduled retry fire (and call
  // setState) after this provider is gone.
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, []);

  // Fail-closed, not fail-open (security-review fix, batch 04 task 5 fix
  // round). SessionKeeper may refresh ONLY once hydration has SETTLED
  // SUCCESSFULLY and confirmed actingAsDemo === false -- everything else
  // suspends:
  //   - status "pending": SessionKeeper's own mount-time immediate check
  //     (see SessionKeeper.tsx) can fire before this provider's async /me
  //     call has any chance to resolve. If a page loads/reloads during an
  //     acting token's final 3 minutes and this were still keyed off the
  //     stale-until-proven-otherwise actingAsDemo=false initial value, a
  //     refresh would fire against the admin's own STILL-LIVE, untouched
  //     refresh_token cookie (view-as never touches it -- see
  //     app/api/auth/view-as/route.ts) and silently swap the jar back to
  //     the admin. Suspending while pending closes that window.
  //   - status "failed": a transient /me blip must NOT be read as "safe
  //     to refresh" just because the LAST successful read happened to
  //     say actingAsDemo=false, or because the failure path's fallback
  //     state defaults actingAsDemo to false -- an in-progress acting
  //     session's admin refresh_token cookie is just as live during a
  //     backend hiccup as it is any other time. HYDRATION_RETRY_MS above
  //     is what keeps this from permanently stranding a normal user after
  //     one blip: it keeps retrying until a hydration actually succeeds
  //     one way or the other.
  const suspended = !(state.status === "hydrated" && !state.actingAsDemo);

  return (
    <SessionContext.Provider value={{ ...state, refresh }}>
      {/* SessionKeeper is mounted HERE (not in app/layout.tsx, a server
          component that can't read this context) so its suspended prop can
          be wired straight to the derivation above. */}
      <SessionKeeper suspended={suspended} />
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (ctx === undefined) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}
