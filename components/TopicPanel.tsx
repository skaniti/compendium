"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { addTopic, fetchTopics, removeTopic, setTopicIcon } from "@/lib/api";
import { getIconsGrouped, TopicIcon } from "@/lib/icons";
import type { TopicInterest } from "@/lib/types";

// Task A1-5 (batch 03 graph canvas port): the legacy "Topic Interests"
// overlay + icon picker. Ports graph_canvas.py's _render_topic_panel
// (:508-568) + _render_icon_picker/_build_cell (:283-425, defer_cells
// semantics dropped -- this port mounts on demand instead, see GraphCanvas.tsx)
// + callbacks/topics.py's add_topic_server/remove_topic/select_icon/
// toggle_icon_picker + app.py's optimistic-add clientside callback
// (:2932-2988) into one self-contained component.
//
// *** Opening affordance: Dash's OWN :8051 has had none since 2026-05-22 ***
// Confirmed dead/unreachable via THREE independent sources: (1)
// toggle_topic_panel's own docstring ("The 'topics' text-link that USED to
// open this panel was removed ... this callback survives only to handle
// close-button + click-outside"), (2) style.css's plain-demo comment
// ("#topic-panel -- unreachable via any visible click path today, hidden
// anyway for defense in depth"), (3) commit 3d4b4b4's own message ("Removed
// ... 'topics' link from the overlay ... since the trigger element no
// longer exists"). See task-A1-5-report.md for the full writeup. This port
// still exists and is reachable -- the human-authored mig-03 plan (explorer
// docs/project-plans/2026-07-07-220618-nextjs-mig-03-graph/{spec,plan}.md)
// explicitly lists it "IN scope ... user-facing graph affordance", and
// app/styles/search-bar.css (:648,652,661-662, an EARLIER batch) already
// carries hover/focus CSS keyed on `#topic-toggle-btn` sitting alongside
// `#noise-toggle-btn` -- pre-existing infrastructure anticipating exactly
// this restoration. GraphCanvas.tsx mounts the trigger + this component.
//
// Unlike ScPopover.tsx (02, task 8-C3, the SUPERCLUSTERS header card's
// per-slot popover), this is a SINGLE overlay listing every topic, with
// ONE shared icon-picker-grid retargeted by whichever row's icon button was
// last clicked (toggle_icon_picker's exact semantics) rather than a picker
// embedded per-popover. No rename affordance anywhere -- Dash's own
// _topic_row/_render_topic_row never had one (rename predates neither;
// SUPERCLUSTERS' rename input is a later addition scoped to ITS OWN
// popover) -- also the brief's hard parity rule: rename lives only in 02's
// SC popover. No MEMBERS/EXCLUDED section -- that's a SC-popover-exclusive
// feature (spec.md's "NOT in 03" list: "membership-confidence anything (02
// popover surface)").
//
// plain-demo hiding: CSS-only, same idiom as ScPopover/.hbar-sc-popover --
// app/styles/style.css's existing `body.plain-demo #topic-panel,
// #icon-picker-grid { display: none !important }` rule (already ported,
// pre-dates this task) covers the whole panel body via the `#topic-panel`
// id below; no JS-side isPlainDemo gating needed here, matching
// HeaderCards.tsx/ScPopover.tsx's own established "CSS hides the mutation
// UI, the trigger stays visible" split (the SC card's own empty-slot "+"
// tiles are never JS-gated either -- only `.hbar-sc-popover` is).

const TOPIC_PANEL_STYLE: CSSProperties = {
  position: "absolute",
  top: "28px",
  left: "8px",
  width: "280px",
  padding: "12px",
  background: "var(--bg)",
  border: "1px solid rgba(128,128,128,0.2)",
  borderRadius: "8px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  zIndex: 20,
  color: "var(--text)",
  fontFamily: "var(--font-sans, sans-serif)",
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "8px",
};

const TITLE_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const ADD_ROW_STYLE: CSSProperties = { display: "flex", marginBottom: "8px" };

const ADD_INPUT_STYLE: CSSProperties = {
  flex: "1",
  fontSize: "0.75rem",
  padding: "4px 8px",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid rgba(128,128,128,0.3)",
  borderRadius: "4px",
};

const EMPTY_LIST_STYLE: CSSProperties = { fontSize: "0.7rem", opacity: 0.5 };

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "4px 0",
  borderBottom: "1px solid rgba(128,128,128,0.15)",
};

const KEYWORD_STYLE: CSSProperties = { flex: "1", fontSize: "0.75rem", fontWeight: 500 };

const LOADING_KEYWORD_STYLE: CSSProperties = { ...KEYWORD_STYLE, opacity: 0.5 };

const ICON_BTN_STYLE: CSSProperties = {
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: "3px",
  marginRight: "6px",
  opacity: 0.7,
};

