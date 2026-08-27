// Thin client for the shared server preference row (same rows the Dash
// frontend reads/writes during coexistence). Goes through the existing
// same-origin `/api/[...path]` proxy, which injects the auth JWT from the
// HttpOnly cookie -- callers here never touch auth directly.
//
// Both functions swallow errors rather than throwing: a preference read/
// write is a nice-to-have (persisted palette/panel/starfield settings), not
// something that should ever crash the UI. Failures are logged and callers
// get a safe fallback (`{}` for a failed GET, a resolved no-op for a failed
// PATCH).
//
// fetch -> apiFetch: a 401 here means the access_token cookie expired mid-
// session, so the interceptor bounces to /login (D1, batch 04) -- the
// swallow-and-fallback contract below is unchanged, apiFetch still returns
// the (401) Response for the existing !res.ok branch to log and fall back on.

import { apiFetch } from "./api";

const PREFERENCES_PATH = "/api/auth/preferences";

export async function getPreferences(): Promise<Record<string, unknown>> {
  try {
    const res = await apiFetch(PREFERENCES_PATH);
    if (!res.ok) {
      console.error(`getPreferences: ${res.status} ${res.statusText}`);
      return {};
    }
    const parsed: unknown = await res.json();
    // A 200 with a non-object body (null, a scalar, an array) satisfies the
    // return type via a bare cast but breaks every consumer doing
    // `prefs.someKey` -- guard down to `{}` so callers can always treat the
    // result as a plain object.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("getPreferences: expected a JSON object, got:", parsed);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error("getPreferences failed:", err);
    return {};
  }
}

export async function patchPreferences(partial: Record<string, unknown>): Promise<void> {
  try {
    const res = await apiFetch(PREFERENCES_PATH, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Backend contract (PreferencesRequest, backend/api/main.py): the
      // PATCH body must be wrapped as {"preferences": {...}} -- an
      // unwrapped partial 422s. Callers here still pass the bare partial;
      // wrapping is this function's job so every call site (ThemeProvider,
      // usePanelResize, ...) stays simple.
      body: JSON.stringify({ preferences: partial }),
    });
    if (!res.ok) {
      console.error(`patchPreferences: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("patchPreferences failed:", err);
  }
}
