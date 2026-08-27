"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  addMemberExclusion,
  addTopic,
  fetchMemberExclusions,
  fetchTopicMembers,
  removeMemberExclusion,
  removeTopic,
  renameTopic,
  setTopicIcon,
} from "@/lib/api";
import { getIconsGrouped, TopicIcon } from "@/lib/icons";
import { computeAnchoredPosition, getHeaderGraphControls, getPortalElement, tileForSlot } from "@/lib/scPosition";
import type { MemberExclusion, TopicInterest, TopicMember } from "@/lib/types";

// Task 8-C3: the SUPERCLUSTERS popover panel. Ports topics.py's
// _render_sc_popover (~787-999) + _render_sc_icon_picker_flat (~735-784) +
// the sc_add/sc_delete/sc_rename/sc_select_icon/sc_exclude_member/
// sc_restore_member callbacks (~1273-1825) into one self-contained
// component: mounted only while its slot is open (HeaderCards' SuperclustersCard
// conditionally renders it -- no display:none-but-in-DOM branch like Dash's
// pattern-matched-callback constraint required), it self-portals into
// #sc-popovers-portal (AppShell.tsx:106) via createPortal so position:fixed
// escapes #header-graph-controls' transformed containing block (see that
// portal div's own comment).
//
// Escape/outside-click dismissal (sc_popover_position.js's handleEscapeCloseSc
// / handleOutsideClickCloseSc) live here rather than a separate listener
// module: this component only ever exists while its slot IS the open one, so
// "a popover is open" and "this component is mounted" are the same fact --
// no separate open/closed branch to track.

const SC_POPOVER_MEMBER_CAP = 50; // topics.py's SC_POPOVER_MEMBER_CAP (~636) -- mirrored literal,
// same "no shared contract module yet" convention as HeaderCards.tsx's own
// MAX_SUPERCLUSTERS mirror.

const NO_CLUSTERS_MESSAGE = "no clusters in the latest run"; // shared with ScTooltip.tsx's memberless message

export interface ScPopoverProps {
  slot: number;
  // undefined => empty slot (renders the ADD form); present => allocated
  // slot (rename/delete/icon-pick/members/excluded).
  topic: TopicInterest | undefined;
  // Full topic list -- needed for the duplicate-keyword check (add) and the
  // "used by another topic" icon check (icon picker).
  topics: TopicInterest[];
  onClose: () => void;
  refetchTopics: () => void;
  refreshGraph: () => Promise<void>;
}