const REMOVE_BTN_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text)",
  cursor: "pointer",
  opacity: 0.5,
  fontSize: "0.7rem",
  padding: "0 2px",
};

const CATEGORY_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: "2px",
  padding: "4px 0 8px 0",
};

const CELL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 2px",
  borderRadius: "4px",
  minHeight: "32px",
  position: "relative",
};

// CSS custom properties driving .icon-pick-glyph's stroke (app/styles/
// style.css, added alongside this task -- same idiom as ScPopover's own
// --scpick-* vars: React-idiomatic live theme tokens standing in for
// Dash's server-baked-hex-per-cell approach, which icons.tsx's own header
// comment already establishes as the correct translation for this exact
// mechanism).
const PICK_GRID_STYLE = {
  "--topic-pick-idle": "var(--text-muted)",
  "--topic-pick-active": "var(--highlight)",
  "--topic-pick-used": "var(--text-muted)",
} as CSSProperties;

export interface TopicPanelProps {
  onClose: () => void;
  // hooks/useGraph.ts's graphVersion -- refetches topics whenever it bumps,
  // same pattern as HeaderCards.tsx's own SC-topics effect, so this panel
  // and the SUPERCLUSTERS card stay in sync regardless of which surface a
  // mutation came from.
  graphVersion: number;
  // hooks/useGraph.ts's refresh() -- every mutation below ends with this,
  // per the brief's "Every mutation ends with useGraph().refresh()" rule.
  refresh: () => Promise<void>;
}

