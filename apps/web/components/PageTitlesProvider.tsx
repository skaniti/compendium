"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { patchPreferences } from "@/lib/preferences";

// Context for the PAGE TITLES preference (`show_page_titles`, default
// false): whether the graph draws a title next to every page dot. Off
// because the owner reads the graph by cluster names and the page titles
// crowded them out (vendor header comment delta #41). Same server-seeded
// shape as StarfieldProvider/TimeWindowProvider: AppShell reads the stored
// value before first paint (getInitialShowPageTitles) and passes it down as
// `initialShow`, so there is no client-side GET and nothing to race.
// Readers: SettingsMenu's PAGE TITLES pills (usePageTitles) and
// GraphCanvas, which pushes the value into the vendor graph
// (useOptionalPageTitles, since GraphCanvas also mounts without a provider
// in its own tests).

export interface PageTitlesContextValue {
  show: boolean;
  setShow: (show: boolean) => void;
}

const PageTitlesContext = createContext<PageTitlesContextValue | null>(null);

// Mirrors useStarfield's throw-outside-provider idiom.
export function usePageTitles(): PageTitlesContextValue {
  const ctx = useContext(PageTitlesContext);
  if (!ctx) throw new Error("usePageTitles must be used within a PageTitlesProvider");
  return ctx;
}

// Same as usePageTitles() but returns null outside a provider, for
// readers (GraphCanvas) that must also work without one.
export function useOptionalPageTitles(): PageTitlesContextValue | null {
  return useContext(PageTitlesContext);
}

export default function PageTitlesProvider({
  initialShow = false,
  canPersist = true,
  children,
}: {
  initialShow?: boolean;
  // Demo sessions get a 403 from the backend on ANY preferences PATCH (see
  // AppShell's canPersistPreferences). false skips the write; the state
  // change, and so the live graph, still updates for the session.
  canPersist?: boolean;
  children: ReactNode;
}) {
  const [show, setShowState] = useState<boolean>(initialShow === true);

  // Applied immediately and persisted without a debounce: two discrete
  // pills are not a click-through-many UI (same call as StarfieldProvider).
  const setShow = useCallback(
    (next: boolean) => {
      setShowState(next);
      if (canPersist) void patchPreferences({ show_page_titles: next });
    },
    [canPersist]
  );

  const value = useMemo<PageTitlesContextValue>(() => ({ show, setShow }), [show, setShow]);

  return <PageTitlesContext.Provider value={value}>{children}</PageTitlesContext.Provider>;
}
