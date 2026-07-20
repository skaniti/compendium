import { describe, it, expect, beforeEach } from "vitest";
import { buildThemeBootstrapScript } from "./layout";
import { DEFAULT_VARIANT, generateCssText, getTokens, normalizeVariant } from "@/lib/theme";

const STORAGE_KEY = "compendium-theme";

// Pins app/layout.tsx's hand-rolled inline pre-paint bootstrap IIFE -- a
// string-form, import-free mirror of lib/theme.ts's normalizeVariant,
// necessary because the script has to run in a raw <script> tag before
// React/webpack modules exist -- against the real
// normalizeVariant/getTokens/generateCssText. Without this, a palette
// rename or a normalizeVariant tweak could silently desync the two copies;
// the mismatch would only surface as a first-paint flash of the wrong
// palette on a real browser with stale localStorage, never in a unit test.

function seedThemeRoot(): HTMLStyleElement {
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.id = "theme-root";
  // Matches RootLayout's real SSR output: #theme-root is pre-populated with
  // DEFAULT_VARIANT's CSS before the bootstrap script below ever runs.
  style.textContent = generateCssText(getTokens(DEFAULT_VARIANT));
  document.body.appendChild(style);
  return style;
}

// React hydration inserts a SECOND #theme-root into <head> (after the font
// style) alongside the server-emitted one this script mutates -- see
// buildThemeBootstrapScript's own comment. Seeds two nodes so the
// querySelectorAll-based write is pinned to touch both, not just the first
// (document.getElementById would silently miss the second).
function seedTwoThemeRoots(): [HTMLStyleElement, HTMLStyleElement] {
  document.body.innerHTML = "";
  const nodes = [0, 1].map(() => {
    const style = document.createElement("style");
    style.id = "theme-root";
    style.textContent = generateCssText(getTokens(DEFAULT_VARIANT));
    document.body.appendChild(style);
    return style;
  });
  return nodes as [HTMLStyleElement, HTMLStyleElement];
}

function runBootstrapScript(): void {
  // Test-only eval of a string this same test file's own build step
  // produced (buildThemeBootstrapScript() over lib/theme-goldens.json) --
  // not untrusted/external input. It returns a self-executing
  // `(function(){...})();` string; eval it directly so the test exercises
  // the exact code that ships in the <script> tag (the whole point of this
  // test is pinning that literal string), rather than reimplementing its
  // logic here, which would test the reimplementation instead of the
  // shipped script.
  // eslint-disable-next-line no-eval
  eval(buildThemeBootstrapScript());
}

describe("buildThemeBootstrapScript stays in sync with lib/theme.ts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("resolves a bare known palette name the same as normalizeVariant", () => {
    const stored = "Pink";
    localStorage.setItem(STORAGE_KEY, stored);
    const style = seedThemeRoot();

    runBootstrapScript();

    expect(style.textContent).toBe(generateCssText(getTokens(normalizeVariant(stored))));
    expect(normalizeVariant(stored)).toBe("Pink"); // sanity: this case is not a no-op
  });

  it("strips a legacy ' Dark'-suffixed name the same as normalizeVariant", () => {
    const stored = "Pink Dark";
    localStorage.setItem(STORAGE_KEY, stored);
    const style = seedThemeRoot();

    runBootstrapScript();

    expect(style.textContent).toBe(generateCssText(getTokens(normalizeVariant(stored))));
    expect(normalizeVariant(stored)).toBe("Pink");
  });

  it("falls back to the default for a retired palette name the same as normalizeVariant", () => {
    const stored = "Yellow";
    localStorage.setItem(STORAGE_KEY, stored);
    const style = seedThemeRoot();

    runBootstrapScript();

    expect(style.textContent).toBe(generateCssText(getTokens(normalizeVariant(stored))));
    expect(normalizeVariant(stored)).toBe(DEFAULT_VARIANT);
  });

  it("falls back to the default for garbage input the same as normalizeVariant", () => {
    const stored = "not-a-real-palette-!!";
    localStorage.setItem(STORAGE_KEY, stored);
    const style = seedThemeRoot();

    runBootstrapScript();

    expect(style.textContent).toBe(generateCssText(getTokens(normalizeVariant(stored))));
    expect(normalizeVariant(stored)).toBe(DEFAULT_VARIANT);
  });

  it("leaves the server-rendered default CSS untouched when localStorage is empty", () => {
    const style = seedThemeRoot();
    const before = style.textContent;

    runBootstrapScript();

    expect(style.textContent).toBe(before);
  });

  it("writes the swapped CSS onto EVERY #theme-root node, not just the first (React-inserted duplicate)", () => {
    // Regression: React hydration inserts a second #theme-root into <head>
    // alongside the server-emitted one this script mutates pre-paint. A
    // getElementById-based write only reaches the first node; the browser
    // cascade honors the LAST style element in document order, so the
    // second node's stale CSS silently won even though the "first" node
    // looked correct in the DOM.
    const stored = "Pink";
    localStorage.setItem(STORAGE_KEY, stored);
    const [first, second] = seedTwoThemeRoots();

    runBootstrapScript();

    const expectedCss = generateCssText(getTokens(normalizeVariant(stored)));
    expect(first.textContent).toBe(expectedCss);
    expect(second.textContent).toBe(expectedCss);
  });
});
