"use client";

import { useEffect, useState } from "react";
import { useNav } from "./NavProvider";
import { fetchDiaryWindows } from "@/lib/api";
import { parseTagBtnIndex } from "@/lib/nav";
import type { DiaryWindow, Granularity } from "@/lib/types";

// Ports layouts/session_diary.py's render_session_diary + _build_window_card
// into JSX. Wiring follows the controller's verified read of
// callbacks/session.py:37-61 and the nav clientside at app.py:3010-3067
// (the task-6 brief's own guess at the data wiring was wrong on this
// point; this follows the controller's correction instead):
//
// - `filterNodeId` passed to fetchDiaryWindows is nav SELECTION
//   (state.selectedNodeId), NOT the window filter -- Dash's update_diary
//   passes `filter_node_id=selected_node` (the selected-node store).
//   Selecting a node/cluster anywhere filters which diary windows show.
// - The active-window accent (.session-header.active) is
//   state.filterWindowKey (Dash: `selected_session_id=selected_session` =
//   filter_session_id).
// - Tag-pill highlighting is nav SELECTION again
//   (`highlighted_node_id=selected_node`): a pill whose cluster id matches
//   state.selectedNodeId gets .highlighted.
// - A refetch fires whenever granularity OR selection changes. Dash's
//   update_diary callback also lists selected-session as an Input (so it
//   re-runs the WHOLE callback, including the query, on every accent
//   change too) -- but get_time_windows' args there are filter_node_id
//   (selected_node) and granularity only, never selected_session, so that
//   extra Dash re-run always produces byte-identical window data, just a
//   different is_active flag. We get the same accent update for free via
//   context re-render (filterWindowKey is read directly in the JSX below)
//   without the redundant refetch Dash's own version does.
//
// The hidden window-node-map dcc.Store (session_diary.py:56-64) is NOT
// ported: Dash needed it because a pattern-matching callback's `id` can't
// carry an arbitrary payload, so it stashed window_key -> graph_node_ids in
// a side store for a later callback to look up by key. React's click
// closures capture `window.graph_node_ids` directly instead, so the store
// has no purpose here.

const MAX_TAG_PILLS = 3;

interface DiaryPanelProps {
  granularity: Granularity;
}

