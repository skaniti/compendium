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

// Same validated starfield values + default as the Dash side (app.py:76-85
// validates against this exact tuple; graph_canvas.py:75's STARRY_SKY_VARIANT
// is "twinkle") and components/StarfieldProvider.tsx's client-side copy.
// Kept as a SEPARATE literal here rather than importing StarfieldProvider's
// export: this module pulls in next/headers (`cookies()` below), and that's
// a server-only import a client component can never take on, even
// transitively through an unrelated named export -- so the two copies
// can't be unified without breaking one side of the boundary.
const STARFIELD_VARIANTS = ["none", "twinkle", "pan", "hyperspace"] as const;
export const DEFAULT_STARFIELD_VARIANT = "twinkle";

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

// Server-side counterpart to StarfieldProvider's client-side seeding: reads
// the signed-in user's persisted starfield variant before first paint
// (mirrors app.py's _active_starfield resolution, :74-85) so AppShell can
// pass it down as StarfieldProvider's initialVariant prop with no
// client-side GET and no flash of the wrong variant. Same
// cookie-JWT-direct-to-backend pattern as getInitialPanelWidths above
// (duplicated rather than shared, matching that function's own established
// per-concern-fetch shape); falls back to DEFAULT_STARFIELD_VARIANT on any
// failure or invalid/missing persisted value, same "swallow and fall back"
// contract as the rest of this module.
export async function getInitialStarfieldVariant(): Promise<string> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return DEFAULT_STARFIELD_VARIANT;

  try {
    const res = await fetch(`${BACKEND}/api/auth/preferences`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return DEFAULT_STARFIELD_VARIANT;

    const prefs: unknown = await res.json();
    if (typeof prefs !== "object" || prefs === null) return DEFAULT_STARFIELD_VARIANT;

    const starfield = (prefs as Record<string, unknown>).starfield;
    return typeof starfield === "string" &&
      (STARFIELD_VARIANTS as readonly string[]).includes(starfield)
      ? starfield
      : DEFAULT_STARFIELD_VARIANT;
  } catch (err) {
    console.error("getInitialStarfieldVariant failed:", err);
    return DEFAULT_STARFIELD_VARIANT;
  }
}
