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
import { cache } from "react";
import { cookies } from "next/headers";
import { getPaletteNames, normalizeVariant } from "@/lib/theme";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// getInitialPanelWidths / getInitialStarfieldVariant /
// getInitialCompendiumLoaderSeen all read different fields off the SAME
// GET /api/auth/preferences row for the same token -- AppShell calls all
// three (plus getInitialSessionRole, a different endpoint) concurrently via
// Promise.all, which without this would fire three duplicate GETs per page
// load. React.cache() memoizes this per Server render pass (a per-request
// cache in the real Next.js RSC runtime -- see the "no-op outside of it"
// note in preferences.server.test.ts, where it's verified via a mocked
// `cache` instead), so the three readers below share one round-trip. Keyed
// on the token (not on nothing), since a differently-authenticated
// concurrent request must never share another request's cached response.
//
// Returns a discriminated result rather than throwing/returning a bare
// value: callers need to tell "fetch failed / non-ok" apart from "fetch
// succeeded but the body wasn't a usable object" (getInitialCompendiumLoaderSeen's
// canPersist is true in the latter case -- a real authenticated session was
// confirmed even though the body was unusable -- but false in the former).
type PreferencesFetchResult = { ok: true; body: unknown } | { ok: false };

const fetchPreferencesRow = cache(async (token: string): Promise<PreferencesFetchResult> => {
  try {
    const res = await fetch(`${BACKEND}/api/auth/preferences`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json();
    return { ok: true, body };
  } catch (err) {
    console.error("preferences fetch failed:", err);
    return { ok: false };
  }
});

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

  const fetched = await fetchPreferencesRow(token);
  if (!fetched.ok) return {};

  const prefs = fetched.body;
  if (typeof prefs !== "object" || prefs === null) return {};

  const result: InitialPanelWidths = {};
  const left = (prefs as Record<string, unknown>).panel_left_width;
  const right = (prefs as Record<string, unknown>).panel_right_width;
  if (typeof left === "string" && left) result.panelLeftWidth = left;
  if (typeof right === "string" && right) result.panelRightWidth = right;
  return result;
}

// Server-side counterpart to StarfieldProvider's client-side seeding: reads
// the signed-in user's persisted starfield variant before first paint
// (mirrors app.py's _active_starfield resolution, :74-85) so AppShell can
// pass it down as StarfieldProvider's initialVariant prop with no
// client-side GET and no flash of the wrong variant. Same
// cookie-JWT-direct-to-backend pattern as getInitialPanelWidths above --
// the underlying fetch itself IS shared with it (and with
// getInitialCompendiumLoaderSeen) through fetchPreferencesRow's
// React.cache() wrapper above, so calling this alongside those costs no
// extra network round-trip; falls back to DEFAULT_STARFIELD_VARIANT on any
// failure or invalid/missing persisted value, same "swallow and fall back"
// contract as the rest of this module.
export async function getInitialStarfieldVariant(): Promise<string> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return DEFAULT_STARFIELD_VARIANT;

  const fetched = await fetchPreferencesRow(token);
  if (!fetched.ok) return DEFAULT_STARFIELD_VARIANT;

  const prefs = fetched.body;
  if (typeof prefs !== "object" || prefs === null) return DEFAULT_STARFIELD_VARIANT;

  const starfield = (prefs as Record<string, unknown>).starfield;
  return typeof starfield === "string" &&
    (STARFIELD_VARIANTS as readonly string[]).includes(starfield)
    ? starfield
    : DEFAULT_STARFIELD_VARIANT;
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
// pattern as getInitialPanelWidths/getInitialStarfieldVariant above -- and,
// like those two, the underlying fetch itself IS shared with them through
// fetchPreferencesRow's React.cache() wrapper above (one round-trip backs
// all three readers when called together, as AppShell does).
export async function getInitialCompendiumLoaderSeen(): Promise<InitialCompendiumLoaderState> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return { hasSeen: false, canPersist: false };

  const fetched = await fetchPreferencesRow(token);
  if (!fetched.ok) return { hasSeen: false, canPersist: false };

  const prefs = fetched.body;
  if (typeof prefs !== "object" || prefs === null) {
    // A valid, authenticated session is still confirmed even though the
    // body was unusable -- canPersist reflects "do we have a real
    // user", not "did we manage to read has_seen".
    return { hasSeen: false, canPersist: true };
  }

  const seen = (prefs as Record<string, unknown>).compendium_loader_seen;
  return { hasSeen: seen === true, canPersist: true };
}

// Server-side counterpart to ThemeProvider's client-side seeding: reads the
// signed-in user's persisted theme variant before first paint so
// RootLayout can pass it down as ThemeProvider's initialVariant prop.
// Without this, ThemeProvider's initial render always used DEFAULT_VARIANT
// server-side while the client's post-hydration localStorage read could
// diverge (any authed page load where the saved palette isn't the default)
// -- SettingsMenu renders the variant name as DOM text
// (`#theme-active-name`), so that divergence was a real hydration mismatch,
// not merely a same-render inert value. Same cookie-JWT-direct-to-backend
// pattern as the other readers in this module, and the underlying fetch
// itself IS shared with them through fetchPreferencesRow's React.cache()
// wrapper above -- calling this alongside the other three costs no extra
// network round-trip. Returns null (not a default variant name) on any
// failure or invalid/missing/unrecognized persisted value -- ThemeProvider
// treats null as "no seed", falling back to its existing
// localStorage-derived init exactly as before this reader existed.
export async function getInitialThemeVariant(): Promise<string | null> {
  // Deliberately outside the try/catch below -- see the comment on the
  // equivalent line in getInitialPanelWidths.
  const token = (await cookies()).get("access_token")?.value;
  if (!token) return null;

  const fetched = await fetchPreferencesRow(token);
  if (!fetched.ok) return null;

  const prefs = fetched.body;
  if (typeof prefs !== "object" || prefs === null) return null;

  const theme = (prefs as Record<string, unknown>).theme;
  if (typeof theme !== "string") return null;

  // normalizeVariant's own contract (lib/theme.ts) guarantees its return
  // value is ALWAYS a recognized palette name -- unrecognized input is
  // silently mapped to DEFAULT_VARIANT rather than signaled as "unknown".
  // That fallback is right for client-side init (paint SOMETHING rather
  // than nothing), but wrong here: a corrupt DB value must resolve to null
  // (no seed -- ThemeProvider falls back to its existing
  // localStorage-derived init) rather than a false-confidence "Brown" that
  // looks like a genuinely persisted choice and would override localStorage
  // as if it were one. So a plain `getPaletteNames().includes(normalized)`
  // check can't detect "unknown" -- it would always be true. Detect the
  // fallback directly instead: `theme` is genuine only if it was already a
  // bare known name, or a known name with the legacy " Dark" suffix
  // normalizeVariant strips.
  const normalized = normalizeVariant(theme);
  const names = getPaletteNames();
  const isGenuine = names.includes(theme) || `${normalized} Dark` === theme;
  return isGenuine ? normalized : null;
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