export default function DiaryPanel({ granularity }: DiaryPanelProps) {
  const { state, dispatch } = useNav();
  const { selectedNodeId, filterWindowKey } = state;

  // `null` = "no response yet" (initial fetch in flight); `[]` = a real,
  // resolved empty result. Kept distinct so the initial load renders
  // NOTHING rather than flashing the "No pages yet." empty-state markup,
  // which would be a lie during loading (see the `windows === null` branch
  // below). Once the first response lands, `windows` is left at its last
  // resolved value across later refetches (granularity/selection changes)
  // instead of resetting to null on every effect run -- so an in-flight
  // refetch doesn't blank previously-shown cards either. This is a
  // deliberate stale-while-revalidate choice for "show nothing disruptive"
  // (brief left the exact refetch-loading UX to the implementer).
  const [windows, setWindows] = useState<DiaryWindow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDiaryWindows(granularity, selectedNodeId ?? undefined)
      .then((data) => {
        if (cancelled) return;
        setWindows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [granularity, selectedNodeId]);

  function handleWindowClick(win: DiaryWindow): void {
    // window-btn AND overflow-btn (Dash: two distinct pattern-matching
    // ids, same callback branch) dispatch the identical action -- the
    // overflow button below calls this same handler rather than a
    // separate one.
    dispatch({ type: "SET_WINDOW_FILTER", key: win.key, nodeIds: win.graph_node_ids });
  }

  function handleTagClick(win: DiaryWindow, clusterId: string): void {
    // Dash's tag-btn pattern-matching index is "{window_key}::{cluster_id}"
    // (session_diary.py:105); routed through parseTagBtnIndex (lib/nav.ts)
    // to exercise the same index-parsing path Dash's callback uses, rather
    // than dispatching clusterId directly -- the controller left this
    // choice to the implementer; documented here per the brief.
    dispatch({ type: "SELECT_CLUSTER", id: parseTagBtnIndex(`${win.key}::${clusterId}`) });
  }

  if (error) {
    // No Dash analog -- Dash renders server-side, so a failed page_store
    // query there is a 500, never a client-visible state. Deliberately
    // minimal: a bare .placeholder-text paragraph, NOT the empty-state's
    // .panel-scroll wrapper, so a fetch failure reads as distinct from
    // "confirmed zero windows" rather than reusing that markup for a
    // different meaning.
    return <p className="placeholder-text">Couldn&apos;t load diary: {error}</p>;
  }

  if (windows === null) {
    return null;
  }

  if (windows.length === 0) {
    // session_diary.py:37-44 -- the empty branch's outer html.Div IS
    // .panel-scroll (not a wrapper around an inner one). Mirrored exactly;
    // asymmetric with the non-empty branch below.
    return (
      <div className="panel-scroll">
        <p className="placeholder-text">No pages yet.</p>
      </div>
    );
  }

  // session_diary.py:54-59 -- non-empty branch wraps .panel-scroll in a
  // plain outer Div (asymmetric with the empty branch above, which has no
  // wrapper).
  return (
    <div>
      <div className="panel-scroll">
        {windows.map((win) => (
          <DiaryCard
            key={win.key}
            win={win}
            isActive={filterWindowKey === win.key}
            highlightedNodeId={selectedNodeId}
            onWindowClick={handleWindowClick}
            onTagClick={handleTagClick}
          />
        ))}
      </div>
    </div>
  );
}

interface DiaryCardProps {
  win: DiaryWindow;
  isActive: boolean;
  highlightedNodeId: string | null;
  onWindowClick: (win: DiaryWindow) => void;
  onTagClick: (win: DiaryWindow, clusterId: string) => void;
}

// Ports _build_window_card (session_diary.py:67-133).
function DiaryCard({ win, isActive, highlightedNodeId, onWindowClick, onTagClick }: DiaryCardProps) {
  const sortedClusters = sortClusterIds(win.cluster_freq, win.cluster_names);
  const tagLabels = sortedClusters.map((cid) => win.cluster_names[cid] ?? cid);
  const summary = buildSummary(tagLabels, win.page_count);

  const topClusters = sortedClusters.slice(0, MAX_TAG_PILLS);
  const overflow = sortedClusters.length - MAX_TAG_PILLS;

  return (
    <div className="session-card">
      <button
        type="button"
        className={isActive ? "session-header active" : "session-header"}
        onClick={() => onWindowClick(win)}
      >
        {win.label}
      </button>
      <div className="session-card-body">
        <div className="card-summary">{summary}</div>
        <div className="tag-container">
          {topClusters.map((cid) => {
            const label = win.cluster_names[cid] ?? cid;
            const isHighlighted = highlightedNodeId != null && highlightedNodeId === cid;
            return (
              <button
                key={cid}
                type="button"
                className={isHighlighted ? "tag-pill highlighted" : "tag-pill"}
                data-node-id={cid}
                onClick={() => onTagClick(win, cid)}
              >
                {label}
              </button>
            );
          })}
          {overflow > 0 && (
            <button type="button" className="tag-overflow" onClick={() => onWindowClick(win)}>
              +{overflow} more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Mirrors session_diary.py's
// `sorted(cluster_freq.keys(), key=lambda cid: (-cluster_freq[cid], cluster_names.get(cid, cid)))`
// -- frequency descending, then cluster name (falling back to the raw id)
// ascending as the tiebreak. Array.prototype.sort is stable per spec
// (ES2019+), the same stability guarantee Python's sort gives equal keys.
function sortClusterIds(clusterFreq: Record<string, number>, clusterNames: Record<string, string>): string[] {
  return Object.keys(clusterFreq).sort((a, b) => {
    const freqDelta = clusterFreq[b] - clusterFreq[a];
    if (freqDelta !== 0) return freqDelta;
    const nameA = clusterNames[a] ?? a;
    const nameB = clusterNames[b] ?? b;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
}

// Mirrors _build_window_card's summary_text branches byte-for-byte
// (session_diary.py:84-97): singular "page" iff page_count === 1; <=3 tags
// joins every name (or falls back to "various topics" when there are
// none); >3 tags shows the top 3 plus an "and N more" suffix.
function buildSummary(tagLabels: string[], pageCount: number): string {
  const pagesWord = pageCount === 1 ? "page" : "pages";
  if (tagLabels.length <= MAX_TAG_PILLS) {
    const namesStr = tagLabels.length > 0 ? tagLabels.join(", ") : "various topics";
    return `Explored ${namesStr} across ${pageCount} ${pagesWord}`;
  }
  const top = tagLabels.slice(0, MAX_TAG_PILLS).join(", ");
  const extra = tagLabels.length - MAX_TAG_PILLS;
  return `Explored ${top} and ${extra} more across ${pageCount} ${pagesWord}`;
}
