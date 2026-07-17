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

function applyToDom(variant: string): void {
  const el = document.getElementById("theme-root");
  if (el) el.textContent = generateCssText(getTokens(variant));
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server preference wins over localStorage when they disagree (e.g. the
  // user switched palettes on another device). Applies the server value and
  // writes it back to localStorage; deliberately does NOT re-PATCH, since
  // the value just came from the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await getPreferences();
        if (cancelled) return;
        const serverTheme = prefs.theme;
        if (typeof serverTheme !== "string") return;
        const serverVariant = normalizeVariant(serverTheme);
        setVariantState((current) => {
          if (serverVariant === current) return current;
          applyToDom(serverVariant);
          writeStoredVariant(serverVariant);
          return serverVariant;
        });
      } catch (err) {
        // A failed preference read must never break the UI -- keep
        // whatever variant is already applied (pre-paint/localStorage).
        console.error("ThemeProvider: failed to hydrate server preference:", err);
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
    setVariantState(normalized);
    applyToDom(normalized);
    writeStoredVariant(normalized);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void patchPreferences({ theme: normalized });
    }, PATCH_DEBOUNCE_MS);
  };

  return <ThemeContext.Provider value={{ variant, setVariant }}>{children}</ThemeContext.Provider>;
}
