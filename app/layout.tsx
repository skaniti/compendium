import type { ReactNode } from "react";
import { DEFAULT_VARIANT, generateCssText, getPaletteNames, getTokens } from "@/lib/theme";
import ThemeProvider from "@/components/ThemeProvider";

import "./styles/theme.css";
import "./styles/style.css";
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
// Runs before first paint (a head script blocks paint) and swaps
// #theme-root's textContent to the localStorage-selected variant's CSS, so
// there is no flash of the server-rendered default palette. All 8 variants'
// CSS is embedded here (~6KB total) so the swap needs no network round trip.
// Exported test-only: app/layout.test.tsx evals the generated IIFE in jsdom
// to pin it against lib/theme.ts's normalizeVariant/getTokens/generateCssText
// -- the hand-rolled string logic below (strip trailing " Dark", unknown ->
// default) has to stay byte-for-byte in sync with that module by hand, since
// this script is inlined with no import of it.
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
      var el = document.getElementById("theme-root");
      if (el) el.textContent = css;
    }
  } catch (e) {
    // localStorage can throw (disabled, private mode); leave the
    // server-rendered default styling intact.
  }
})();`;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const defaultCss = generateCssText(getTokens(DEFAULT_VARIANT));
  return (
    <html lang="en">
      <head>
        {/* Content may be overwritten by the bootstrap script below before
            hydration -- suppress the resulting (harmless) hydration warning. */}
        <style id="theme-root" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: defaultCss }} />
        <script dangerouslySetInnerHTML={{ __html: buildThemeBootstrapScript() }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
