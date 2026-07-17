// Server-side counterpart to lib/preferences.ts's client-side getPreferences,
// used only where a value must be known before first paint (server-rendered
// initial panel widths, mirroring Dash's `_panel_width_style()`). Reuses the
// backend-URL + cookie-JWT pattern from app/api/[...path]/route.ts, but talks
// to the backend directly (no self-fetch through the proxy route) since this
// runs during the same server render as the request that needs it.
//
// Same "swallow and fall back" contract as `_panel_width_style`'s bare
// `except Exception: pass`: an unauthenticated request or any backend
// failure returns {} so the panel CSS's own `var(--panel-left-width, 20%)`
// fallback takes over -- this never breaks the shell render.
import { cookies } from "next/headers";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

export interface InitialPanelWidths {
  panelLeftWidth?: string;
  panelRightWidth?: string;
}

export async function getInitialPanelWidths(): Promise<InitialPanelWidths> {
  // Deliberately outside the try/catch below: cookies() is how Next marks
  // this route as dynamic during static-generation analysis (it signals via
  // a thrown DynamicServerError that a catch-all here would swallow,
  // producing a spurious build-time log without changing the outcome --
  // app/api/[...path]/route.ts's proxy calls it the same unguarded way).
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return {};

  try {
    const res = await fetch(`${BACKEND}/api/auth/preferences`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return {};

    const prefs: unknown = await res.json();
    if (typeof prefs !== "object" || prefs === null) return {};

    const result: InitialPanelWidths = {};
    const left = (prefs as Record<string, unknown>).panel_left_width;
    const right = (prefs as Record<string, unknown>).panel_right_width;
    if (typeof left === "string" && left) result.panelLeftWidth = left;
    if (typeof right === "string" && right) result.panelRightWidth = right;
    return result;
  } catch (err) {
    console.error("getInitialPanelWidths failed:", err);
    return {};
  }
}
