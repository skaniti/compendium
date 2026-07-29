"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useGraph } from "@/hooks/useGraph";
import { fetchClusteringStatus, fetchTopics, postRecluster } from "@/lib/api";
import { TopicIcon } from "@/lib/icons";
import { useTimeWindow, type TimeWindow } from "./TimeWindowProvider";
import type { ClusteringStatus, TopicInterest } from "@/lib/types";

// Ports app.py's _build_graph_widgets (lines 282-415) into JSX: three
// "mini-cards" (CLUSTERING / DATE RANGE / SUPERCLUSTERS) rendered inside
// #header-graph-controls' .hbar-cards-row (mounted by Header.tsx). Class
// names AND element ids are kept verbatim -- the ported CSS
// (app/styles/style.css's .hbar-* rules, body.plain-demo #recluster-btn)
// keys off both.
//
// SC popovers/tooltips (topics.py's render_sc_card popovers +
// open_close_sc_popover) are Task 8-C3, not this task: this component owns
// `openSlot` + a click handler as the seam for that task to consume, and
// renders no popover content itself yet.

// Dash's static pre-callback title (app.py:312) -- the initial DOM before
// the first clustering-status read resolves, and the fallback for a failed
// read (no Dash analog for a client-visible fetch failure here; Dash
// renders server-side).
const INITIAL_STATUS: ClusteringStatus = {
  run_number: null,
  title: "CLUSTERING (NO RUNS YET)",
  stats_line1: "",
  stats_line2: "",
  freshness_label: "",
  freshness_color: "",
};

// app.py:357 -- label/value pairs for the DATE RANGE pills, in DOM order.
// "365" is a legacy graph-filter value with NO pill (TimeWindowProvider's
// own comment).
const DATE_RANGE_PILLS: ReadonlyArray<{ label: string; value: TimeWindow }> = [
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
  { label: "90d", value: "90" },
  { label: "All", value: "all" },
];

// topics.py:630 -- mirrored as a literal constant rather than imported
// (no shared contract module exists yet between the two repos).
const MAX_SUPERCLUSTERS = 12;

