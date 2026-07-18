// Thin fetch wrapper: closes the client-side UX loop when the HttpOnly
// access_token cookie is gone/expired. D1 (batch 04 auth/session parity) --
// this is UX only, not a second enforcement layer; the backend's
// verify_api_key is what actually rejects unauthenticated requests. A 401
// here just means "bounce to /login" instead of leaving callers to render a
// blank/broken state against data that will never arrive.
//
// Kept args as a passthrough tuple (not a fixed (input, init) signature) so
// call sites that omit `init` still hit `fetch` with exactly the arguments
// they gave -- callers/tests that assert `fetch` was called with a single
// argument (e.g. lib/preferences.ts's GET) keep working unchanged.
export async function apiFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await fetch(...args);
  if (res.status === 401) {
    redirectToLogin();
  }
  return res;
}

// Shared choke point for "bounce to /login", exported so other 401-aware
// call sites (lib/agent-stream.ts's streamAgentQuery, which talks to
// fetch directly rather than through apiFetch so it can read the raw
// stream body) can reuse the exact same guard instead of duplicating it.
//
// Batch-04 fix-round bug: the root layout wraps EVERY route (including
// /login itself, app/layout.tsx) in SessionProvider/ThemeProvider, both of
// which fire an authenticated GET on mount (/api/auth/me,
// /api/auth/preferences via ThemeProvider's getPreferences()).
// SessionProvider already guards its own hydration call against /login
// (see its own comment), but that only prevented ONE of the two mount-time
// calls -- ThemeProvider's getPreferences() -> apiFetch had no such guard.
// An unauthenticated prod visitor landing on /login got: 401 from
// preferences -> assign("/login") -> full reload -> remount -> 401 again,
// an infinite reload loop. Guarding here, at apiFetch's own 401 handling,
// closes the loop for every current AND future caller in one place,
// instead of requiring every mount-effect that might 401 to remember its
// own /login check.
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  window.location.assign("/login");
}
