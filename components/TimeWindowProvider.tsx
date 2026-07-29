"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// Next equivalent of Dash's `dcc.Store(id="graph-time-window", data="all")`
// (app.py:400) -- the single source of truth for the DATE RANGE pills'
// active state. Task 8-C2 (header widget cards batch): only writer is the
// DATE RANGE card (components/HeaderCards.tsx), only reader this batch is
// that same card's active-pill className. Batch 03 wires the actual graph
// time-window filter (Dash's filter_graph_by_time_window) as a second
// reader -- the exported surface is kept minimal/stable so that lands as a
// pure addition, not a rework.
//
// "365" is a legacy value the Dash graph filter still accepts (kept in the
// type for round-trip completeness) but renders NO pill -- there is no
// (label, "365") entry in DATE_RANGE_PILLS (HeaderCards.tsx).
export type TimeWindow = "all" | "7" | "30" | "90" | "365";

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