export default function HeaderCards() {
  const { graphVersion, refresh } = useGraph();
  const { timeWindow, setTimeWindow } = useTimeWindow();

  const [status, setStatus] = useState<ClusteringStatus>(INITIAL_STATUS);
  const [busy, setBusy] = useState(false);
  const [topics, setTopics] = useState<TopicInterest[]>([]);
  const [openSlot, setOpenSlot] = useState<number | null>(null);

  const refetchTopics = useCallback(() => {
    fetchTopics()
      .then((next) => setTopics(next))
      .catch(() => {
        // Best-effort: keep whatever tiles are already on screen rather
        // than blanking them -- same stale-while-revalidate idiom
        // DiaryPanel/TopicDetail use for their own fetch effects. Task
        // 8-C3 can wire a real error surface into the SC card if needed.
      });
  }, []);

  // Initial clustering-status read (app.py's card starts with the static
  // title above and no stats/badge until this resolves).
  useEffect(() => {
    fetchClusteringStatus()
      .then((next) => setStatus(next))
      .catch(() => {
        // Leave INITIAL_STATUS on screen -- see that constant's comment.
      });
  }, []);

  // Topics power the SUPERCLUSTERS card's title (N/12) and tiles. Refetch
  // on mount AND whenever graphVersion bumps (a recluster or another
  // topic-mutation-adjacent commit) -- Dash parity: render_sc_card lists
  // topic-mutation-trigger as an Input, and this card's own recluster
  // button is one more way that trigger fires (via graphVersion here since
  // no topic-mutation-trigger equivalent exists yet).
  useEffect(() => {
    refetchTopics();
  }, [graphVersion, refetchTopics]);

  async function handleRecluster(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await postRecluster();
      // Success: bump graphVersion (refetches diary + this card's own
      // topics effect above) and pull the freshly-completed run's status.
      await refresh();
      const next = await fetchClusteringStatus();
      setStatus(next);
    } catch {
      // Dash surfaces recluster errors only into a permanently-hidden
      // #recluster-status span (a callback-validation requirement, not
      // real UI) -- deliberately not inventing new error UI here either.
    } finally {
      setBusy(false);
    }
  }

  function handleTileClick(slot: number): void {
    setOpenSlot((current) => (current === slot ? null : slot));
  }

  // recluster.py:113-118's "No cache" branch styling: an empty
  // freshness_color means there's no completed run to time yet (or, here,
  // the status hasn't loaded), so the badge dims instead of coloring.
  const freshnessStyle: CSSProperties = status.freshness_color
    ? { color: status.freshness_color }
    : { color: "var(--on-primary)", opacity: 0.5 };

  return (
    <div className="hbar-cards-row">
      <div className="hbar-card">
        <div id="clustering-card-title" className="hbar-card-title">
          {status.title}
        </div>
        <div className="hbar-card-body hbar-clustering-body">
          <div className="hbar-clustering-left">
            <span id="cache-freshness-badge" className="hbar-recluster-ago" style={freshnessStyle}>
              {status.freshness_label}
            </span>
            <button
              id="recluster-btn"
              type="button"
              className={busy ? "hbar-recluster-btn is-spinning" : "hbar-recluster-btn"}
              title="Recluster now"
              disabled={busy}
              onClick={() => void handleRecluster()}
            >
              ↻
            </button>
          </div>
          <div className="hbar-clustering-stats">
            <div id="hbar-cluster-stats-line1" className="hbar-stat-line">
              {status.stats_line1}
            </div>
            <div id="hbar-cluster-stats-line2" className="hbar-stat-line">
              {status.stats_line2}
            </div>
          </div>
        </div>
      </div>

      <div className="hbar-card">
        <div className="hbar-card-title">DATE RANGE</div>
        <div className="hbar-card-body hbar-pill-row">
          {DATE_RANGE_PILLS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={value === timeWindow ? "hbar-pill active" : "hbar-pill"}
              onClick={() => setTimeWindow(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <SuperclustersCard topics={topics} openSlot={openSlot} onTileClick={handleTileClick} />
    </div>
  );
}

interface SuperclustersCardProps {
  topics: TopicInterest[];
  openSlot: number | null;
  onTileClick: (slot: number) => void;
}

// Ports topics.py's render_sc_card title/body rules (~1116-1218). openSlot
// is threaded through as the Task 8-C3 seam (that task renders the actual
// popovers keyed off it); this batch renders none.
function SuperclustersCard({ topics, openSlot, onTileClick }: SuperclustersCardProps) {
  const n = topics.length;
  const overflow = n > MAX_SUPERCLUSTERS;
  const title = overflow
    ? `SUPERCLUSTERS OVERFLOW (${n}/${MAX_SUPERCLUSTERS})`
    : `SUPERCLUSTERS (${n}/${MAX_SUPERCLUSTERS} ALLOCATED)`;
  const titleClass = overflow ? "hbar-card-title hbar-sc-title-overflow" : "hbar-card-title";

  return (
    <div className="hbar-card hbar-sc-card">
      <div id="sc-card-title" className={titleClass}>
        {title}
      </div>
      {/* data-open-slot mirrors Dash's sc-popover-open-slot Store as a DOM
          attribute -- not read by any CSS/JS yet, just a stable hook for
          8-C3's popover-mount decision and for this batch's own tests
          (no popover content exists yet to assert against otherwise). */}
      <div
        id="sc-card-body"
        className="hbar-card-body hbar-sc-body"
        data-open-slot={openSlot ?? ""}
      >
        {Array.from({ length: MAX_SUPERCLUSTERS }, (_, slot) => (
          <SCTile key={slot} slot={slot} topic={topics[slot]} onClick={() => onTileClick(slot)} />
        ))}
      </div>
    </div>
  );
}

interface SCTileProps {
  slot: number;
  topic: TopicInterest | undefined;
  onClick: () => void;
}

// Ports topics.py's _render_sc_tile (~659-732), inline <svg> instead of a
// base64 data-URI <img> (Dash-only scaffolding -- see lib/icons.tsx's own
// header comment for the same substitution on the icon side).
function SCTile({ slot, topic, onClick }: SCTileProps) {
  if (!topic) {
    return (
      <div
        className="hbar-sc-tile hbar-sc-tile-empty"
        title={`Add a supercluster (slot ${slot + 1})`}
        data-sc-tile-slot={slot}
        onClick={onClick}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="white"
          strokeWidth={2}
          strokeLinecap="round"
          className="hbar-sc-plus"
          style={{ display: "block" }}
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>
    );
  }

  // member_count === 0 -> "allocated but memberless" (dashed/thinner icon,
  // dimmed tile via the -allocated-empty CSS rule) -- canvas parity, see
  // topics.py:668-670.
  const isMemberless = topic.cluster_count === 0;
  const className = isMemberless
    ? "hbar-sc-tile hbar-sc-tile-allocated hbar-sc-tile-allocated-empty"
    : "hbar-sc-tile hbar-sc-tile-allocated";

  return (
    // No title= here (topics.py:714-718) -- a real hover tooltip covers
    // allocated tiles in Task 8-C3; a native title would double-render
    // alongside it.
    <div className={className} data-sc-tile-slot={slot} onClick={onClick}>
      <TopicIcon
        iconId={topic.icon_id ?? "bookmark"}
        size={34}
        stroke="#ffffff"
        strokeWidth={isMemberless ? 1.5 : 2.0}
        strokeDasharray={isMemberless ? "6,4" : undefined}
      />
    </div>
  );
}
