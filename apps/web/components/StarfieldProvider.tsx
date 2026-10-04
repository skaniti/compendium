"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { patchPreferences } from "@/lib/preferences";

// ThemeProvider-adjacent context for the STARFIELD preference, but
// deliberately simpler: ThemeProvider seeds from localStorage and
// reconciles against a mount-time GET, which needed a variantRef +
// debounce-cancel dance to close a real race between a user click and the
// in-flight hydration (see ThemeProvider.tsx + its test suite). Starfield
// avoids that race entirely by seeding server-side instead: AppShell (a
// server component) already reads preferences before first paint for the
// panel widths, so it reads the starfield variant the same way and passes
// it down as `initialVariant` here -- no client-side GET, nothing to race.

// Canonical client-side copy of the validated starfield values (Dash:
// app.py:76-85 validates against this exact tuple; graph_canvas.py:75's
// STARRY_SKY_VARIANT default is "twinkle"). SettingsMenu.tsx imports this
// export rather than keeping its own copy. lib/preferences.server.ts keeps
// a SEPARATE copy of the same literal instead of importing from here:
// that module pulls in next/headers (server-only) via `cookies()`, and
// this is a client component -- Next forbids that module boundary
// crossing even for an unrelated named export (see that file's comment).
export const STARFIELD_VARIANTS = ["none", "twinkle", "pan", "hyperspace"] as const;
export const DEFAULT_STARFIELD_VARIANT = "twinkle";

interface StarfieldContextValue {
  variant: string;
  setVariant: (variant: string) => void;
}

const StarfieldContext = createContext<StarfieldContextValue | null>(null);

export function useStarfield(): StarfieldContextValue {
  const ctx = useContext(StarfieldContext);
  if (!ctx) throw new Error("useStarfield must be used within a StarfieldProvider");
  return ctx;
}

// Same fallback-on-anything-unrecognized contract as lib/theme.ts's
// normalizeVariant: never throws, sanitizes an untrusted persisted/passed
// value down to a known variant.
function normalizeStarfieldVariant(name: string): string {
  return (STARFIELD_VARIANTS as readonly string[]).includes(name)
    ? name
    : DEFAULT_STARFIELD_VARIANT;
}

export default function StarfieldProvider({
  initialVariant = DEFAULT_STARFIELD_VARIANT,
  canPersist = true,
  children,
}: {
  initialVariant?: string;
  // Demo sessions (AppShell.tsx's isDemo: a direct demo login or an admin
  // viewing as demo) get a 403 from the backend's update_preferences
  // endpoint on ANY PATCH. false skips the patchPreferences call below
  // entirely; the state update (and thus the visible pill change) still
  // happens. Defaults to true so every existing call site behaves exactly
  // as before this prop existed.
  canPersist?: boolean;
  children: ReactNode;
}) {
  const [variant, setVariantState] = useState<string>(() =>
    normalizeStarfieldVariant(initialVariant)
  );

  // Brief: "on pill click apply immediately + persist" -- no debounce
  // (unlike the palette swatches, a handful of discrete starfield pills
  // aren't a click-through-many UI, so there's no rapid-fire case to
  // coalesce).
  const setVariant = (next: string) => {
    const normalized = normalizeStarfieldVariant(next);
    setVariantState(normalized);
    if (canPersist) void patchPreferences({ starfield: normalized });
  };

  return (
    <StarfieldContext.Provider value={{ variant, setVariant }}>
      {children}
    </StarfieldContext.Provider>
  );
}
