"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { patchPreferences } from "@/lib/preferences";
import type { TimeWindow } from "@/lib/types";

// Next equivalent of Dash's `dcc.Store(id="graph-time-window", data="all")`
// (app.py:400) -- the single source of truth for the active time period.
// The value is persisted per user (preference `time_window`, seeded from
// `initialWindow`, which AppShell reads server-side) and is written by both
// the graph's DATE RANGE card (components/HeaderCards.tsx) and the Pipeline
// view's range pills. Readers: those same controls' active state, and the
// graph itself (components/GraphCanvas.tsx via hooks/useGraph.ts, whose
// first load uses this value so a saved period costs a single request).
//
// TimeWindow itself now lives in lib/types.ts (moved at A1-3 so lib/api.ts
// and hooks/useGraph.ts can reference it without importing from
// components/) -- re-exported here under its original name so this
// file's existing importers (HeaderCards.tsx) are unaffected.
export type { TimeWindow };

export interface TimeWindowContextValue {
  timeWindow: TimeWindow;
  setTimeWindow: (value: TimeWindow) => void;
}

const TimeWindowContext = createContext<TimeWindowContextValue | null>(null);

// Mirrors useNav's throw-outside-provider idiom (components/NavProvider.tsx).
export function useTimeWindow(): TimeWindowContextValue {
  const ctx = useContext(TimeWindowContext);
  if (!ctx) throw new Error("useTimeWindow must be used within a TimeWindowProvider");
  return ctx;
}

// Same as useTimeWindow() but returns null outside a provider, for readers
// (hooks/useGraph.ts) that must also work without one.
export function useOptionalTimeWindow(): TimeWindowContextValue | null {
  return useContext(TimeWindowContext);
}

export default function TimeWindowProvider({
  children,
  initialWindow = "all",
  canPersist = false,
}: {
  children: ReactNode;
  initialWindow?: TimeWindow;
  canPersist?: boolean;
}) {
  const [timeWindow, setWindowState] = useState<TimeWindow>(initialWindow);

  // Persisted as preference `time_window` (fire-and-forget; patchPreferences
  // swallows and logs its own errors). Skipped when the value is unchanged.
  const setTimeWindow = useCallback(
    (value: TimeWindow) => {
      setWindowState(value);
      if (canPersist && value !== timeWindow) void patchPreferences({ time_window: value });
    },
    [canPersist, timeWindow]
  );

  const value = useMemo<TimeWindowContextValue>(() => ({ timeWindow, setTimeWindow }), [timeWindow, setTimeWindow]);

  return <TimeWindowContext.Provider value={value}>{children}</TimeWindowContext.Provider>;
}
