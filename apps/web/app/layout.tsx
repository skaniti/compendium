import type { ReactNode } from "react";
import { DEFAULT_VARIANT, generateCssText, getPaletteNames, getTokens } from "@/lib/theme";
import { getInitialSessionRole, getInitialThemeVariant } from "@/lib/preferences.server";
import ThemeProvider from "@/components/ThemeProvider";
import SessionProvider from "@/components/SessionProvider";

import "./styles/theme.css";
import "./styles/style.css";
import "./styles/dev-views.css";
import "./styles/pipeline-flow.css";
import "./styles/search-bar.css";
import "./styles/login.css";
import "./styles/starry-selector.css";
import "./styles/compendium-loader.css";

export const metadata = { title: "Compendium" };

// Same key ThemeProvider reads/writes -- keep in sync.
const THEME_STORAGE_KEY = "compendium-theme";

// Self-contained (no imports -- this text is inlined into a raw <script>
// tag) mirror of lib/theme.ts's normalizeVariant: strip a legacy " Dark"
// suffix, then fall back to the default for anything still unrecognized
// (e.g. a retired palette name persisted from old prefs).
//
// Runs before first paint (a head script blocks paint) and swaps every
// #theme-root style node's textContent to the localStorage-selected
// variant's CSS, so there is no flash of the server-rendered default
// palette. Targets ALL matching nodes via querySelectorAll, not just the
// first: React hydration later inserts a SECOND #theme-root into <head>
// (after the font style) alongside this server-emitted one, and the
// cascade only honors the LAST style element in document order -- writing
// to a single node (getElementById returns the first) left the second,
// React-owned node holding stale CSS that silently won. All 8 variants'
// CSS is embedded here (~6KB total) so the swap needs no network round
// trip. Exported test-only: app/layout.test.tsx evals the generated IIFE in
// jsdom to pin it against lib/theme.ts's normalizeVariant/getTokens/
// generateCssText -- the hand-rolled string logic below (strip trailing "
// Dark", unknown -> default) has to stay byte-for-byte in sync with that
// module by hand, since this script is inlined with no import of it.
export function buildThemeBootstrapScript(): string {
  const names = getPaletteNames();
  const cssByVariant: Record<string, string> = {};
  for (const name of names) {
    if (name === DEFAULT_VARIANT) continue; // already server-rendered below
    cssByVariant[name] = generateCssText(getTokens(name));
  }
  // Escape "</" so no embedded value can prematurely close the <script> tag.
  const payload = JSON.stringify({
    key: THEME_STORAGE_KEY,
    default: DEFAULT_VARIANT,
    names,
    css: cssByVariant,
  }).replace(/</g, "\\u003c");

  return `(function(){
  try {
    var d = ${payload};
    var raw = localStorage.getItem(d.key);
    if (!raw) return;
    var stripped = raw.slice(-5) === " Dark" ? raw.slice(0, -5) : raw;
    var variant = d.names.indexOf(stripped) !== -1 ? stripped : d.default;
    var css = d.css[variant];
    if (css) {
      var els = document.querySelectorAll('style#theme-root');
      for (var i = 0; i < els.length; i++) {
        els[i].textContent = css;
      }
    }
  } catch (e) {
    // localStorage can throw (disabled, private mode); leave the
    // server-rendered default styling intact.
  }
})();`;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const defaultCss = generateCssText(getTokens(DEFAULT_VARIANT));
  // Server-persisted theme seed (lib/preferences.server.ts's
  // getInitialThemeVariant) -- see ThemeProvider's own comment for why this
  // closes the authed-hydration-mismatch gap: SettingsMenu renders the
  // variant name as DOM text, so a server render that always used
  // DEFAULT_VARIANT while the client read a different persisted value from
  // localStorage produced a real hydration error. null (unauthed / read
  // failed) falls back to ThemeProvider's existing localStorage-derived
  // init unchanged.
  //
  // canPersist mirrors AppShell.tsx's isPlainDemo derivation exactly (see
  // that file's own comment): a plain, direct-login demo session (role
  // "demo", not an admin-launched acting-as-demo session) gets a 403 from
  // the backend's update_preferences endpoint on ANY PATCH, Dash parity --
  // so ThemeProvider must never schedule its debounced palette PATCH for
  // that session, even though reads (the seed above, and ThemeProvider's
  // own mount-time hydration GET) stay allowed. Independent read from
  // getInitialThemeVariant -- neither depends on the other's result -- run
  // concurrently rather than serializing two round-trips; the underlying
  // /api/auth/me fetch itself is ALSO shared with AppShell's own
  // getInitialSessionRole call in the same render pass, via fetchMeRow's
  // React.cache() wrapper (lib/preferences.server.ts), so calling it here
  // costs no extra network round-trip. Null/failed role reads default
  // canPersist to true -- same "swallow and fall back" contract as every
  // getInitialX reader in that module, and the same direction AppShell
  // already takes (isPlainDemo is false when the role can't be determined).
  const [initialTheme, { role: sessionRole, actingAsDemo }] = await Promise.all([
    getInitialThemeVariant(),
    getInitialSessionRole(),
  ]);
  const isPlainDemo = sessionRole === "demo" && !actingAsDemo;
  const canPersistTheme = !isPlainDemo;
  return (
    <html lang="en">
      <head>
        {/* Content may be overwritten by the bootstrap script below before
            hydration -- suppress the resulting (harmless) hydration warning. */}
        <style id="theme-root" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: defaultCss }} />
        {/* Raw <script>, deliberately NOT next/script: the no-flash guarantee
            requires a synchronous head script that blocks first paint, and
            next/script's beforeInteractive executes via the framework's async
            loader with no pre-paint guarantee ("does not block page
            hydration"). React DEV logs "Encountered a script tag while
            rendering" for this element on hydration -- known, dev-only, and
            harmless: the SSR'd copy has already executed by then. */}
        <script dangerouslySetInnerHTML={{ __html: buildThemeBootstrapScript() }} />
      </head>
      <body>
        {/* Scriptless-load fallback: CompendiumLoader's full-screen overlay
            (#compendium-loader.loader, app/styles/compendium-loader.css --
            position:fixed, inset:0, z-index:99999, background:var(--bg)) is
            plain SSR'd CSS, not JS-gated -- it paints regardless of
            scripting -- but its content and dismissal are entirely
            injected/driven by lib/vendor/compendium-loader.js, which never
            runs without JS. Without this, a scriptless visitor gets an
            opaque, permanent, textless curtain: a silent black page.
            <noscript> is the right primitive here rather than a JS-toggled
            element: the browser's own HTML parser only renders its contents
            as real markup when scripting is disabled, so this notice exists
            precisely for the visitors who need it and is otherwise inert --
            no client-side check required, and no interaction with the raw
            theme-bootstrap <script> above or React's own hydration.
            Inline styles only (no CSS-file dependency): the notice must
            stay legible even if every stylesheet above also failed to
            load, so this deliberately uses literal colors instead of the
            var(--bg)/var(--text) theme tokens the rest of the app relies
            on. z-index is set higher than the loader's 99999 so this wins
            the stacking comparison unconditionally, regardless of DOM
            order relative to wherever CompendiumLoader ends up mounted. */}
        <noscript>
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 2147483647,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: "24px",
              boxSizing: "border-box",
              background: "#000",
              color: "#fff",
              fontFamily: "Georgia, serif",
              fontSize: "1.1rem",
            }}
          >
            compendium requires JavaScript to run. Please enable JavaScript in your browser and reload the page.
          </div>
        </noscript>
        {/* SessionProvider (D4/D5, batch 04) hydrates {role, account,
            actingAsDemo, ...} from GET /api/auth/me and mounts
            SessionKeeper (D2, activity-scoped sliding refresh) internally
            with suspended={actingAsDemo} -- this file is a server
            component and can't read that context itself, so the wiring
            lives inside SessionProvider.tsx (see its own comment for why
            suspension exists). Wraps ThemeProvider/{children} too so
            Header (nested further down, in AppShell) can call
            useSession(). */}
        <SessionProvider>
          <ThemeProvider initialVariant={initialTheme} canPersist={canPersistTheme}>
            {children}
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
