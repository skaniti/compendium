"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { TimeWindow } from "@/lib/types";

// Next equivalent of Dash's `dcc.Store(id="graph-time-window", data="all")`
// (app.py:400) -- the single source of truth for the DATE RANGE pills'
// active state. Task 8-C2 (header widget cards batch): only writer is the
// DATE RANGE card (components/HeaderCards.tsx), only reader this batch was
// that same card's active-pill className. Task A1-3 (batch 03) wires the
// actual graph time-window filter (Dash's filter_graph_by_time_window) as a
// second reader (components/GraphCanvas.tsx, via hooks/useGraph.ts's
// setWindow) -- the exported surface stayed minimal/stable through that so
// it landed as a pure addition, not a rework.
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

export default function TimeWindowProvider({ children }: { children: ReactNode }) {
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");

  const value = useMemo<TimeWindowContextValue>(() => ({ timeWindow, setTimeWindow }), [timeWindow]);

  return <TimeWindowContext.Provider value={value}>{children}</TimeWindowContext.Provider>;
}
