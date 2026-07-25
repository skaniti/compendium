"use client";

import { useState } from "react";
import DiaryPanel from "./DiaryPanel";
import type { Granularity } from "@/lib/types";

// Ports the left panel's header band from app.py's graph-view layout
// (:1926-1969) -- the "History" label plus the day/week/month granularity
// selector that sits above the session diary -- plus the diary itself
// (render_session_diary, #diary-container at app.py:1963-1966; ported in
// components/DiaryPanel.tsx, task 6).
//
// Dash wires each button's id as a pattern-matching
// {"type": "granularity-btn", "index": value} (callbacks/session.py) so the
// server can single out which one fired and drive a dcc.Store -- there's no
// React equivalent to port byte-for-byte, so this component owns the active
// state locally instead, same as before DiaryPanel landed. That local state
// is passed straight down as DiaryPanel's `granularity` prop, which is what
// actually drives PageStoreAdapter.get_time_windows()'s `granularity`
// argument now (session.py:37-61) -- the way the Store did in Dash.

// (label, short, value) triples, in the exact order rendered at
// app.py:1952-1956. The full/short split feeds the .gran-full/.gran-short
// responsive swap at theme.css:194-199 (narrow viewports show the letter
// only).
const GRANULARITY_OPTIONS: Array<{ label: string; short: string; value: Granularity }> = [
  { label: "Day", short: "D", value: "day" },
  { label: "Week", short: "W", value: "week" },
  { label: "Month", short: "M", value: "month" },
];

// dcc.Store(id="granularity", data="day") at app.py:1755 -- "day" is the
// store's default before any button click.
const DEFAULT_GRANULARITY: Granularity = "day";

export default function HistoryPanel() {
  const [granularity, setGranularity] = useState<Granularity>(DEFAULT_GRANULARITY);

  return (
    <>
      <div className="panel-header-band">
        <p className="panel-header">History</p>
        <div className="granularity-selector">
          {GRANULARITY_OPTIONS.map(({ label, short, value }) => (
            <button
              key={value}
              type="button"
              className={value === granularity ? "granularity-btn active" : "granularity-btn"}
              onClick={() => setGranularity(value)}
            >
              <span>
                <span className="gran-full">{label}</span>
                <span className="gran-short">{short}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {/* #diary-container (app.py:1963-1966) wraps render_session_diary's
          output in Dash; DiaryPanel (task 6) is the ported equivalent. */}
      <div id="diary-container">
        <DiaryPanel granularity={granularity} />
      </div>
    </>
  );
}