export default function TopicPanel({ onClose, graphVersion, refresh }: TopicPanelProps) {
  const [topics, setTopics] = useState<TopicInterest[]>([]);
  // The optimistic add row's keyword while addTopic() is in flight (Dash:
  // app.py's clientside callback appends a spinner row instantly, then
  // add_topic_server's server round-trip replaces topic-list-container
  // wholesale once the LLM icon selection + cluster assignment finish).
  // null = no add in flight.
  const [pendingKeyword, setPendingKeyword] = useState<string | null>(null);
  // Which topic's icon picker is currently targeted -- null = picker
  // closed. Mirrors toggle_icon_picker's icon-picker-target-keyword Store.
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const refetchTopics = useCallback(() => {
    fetchTopics()
      .then(setTopics)
      .catch(() => {
        // Best-effort, same swallow idiom as ScPopover/HeaderCards' own
        // refetchTopics -- a failed refetch leaves the last-known list
        // rendered rather than crashing the panel.
      });
  }, []);

  // Refetch on mount AND whenever graphVersion bumps -- same single-effect
  // shape as HeaderCards.tsx's own topics effect (graphVersion +
  // refetchTopics deps): refetchTopics is stable (useCallback, no deps), so
  // this fires exactly once at mount (the initial fetch) and again on every
  // LATER mutation from any surface (this panel, the SC popover, a
  // recluster) that bumps graphVersion -- a SEPARATE mount-only effect
  // would double-fetch on the very first render instead of composing.
  useEffect(() => {
    refetchTopics();
  }, [graphVersion, refetchTopics]);

  async function handleAdd(rawValue: string) {
    const keyword = rawValue.trim();
    if (addInputRef.current) addInputRef.current.value = ""; // Dash: cleared unconditionally once non-empty (app.py's clientside callback)
    if (!keyword) return; // whitespace/empty -- no-op, input never touched (Dash: same guard, `if (!keyword...) return [NU,NU,NU]`)
    const isDuplicate = topics.some((t) => t.keyword.toLowerCase() === keyword.toLowerCase());
    if (isDuplicate) {
      // Client-side pre-check, mirroring ScPopover's own handleAdd -- Dash's
      // add_topic_server ALSO no-ops server-side on a duplicate (silently
      // dropping the already-shown optimistic spinner row on its response),
      // but this repo's established convention (ScPopover.tsx) is to
      // pre-check client-side and skip the round-trip entirely rather than
      // reproduce the spinner-then-vanish flash.
      return;
    }
    setPendingKeyword(keyword);
    try {
      await addTopic(keyword);
      refetchTopics();
      await refresh();
      // No close (Dash: add_topic_server has no topic-panel style output --
      // the panel stays open after a successful add, unlike ScPopover's own
      // handleAdd which DOES close the SC popover on success).
    } catch {
      // Swallow -- same idiom as ScPopover's handleAdd/handleDelete/etc.
    } finally {
      setPendingKeyword(null);
    }
  }

  async function handleRemove(keyword: string) {
    try {
      await removeTopic(keyword);
      refetchTopics();
      await refresh();
    } catch {
      // Swallow -- same idiom as above.
    }
  }

  function handleToggleIconPicker(keyword: string) {
    // Toggle: clicking the SAME row's icon button again closes it;
    // clicking a DIFFERENT row's re-targets without needing to close first
    // (toggle_icon_picker's exact semantics, callbacks/topics.py:288-309).
    setPickerTarget((current) => (current === keyword ? null : keyword));
  }

  async function handleSelectIcon(iconId: string, isActive: boolean, isUsed: boolean) {
    if (!pickerTarget || isActive || isUsed) return; // Dash: active/used cell click is a no-op
    try {
      await setTopicIcon(pickerTarget, iconId);
      refetchTopics();
      await refresh();
      setPickerTarget(null); // Dash: select_icon closes the picker on success (icon-picker-grid style -> display:none)
    } catch {
      // Swallow -- same idiom as above.
    }
  }

  // Dash's used_ids = {t.icon_id for t in topics if t.icon_id} -- includes
  // every topic's icon (the target's own too); the per-cell check below
  // ("used && not active") excludes the active icon from ever showing used,
  // same as _get_icon_picker_tokens/_build_cell.
  const usedIds = new Set(topics.map((t) => t.icon_id).filter((id): id is string => Boolean(id)));
  const activeIconId = topics.find((t) => t.keyword === pickerTarget)?.icon_id ?? null;
  const pickerOpen = pickerTarget !== null;

  return (
    <div id="topic-panel" style={TOPIC_PANEL_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        <span style={TITLE_STYLE}>Topic Interests</span>
        <button type="button" id="topic-panel-close" className="internals-close-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div style={ADD_ROW_STYLE}>
        <input
          ref={addInputRef}
          id="topic-add-input"
          type="text"
          placeholder="e.g. Earth Science"
          maxLength={36}
          style={ADD_INPUT_STYLE}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAdd(e.currentTarget.value);
            }
          }}
        />
        <button type="button" className="topic-add-btn" onClick={() => void handleAdd(addInputRef.current?.value ?? "")}>
          Add
        </button>
      </div>

      <div id="topic-list-container">
        {topics.length === 0 && !pendingKeyword ? (
          <span style={EMPTY_LIST_STYLE}>No topics yet. Add one above.</span>
        ) : (
          <>
            {topics.map((t) => (
              <TopicRow
                key={t.keyword}
                topic={t}
                onToggleIcon={() => handleToggleIconPicker(t.keyword)}
                onRemove={() => void handleRemove(t.keyword)}
              />
            ))}
            {pendingKeyword && <LoadingRow keyword={pendingKeyword} />}
          </>
        )}
      </div>

      <div id="icon-picker-grid" className={"icon-picker-grid" + (pickerOpen ? " show" : "")} style={PICK_GRID_STYLE}>
        {pickerOpen &&
          getIconsGrouped().map(([category, iconIds]) => (
            <div key={category} className="icon-picker-category-section">
              <div className="icon-picker-category-header">{category}</div>
              <div className="icon-picker-category-grid" style={CATEGORY_GRID_STYLE}>
                {iconIds.map((iconId) => {
                  const isActive = iconId === activeIconId;
                  const isUsed = usedIds.has(iconId) && !isActive;
                  return (
                    <div
                      key={iconId}
                      className={"icon-pick-cell" + (isActive ? " active" : "") + (isUsed ? " icon-pick-used" : "")}
                      title={iconId}
                      style={CELL_STYLE}
                      onClick={() => void handleSelectIcon(iconId, isActive, isUsed)}
                    >
                      <TopicIcon iconId={iconId} size={20} stroke="inherit" strokeWidth={1.5} className="icon-pick-glyph" />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

interface TopicRowProps {
  topic: TopicInterest;
  onToggleIcon: () => void;
  onRemove: () => void;
}

function TopicRow({ topic, onToggleIcon, onRemove }: TopicRowProps) {
  return (
    <div style={ROW_STYLE}>
      <span style={KEYWORD_STYLE}>{topic.keyword}</span>
      <div className="topic-icon-btn" title="Change icon" style={ICON_BTN_STYLE} onClick={onToggleIcon}>
        {/* stroke omitted (TopicIcon's own default, "currentColor"): Dash's
            two row-icon renderers disagree with each other here --
            _render_topic_row (graph_canvas.py, static initial layout) uses
            the theme-aware idle_stroke token, while _topic_row (callbacks/
            topics.py, what every add/remove/icon-select mutation actually
            re-renders with) hardcodes "#cccccc" regardless of theme. Since
            the row has no explicit text color of its own (inherits
            var(--text) from #topic-panel), "currentColor" gives a
            theme-consistent glyph automatically -- resolving the Dash-side
            inconsistency toward the theme-aware behavior rather than
            picking one specific literal to port verbatim. */}
        <TopicIcon iconId={topic.icon_id ?? "bookmark"} size={16} strokeWidth={1.5} />
      </div>
      <button type="button" style={REMOVE_BTN_STYLE} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

function LoadingRow({ keyword }: { keyword: string }) {
  return (
    <div style={ROW_STYLE}>
      <span style={LOADING_KEYWORD_STYLE}>{keyword}</span>
      <span className="topic-spinner" />
    </div>
  );
}
