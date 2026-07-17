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

const PREFERENCES_PATH = "/api/auth/preferences";

export async function getPreferences(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(PREFERENCES_PATH);
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
    const res = await fetch(PREFERENCES_PATH, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });
    if (!res.ok) {
      console.error(`patchPreferences: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("patchPreferences failed:", err);
  }
}