export default function ScPopover({ slot, topic, topics, onClose, refetchTopics, refreshGraph }: ScPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Single busy flag covers BOTH the empty-slot add spinner and the
  // allocated-slot delete spinner -- the two branches never render in the
  // same mounted instance (a slot is either empty or allocated), mirroring
  // Dash's single sc-popover-spinner id per slot toggled by `running=` on
  // both sc_add_topic and sc_delete_topic (topics.py ~1296-1302, ~1417-1423).
  const [busy, setBusy] = useState(false);

  // MEMBERS / EXCLUDED data for an allocated slot. null = not yet fetched
  // (renders nothing under MEMBERS rather than a false-empty flash);
  // fetched-but-empty is a real [] distinct from that -- same null-vs-empty
  // idiom TopicDetail.tsx's WindowSummaryView uses for `win`.
  const [members, setMembers] = useState<TopicMember[] | null>(null);
  const [exclusions, setExclusions] = useState<MemberExclusion[]>([]);

  const keyword = topic?.keyword;

  const refetchMembers = useCallback(() => {
    if (!keyword) return;
    fetchTopicMembers(keyword, SC_POPOVER_MEMBER_CAP)
      .then(setMembers)
      .catch(() => setMembers([]));
    fetchMemberExclusions()
      .then((all) => setExclusions(all.filter((e) => e.keyword.toLowerCase() === keyword.toLowerCase())))
      .catch(() => setExclusions([]));
  }, [keyword]);

  // Fetch on open, and again whenever `keyword` itself changes -- covers a
  // rename committing while this same popover instance stays mounted (Dash
  // parity: sc_rename_topic doesn't close the popover, and render_sc_card
  // re-fetches MEMBERS/EXCLUDED for the open slot keyed by the NEW keyword
  // on every topic-mutation-trigger bump).
  useEffect(() => {
    if (keyword) refetchMembers();
  }, [keyword, refetchMembers]);

  // Position below the anchor tile, clamped at the right edge only (Dash:
  // sc_popover_position.js's positionPopover). Re-measure whenever content
  // that could change the popover's rendered size changes (members/exclusions
  // resolving, spinner toggling) -- mirrors the MutationObserver-driven
  // re-position on every portal subtree change in the Dash source; re-run on
  // resize/scroll for viewport changes.
  useLayoutEffect(() => {
    function reposition() {
      const tile = tileForSlot(slot);
      const el = popoverRef.current;
      if (!tile || !el) return;
      const { top, left } = computeAnchoredPosition(tile.getBoundingClientRect(), el.getBoundingClientRect().width);
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { passive: true });
    const hgc = getHeaderGraphControls();
    hgc?.addEventListener("scroll", reposition, { passive: true });
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition);
      hgc?.removeEventListener("scroll", reposition);
    };
  }, [slot, members, exclusions, busy]);

  // Escape (capture phase) + outside click (capture phase) both close.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onClose();
      // Capture-phase stopPropagation + preventDefault (Dash's
      // handleEscapeCloseSc, sc_popover_position.js ~205-243): d3_graph.js
      // registers its own bubble-phase document keydown listener that clears
      // canvas node/cluster selection on Escape. Without stopping
      // propagation here, closing this popover would ALSO clear whatever is
      // selected on the canvas -- capture-phase listeners run before
      // bubble-phase ones regardless of script load order, so this always
      // wins the race and the canvas handler never sees the event.
      e.stopPropagation();
      e.preventDefault();
    }
    function handleClickOutside(e: MouseEvent) {
      const target = e.target;
      const inside =
        target instanceof Element && (target.closest("#sc-popovers-portal") || target.closest(".hbar-sc-tile"));
      // No stopPropagation/preventDefault (Dash's handleOutsideClickCloseSc):
      // an outside click legitimately belongs to other surfaces too (the
      // canvas's own click-to-select grammar), and closing the popover must
      // not swallow that.
      if (!inside) onClose();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("click", handleClickOutside, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("click", handleClickOutside, true);
    };
  }, [onClose]);

  async function handleAdd(rawValue: string) {
    const newKeyword = rawValue.trim();
    if (!newKeyword) return; // whitespace/empty -- no-op
    const isDuplicate = topics.some((t) => t.keyword.toLowerCase() === newKeyword.toLowerCase());
    if (isDuplicate) {
      // Dash: close the popover WITHOUT adding, no error UI (sc_add_topic
      // ~1364-1366).
      onClose();
      return;
    }
    setBusy(true);
    try {
      await addTopic(newKeyword);
      refetchTopics();
      await refreshGraph();
      onClose();
    } catch {
      // Best-effort, same swallow-on-failure idiom as HeaderCards'
      // handleRecluster -- leave the popover open with whatever the user
      // typed rather than inventing new error UI.
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(rawValue: string) {
    if (!topic) return;
    const newKeyword = rawValue.trim();
    if (!newKeyword) return; // empty -- no-op
    if (newKeyword.toLowerCase() === topic.keyword.toLowerCase()) return; // unchanged -- no-op
    try {
      await renameTopic(topic.keyword, newKeyword);
      refetchTopics();
      await refreshGraph();
      // No spinner, popover stays open regardless of outcome (Dash:
      // sc_rename_topic has no `running=` and no open-slot output).
    } catch {
      // Swallow -- same idiom as handleAdd above.
    }
  }

  async function handleDelete() {
    if (!topic) return;
    setBusy(true);
    try {
      await removeTopic(topic.keyword);
      refetchTopics();
      await refreshGraph();
      onClose();
    } catch {
      // Swallow -- same idiom as handleAdd above.
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectIcon(iconId: string, isActive: boolean, isUsed: boolean) {
    if (!topic || isActive || isUsed) return; // Dash: active/used cell click is a no-op
    try {
      await setTopicIcon(topic.keyword, iconId);
      refetchTopics();
      await refreshGraph();
      // Popover stays open (Dash: sc_select_icon has no open-slot output).
    } catch {
      // Swallow -- same idiom as handleAdd above.
    }
  }

  async function handleExclude(clusterName: string) {
    if (!keyword) return;
    try {
      await addMemberExclusion(keyword, clusterName);
      refetchMembers(); // members + exclusions refetch for the open popover
      await refreshGraph(); // backend unlabels immediately (sc_exclude_member)
    } catch {
      // Swallow -- same idiom as handleAdd above.
    }
  }

  async function handleRestore(clusterName: string) {
    if (!keyword) return;
    try {
      await removeMemberExclusion(keyword, clusterName);
      refetchMembers(); // members + exclusions ONLY -- no graph refresh (Dash:
      // sc_restore_member restores lazily at the next recluster).
    } catch {
      // Swallow -- same idiom as handleAdd above.
    }
  }

  const portalEl = getPortalElement();
  if (!portalEl) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="hbar-sc-popover"
      data-sc-popover-slot={slot}
      // Mounted only while open, so the panel is always "on" here --
      // display:block overrides the ported CSS's display:none default (Dash
      // toggles the same inline style on open/close; this component instead
      // represents "closed" by not being mounted at all).
      style={{ display: "block" }}
    >
      {topic ? (
        <AllocatedBody
          topic={topic}
          topics={topics}
          busy={busy}
          members={members}
          exclusions={exclusions}
          onRename={handleRename}
          onDelete={handleDelete}
          onSelectIcon={handleSelectIcon}
          onExclude={handleExclude}
          onRestore={handleRestore}
        />
      ) : (
        <EmptyBody busy={busy} inputRef={addInputRef} onAdd={handleAdd} />
      )}
    </div>,
    portalEl
  );
}

interface EmptyBodyProps {
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (value: string) => void;
}

function EmptyBody({ busy, inputRef, onAdd }: EmptyBodyProps) {
  return (
    <>
      <div className="hbar-sc-popover-title">ADD SUPERCLUSTER</div>
      <div className="hbar-sc-add-row">
        <div className="hbar-sc-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            placeholder="e.g. Earth Science"
            maxLength={36}
            className="hbar-sc-input"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAdd(e.currentTarget.value);
              }
            }}
          />
          <span
            className="topic-spinner hbar-sc-popover-spinner"
            style={{ display: busy ? "inline-block" : "none" }}
          />
        </div>
        <button
          type="button"
          className="hbar-sc-add-btn"
          onClick={() => onAdd(inputRef.current?.value ?? "")}
        >
          Add
        </button>
      </div>
    </>
  );
}

