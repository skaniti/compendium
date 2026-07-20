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

export interface InitialCompendiumLoaderState {
  // Drives components/CompendiumLoader.tsx's first-run/return mode split
  // -- mirrors compendium_loader.py's `"return" if has_seen else
  // "first-run"`. false on any auth/fetch failure, same "swallow and fall
  // back" contract as the rest of this module (falls back to showing the
  // first-run tutorial, not silently skipping it).
  hasSeen: boolean;
  // Mirrors compendium_loader.py's `user_id is not None` -> non-empty
  // data-user-id -> canPersist gate in the vendor JS: true once we have a
  // resolvable authenticated session (a valid token AND a successful
  // preferences read), so the loader's first-run dismiss knows whether
  // persisting the seen-flag is meaningful. false on any auth/fetch
  // failure -- same fallback direction as hasSeen (degrade to "don't
  // persist" rather than risk writing on an unauthenticated request).
  canPersist: boolean;
}

// Server-side counterpart to CompendiumLoader's client-side seeding: reads
// the signed-in user's persisted `compendium_loader_seen` preference
// before first paint (mirrors compendium_loader.py's `has_seen` resolution,
// its own comment on :152-155 explains why this must happen server-side --
// "eliminates the brief first-run flash that a pure-localStorage
// implementation can't avoid") so AppShell can pass both fields down as
// CompendiumLoader's initialHasSeen/canPersist props with no client-side
// GET and no flash of the wrong mode. Same cookie-JWT-direct-to-backend
// pattern as getInitialPanelWidths/getInitialStarfieldVariant above
// (duplicated per that established per-concern-fetch convention, not
// shared).
export async function getInitialCompendiumLoaderSeen(): Promise<InitialCompendiumLoaderState> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return { hasSeen: false, canPersist: false };

  try {
    const res = await fetch(`${BACKEND}/api/auth/preferences`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { hasSeen: false, canPersist: false };

    const prefs: unknown = await res.json();
    if (typeof prefs !== "object" || prefs === null) {
      // A valid, authenticated session is still confirmed even though the
      // body was unusable -- canPersist reflects "do we have a real
      // user", not "did we manage to read has_seen".
      return { hasSeen: false, canPersist: true };
    }

    const seen = (prefs as Record<string, unknown>).compendium_loader_seen;
    return { hasSeen: seen === true, canPersist: true };
  } catch (err) {
    console.error("getInitialCompendiumLoaderSeen failed:", err);
    return { hasSeen: false, canPersist: false };
  }
}

export interface InitialSessionRole {
  // Backend's `role` field off GET /api/auth/me -- "admin" | "demo" |
  // "user", or null when unauthenticated, the /me read failed, or the
  // role string wasn't one of the three recognized values. Deliberately
  // mirrors components/SessionProvider.tsx's own isSessionRole/deriveState
  // mapping (that module's comment explains why an unrecognized role is
  // never trusted) -- duplicated here rather than imported, same reasoning
  // as this file's STARFIELD_VARIANTS duplicate above: SessionProvider.tsx
  // is a "use client" module, and this file pulls in next/headers, so
  // there's no shared runtime module the two sides could both import from
  // without breaking one side of the boundary.
  role: "admin" | "demo" | "user" | null;
  // Backend's `acting_as_demo` claim (true only for an admin-launched
  // view-as-demo session) -- false on any auth/fetch failure, same
  // "swallow and fall back" contract as the rest of this module.
  actingAsDemo: boolean;
}

// Server-side counterpart to SessionProvider's client-side hydration
// (GET /api/auth/me): reads the signed-in user's role + acting-as-demo
// state before first paint so AppShell can force CompendiumLoader straight
// to "return" mode for the demo role (gate-2 walkthrough fix 3, Dash
// parity -- Dash bakes data-mode="return" for role demo unconditionally,
// it NEVER serves the first-run tutorial to a demo session, admin-launched
// or direct). Same cookie-JWT-direct-to-backend pattern as the other
// getInitialX functions in this module; same "swallow and fall back"
// contract (role: null, actingAsDemo: false) on any auth/fetch failure --
// AppShell's own composition falls back to compendiumLoaderSeen/
// compendiumLoaderCanPersist unchanged in that case (see its own comment).
export async function getInitialSessionRole(): Promise<InitialSessionRole> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return { role: null, actingAsDemo: false };

  try {
    const res = await fetch(`${BACKEND}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { role: null, actingAsDemo: false };

    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return { role: null, actingAsDemo: false };

    const rawRole = (data as Record<string, unknown>).role;
    const role = rawRole === "admin" || rawRole === "demo" || rawRole === "user" ? rawRole : null;
    const actingAsDemo = (data as Record<string, unknown>).acting_as_demo === true;
    return { role, actingAsDemo };
  } catch (err) {
    console.error("getInitialSessionRole failed:", err);
    return { role: null, actingAsDemo: false };
  }
}
