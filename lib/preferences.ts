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
    return (await res.json()) as Record<string, unknown>;
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