interface AllocatedBodyProps {
  topic: TopicInterest;
  topics: TopicInterest[];
  busy: boolean;
  members: TopicMember[] | null;
  exclusions: MemberExclusion[];
  onRename: (value: string) => void;
  onDelete: () => void;
  onSelectIcon: (iconId: string, isActive: boolean, isUsed: boolean) => void;
  onExclude: (clusterName: string) => void;
  onRestore: (clusterName: string) => void;
}

function AllocatedBody({
  topic,
  topics,
  busy,
  members,
  exclusions,
  onRename,
  onDelete,
  onSelectIcon,
  onExclude,
  onRestore,
}: AllocatedBodyProps) {
  // Dash's used_ids = {t.icon_id for t in topics if t.icon_id} -- includes
  // every topic's icon (this one's own too), but the per-cell check below
  // ("used && not active") excludes the active icon from ever showing as
  // used, same as _render_sc_icon_picker_flat.
  const usedIds = new Set(topics.map((t) => t.icon_id).filter((id): id is string => Boolean(id)));

  const pickGridStyle = {
    "--scpick-idle": "var(--text-muted)",
    "--scpick-active": "var(--highlight)",
    "--scpick-used": "var(--text-muted)",
  } as CSSProperties;

  return (
    <>
      <div className="hbar-sc-rename-row">
        <div className="hbar-sc-input-wrapper">
          <input
            type="text"
            defaultValue={topic.keyword}
            maxLength={36}
            className="hbar-sc-input"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(e.currentTarget.value);
              }
            }}
          />
          <span
            className="topic-spinner hbar-sc-popover-spinner"
            style={{ display: busy ? "inline-block" : "none" }}
          />
        </div>
        <button type="button" className="hbar-sc-delete-btn" title="Delete supercluster" onClick={onDelete}>
          ×
        </button>
      </div>

      <div className="hbar-sc-popover-title">CHANGE ICON</div>
      <div className="hbar-sc-pick-grid" style={pickGridStyle}>
        {getIconsGrouped().map(([category, iconIds]) => (
          // Fragment, not a wrapper div -- Dash's flat picker (both section
          // divs and cell divs as direct children of the grid) has no
          // per-category wrapper element; a real wrapper would also need
          // `display: contents` to not break the CSS grid layout.
          <Fragment key={category}>
            <div className="hbar-sc-pick-section">{category}</div>
            {iconIds.map((iconId) => {
              const isActive = iconId === topic.icon_id;
              const isUsed = usedIds.has(iconId) && !isActive;
              return (
                <div
                  key={iconId}
                  className={"hbar-sc-pick-cell" + (isActive ? " active" : "") + (isUsed ? " used" : "")}
                  title={iconId}
                  onClick={() => onSelectIcon(iconId, isActive, isUsed)}
                >
                  {/* stroke="inherit" (not TopicIcon's default "currentColor"):
                      the ported CSS drives color via `.hbar-sc-pick-glyph`'s
                      own `stroke` (the --scpick-* vars above), same as the
                      hydrated <svg><use> sprite Dash built -- a path-level
                      "currentColor" would read `color` instead and never see
                      those vars. "inherit" lets the class's stroke cascade
                      down from the <svg> to each <path>. */}
                  <TopicIcon iconId={iconId} size={18} stroke="inherit" className="hbar-sc-pick-glyph" />
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div className="hbar-sc-popover-title">MEMBERS</div>
      {members !== null &&
        (members.length > 0 ? (
          <div className="hbar-sc-member-list">
            {members.map((m) => (
              <div className="hbar-sc-member-row" key={m.cluster_name}>
                <span className="hbar-sc-member-name" title={m.cluster_name}>
                  {m.cluster_name}
                </span>
                <button
                  type="button"
                  className="hbar-sc-member-exclude-btn"
                  title="Doesn't belong here — excluded from this supercluster at every future recluster"
                  onClick={() => onExclude(m.cluster_name)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="hbar-sc-tooltip-empty">{NO_CLUSTERS_MESSAGE}</div>
        ))}

      {exclusions.length > 0 && (
        <>
          <div className="hbar-sc-popover-title">EXCLUDED</div>
          <div className="hbar-sc-member-list">
            {exclusions.map((e) => (
              <div className="hbar-sc-member-row hbar-sc-member-row-excluded" key={e.cluster_slug}>
                <span className="hbar-sc-member-name" title={e.cluster_name}>
                  {e.cluster_name}
                </span>
                <button
                  type="button"
                  className="hbar-sc-member-restore-btn"
                  title="Restore -- eligible for this supercluster again at the next recluster"
                  onClick={() => onRestore(e.cluster_name)}
                >
                  ↩
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
