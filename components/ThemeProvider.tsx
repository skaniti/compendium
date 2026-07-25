"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_VARIANT, generateCssText, getTokens, normalizeVariant } from "@/lib/theme";
import { getPreferences, patchPreferences } from "@/lib/preferences";

// Same localStorage key the pre-paint bootstrap script in app/layout.tsx
// reads before React ever mounts -- keep these in sync.
const STORAGE_KEY = "compendium-theme";

// Settle briefly before writing the palette choice back to the server so a
// user clicking through several swatches doesn't fire a PATCH per click.
const PATCH_DEBOUNCE_MS = 400;

interface ThemeContextValue {
  variant: string;
  setVariant: (variant: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

function readStoredVariant(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeVariant(raw) : DEFAULT_VARIANT;
  } catch {
    // localStorage can throw (disabled, private-mode quota, SSR); fall back
    // to the same default the server already painted.
    return DEFAULT_VARIANT;
  }
}

function writeStoredVariant(variant: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, variant);
  } catch {
    // Non-fatal -- the in-memory/DOM state is still correct for this tab.
  }
}

// Targets EVERY #theme-root style node, not just the first: React
// hydration inserts a SECOND #theme-root into <head> (after the font
// style) alongside the server-emitted one the pre-paint bootstrap script
// (app/layout.tsx's buildThemeBootstrapScript) mutated. The cascade only
// honors the LAST style element in document order, so document
// .getElementById (first match only) would write CSS the browser then
// silently ignores -- observed live as a palette pick that "took" in the
// DOM but never changed anything on screen. Writing to both nodes is
// harmless: once they agree, which one "wins" the cascade doesn't matter.
function applyToDom(variant: string): void {
  const css = generateCssText(getTokens(variant));
  document.querySelectorAll("style#theme-root").forEach((el) => {
    el.textContent = css;
  });
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy initializer runs in the real browser during the first client
  // render, so this already matches whatever the pre-paint script painted
  // (localStorage-derived) -- no extra rewrite/flash on mount. During SSR
  // `localStorage` doesn't exist, readStoredVariant's try/catch falls back
  // to DEFAULT_VARIANT, which is also what the server rendered into
  // #theme-root -- and since no DOM here depends on `variant` directly,
  // that transient SSR-vs-client difference is not a hydration mismatch.
  const [variant, setVariantState] = useState<string>(() => readStoredVariant());
  // Mirrors `variant` so the async hydration callback below can read the
  // *latest* value (it may run well after mount, after a user setVariant
  // call) without relying on a state-updater closure. Every place that
  // calls setVariantState updates this in the same synchronous step.
  const variantRef = useRef(variant);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set once setVariant has been called explicitly by the user (never
  // cleared -- there's no "un-choosing" a palette this session). Guards
  // against the residual hydration race: a SLOW mount-time preferences GET
  // that resolves AFTER the user has already picked a palette must not
  // clobber that fresh choice with whatever was persisted before the
  // click -- see the hydration effect below, which checks this ref before
  // doing anything with the server's response.
  const userDirtyRef = useRef(false);

  function updateVariant(next: string): void {
    variantRef.current = next;
    setVariantState(next);
  }

  // Server preference wins over localStorage when they disagree (e.g. the
  // user switched palettes on another device). Applies the server value and
  // writes it back to localStorage; deliberately does NOT re-PATCH, since
  // the value just came from the server.
  //
  // Every exit path below ends with an applyToDom(variantRef.current) call
  // (except the true early-out at `cancelled`, which unmounted before there
  // was anything left to correct) -- an idempotent re-assert onto every
  // #theme-root node, including a React-inserted stale duplicate. Without
  // this, a mount where the server value equals what's already applied
  // (the common case) took the early-return branches below and never
  // re-wrote the DOM at all, so a stale second #theme-root node from
  // hydration was left holding the wrong CSS indefinitely -- see
  // applyToDom's own comment for the full mechanism.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await getPreferences();
        if (cancelled) return;
        if (userDirtyRef.current) {
          // The user explicitly picked a variant (setVariant) sometime
          // between mount and this GET resolving -- their choice wins
          // outright, full stop. In particular this must NOT fall through
          // to the "server fully wins" branch below: that branch cancels
          // any pending debounced PATCH, which here would silently drop
          // the user's own in-flight write (the exact bug this guards
          // against -- a slow GET landing after a click used to both
          // revert the visible variant AND cancel the PATCH that would
          // have persisted it). Still re-assert onto every #theme-root
          // node (74c4da0) since a React-inserted duplicate node may not
          // have this variant's CSS yet.
          applyToDom(variantRef.current);
          return;
        }
        const serverTheme = prefs.theme;
        if (typeof serverTheme !== "string") {
          applyToDom(variantRef.current);
          return;
        }
        const serverVariant = normalizeVariant(serverTheme);
        // Read the latest variant via the ref, not the `variant` closed
        // over at mount -- a setVariant() call can race this in-flight GET
        // and land first. Decision computed here, outside any state
        // updater (state updaters must stay pure / can double-invoke under
        // StrictMode); the actual setVariantState call below is a plain,
        // side-effect-free call.
        if (serverVariant === variantRef.current) {
          applyToDom(variantRef.current);
          return;
        }

        // Server fully wins: if a setVariant() call raced this GET and
        // already scheduled a debounced PATCH, cancel it. Otherwise that
        // stale PATCH fires ~400ms later and writes the user's overridden
        // choice back to the server, ping-ponging the palette across
        // reloads (server value here, user's old value there).
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        updateVariant(serverVariant);
        applyToDom(serverVariant);
        writeStoredVariant(serverVariant);
      } catch (err) {
        // A failed preference read must never break the UI -- keep
        // whatever variant is already applied (pre-paint/localStorage), but
        // still re-assert it onto every #theme-root node.
        console.error("ThemeProvider: failed to hydrate server preference:", err);
        if (!cancelled) applyToDom(variantRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const setVariant = (next: string) => {
    const normalized = normalizeVariant(next);
    userDirtyRef.current = true;
    updateVariant(normalized);
    applyToDom(normalized);
    writeStoredVariant(normalized);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void patchPreferences({ theme: normalized });
    }, PATCH_DEBOUNCE_MS);
  };

  return <ThemeContext.Provider value={{ variant, setVariant }}>{children}</ThemeContext.Provider>;
}
