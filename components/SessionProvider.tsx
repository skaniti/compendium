"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
};

const SIGNED_OUT_STATE: Omit<SessionState, "refresh"> = {
  role: null,
  account: ACCOUNT_EMPTY,
  actingAsDemo: false,
  adminOriginEmail: undefined,
};

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
// (user.name || user.email || "—") -- centralized here now.
function deriveState(data: unknown): Omit<SessionState, "refresh"> {
  if (typeof data !== "object" || data === null) return SIGNED_OUT_STATE;
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

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/auth/me");
      if (!res.ok) {
        setState(SIGNED_OUT_STATE);
        return;
      }
      const data: unknown = await res.json();
      setState(deriveState(data));
    } catch (err) {
      // Backend unreachable, dev-bypass returning something unparseable,
      // whatever -- never let a failed hydration throw past this provider.
      console.error("SessionProvider: failed to hydrate session:", err);
      setState(SIGNED_OUT_STATE);
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

  return (
    <SessionContext.Provider value={{ ...state, refresh }}>
      {/* SessionKeeper is mounted HERE (not in app/layout.tsx, a server
          component that can't read this context) so its suspended prop can
          be wired straight to actingAsDemo. Suspension exists because an
          acting-as-demo access token is deliberately non-renewable
          (app/api/auth/view-as/route.ts mints it with a 60-min hard cap
          and no refresh_token) -- if SessionKeeper's sliding refresh ran
          anyway, its rotation would mint a fresh ADMIN token pair and
          silently resurrect the admin's own identity mid-view-as. */}
      <SessionKeeper suspended={state.actingAsDemo} />
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
