"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchTopicMembers } from "@/lib/api";
import { computeAnchoredPosition, getHeaderGraphControls, getPortalElement, tileForSlot } from "@/lib/scPosition";
import type { TopicInterest, TopicMember } from "@/lib/types";

// Task 8-C3: the SUPERCLUSTERS hover tooltip. Ports topics.py's
// _render_sc_tooltip (~1002-1104) + assets/sc_tooltip_hover.js's hover-intent
// / suppression / hide behavior into React. Two pieces, mirroring the two
// concerns the Dash source keeps separate:
//   - useScTooltipData: prefetches top-5 members per ALLOCATED keyword
//     (Dash pre-renders this server-side each card render; here it's an
//     effect keyed on the topics list so "instant on hover" still holds).
//   - useScTooltipHover: hover-intent timing, suppression while the hovered
//     slot's popover is open, and the hide triggers (mouseout, mousedown,
//     scroll, wheel, popover-state-change) -- the React state change IS the
//     "mutation" sc_tooltip_hover.js's MutationObserver reacted to, so a
//     plain effect dependency replaces it.
// ScTooltips (default export) composes both and is what HeaderCards mounts;
// ScTooltip (named) is the presentational panel, portaled + positioned like
// ScPopover.tsx's popover.

const SHOW_DELAY_MS = 150; // sc_tooltip_hover.js's SHOW_DELAY_MS

const NO_CLUSTERS_MESSAGE = "no clusters in the latest run"; // shared with ScPopover.tsx's MEMBERS empty state

// Prefetches top-5 members for every ALLOCATED (cluster_count > 0) topic,
// cached by keyword. `topics` changing IS "topics load / graphVersion bumps"
// -- HeaderCards' own refetchTopics effect already re-fires on mount and on
// every graphVersion bump, and each resolution produces a fresh `topics`
// array reference, so depending on `topics` alone covers both triggers
// without a redundant graphVersion parameter.
export function useScTooltipData(topics: TopicInterest[]): Record<string, TopicMember[]> {
  const [cache, setCache] = useState<Record<string, TopicMember[]>>({});

  useEffect(() => {
    let cancelled = false;
    const allocated = topics.filter((t) => t.cluster_count > 0);
    if (allocated.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale member data, not derivable during render
      setCache({});
      return;
    }
    Promise.all(
      allocated.map((t) =>
        fetchTopicMembers(t.keyword, 5)
          .then((members) => [t.keyword, members] as const)
          .catch(() => [t.keyword, []] as const)
      )
    ).then((entries) => {
      if (cancelled) return;
      setCache(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [topics]);

  return cache;
}

// Hover-intent + suppression + hide. `openSlot` is the popover's open slot
// (null when none open) -- suppresses that one slot's tooltip and hides
// whatever's visible whenever it changes (opens/closes/switches).
export function useScTooltipHover(openSlot: number | null): { visibleSlot: number | null } {
  const [visibleSlot, setVisibleSlot] = useState<number | null>(null);
  const visibleSlotRef = useRef<number | null>(null);
  const openSlotRef = useRef(openSlot);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    openSlotRef.current = openSlot;
  }, [openSlot]);

  const hide = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (visibleSlotRef.current !== null) {
      visibleSlotRef.current = null;
      setVisibleSlot(null);
    }
  }, []);

  // Suppress-on-open: mirrors sc_tooltip_hover.js's data-open-slot
  // MutationObserver (attachOpenSlotObserver) -- any change to which slot's
  // popover is open hides whatever tooltip is currently shown, covering the
  // "mouse never left the tile" case (click straight from hover to open).
  useEffect(() => {
    hide();
  }, [openSlot, hide]);

  // Delegated listeners, registered once -- mirrors the document-level
  // listeners in sc_tooltip_hover.js (no per-tile listeners to attach/detach
  // as tiles mount/unmount). Reads openSlotRef.current (not the `openSlot`
  // closure) so scheduling AND firing both re-check against the CURRENT open
  // slot without needing to re-register on every openSlot change (Dash:
  // isSlotSuppressed is called both in scheduleShow and in showSlot).
  useEffect(() => {
    function closestTile(target: EventTarget | null): Element | null {
      return target instanceof Element ? target.closest("[data-sc-tile-slot]") : null;
    }
    function slotOf(tile: Element): number | null {
      const attr = tile.getAttribute("data-sc-tile-slot");
      if (attr === null) return null;
      const n = parseInt(attr, 10);
      return Number.isNaN(n) ? null : n;
    }
    function handleMouseOver(e: MouseEvent) {
      const tile = closestTile(e.target);
      if (!tile) return;
      const slot = slotOf(tile);
      if (slot === null) return;
      // Moving within the tile's own subtree re-fires mouseover on children
      // -- don't re-arm the timer for that.
      if (closestTile(e.relatedTarget as EventTarget | null) === tile) return;
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (slot === openSlotRef.current) return; // suppressed -- don't even arm
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        if (slot === openSlotRef.current) return; // re-check at fire time
        visibleSlotRef.current = slot;
        setVisibleSlot(slot);
      }, SHOW_DELAY_MS);
    }
    function handleMouseOut(e: MouseEvent) {
      const tile = closestTile(e.target);
      if (!tile) return;
      if (closestTile(e.relatedTarget as EventTarget | null) === tile) return; // still within the tile
      hide();
    }
    function handleMouseDown(e: MouseEvent) {
      if (closestTile(e.target)) hide();
    }
    document.addEventListener("mouseover", handleMouseOver);
    document.addEventListener("mouseout", handleMouseOut);
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("wheel", hide, { passive: true });
    const hgc = getHeaderGraphControls();
    hgc?.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("mouseout", handleMouseOut);
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", hide);
      window.removeEventListener("wheel", hide);
      hgc?.removeEventListener("scroll", hide);
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
    };
  }, [hide]);

  return { visibleSlot };
}

export interface ScTooltipsProps {
  topics: TopicInterest[];
  openSlot: number | null;
}

// Orchestrator mounted unconditionally by HeaderCards' SuperclustersCard
// (independent of whether a popover is open -- the hover listeners must
// always be live).
export default function ScTooltips({ topics, openSlot }: ScTooltipsProps) {
  const cache = useScTooltipData(topics);
  const { visibleSlot } = useScTooltipHover(openSlot);

  if (visibleSlot === null) return null;
  const topic = topics[visibleSlot];
  if (!topic) return null; // tile re-rendered/removed between hover and now

  const members = topic.cluster_count > 0 ? (cache[topic.keyword] ?? []) : [];
  return <ScTooltip slot={visibleSlot} topic={topic} members={members} />;
}

export interface ScTooltipProps {
  slot: number;
  topic: TopicInterest;
  members: TopicMember[];
}

export function ScTooltip({ slot, topic, members }: ScTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Same positioning approach as ScPopover.tsx, clamped at BOTH edges (Dash:
  // sc_tooltip_hover.js's positionTooltip additionally does
  // `if (left < VIEWPORT_PAD_PX) left = VIEWPORT_PAD_PX`).
  useLayoutEffect(() => {
    function reposition() {
      const tile = tileForSlot(slot);
      const el = ref.current;
      if (!tile || !el) return;
      const { top, left } = computeAnchoredPosition(tile.getBoundingClientRect(), el.getBoundingClientRect().width, {
        clampLeftMin: true,
      });
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
  }, [slot, members]);

  const portalEl = getPortalElement();
  if (!portalEl) return null;

  const count = topic.cluster_count;

  return createPortal(
    <div
      ref={ref}
      className="hbar-sc-tooltip"
      data-sc-tooltip-slot={slot}
      // Mounted only while visible (see ScPopover.tsx's identical
      // display:block comment on why this overrides the CSS default here).
      style={{ display: "block" }}
    >
      <div className="hbar-sc-tooltip-title">{topic.keyword}</div>
      {count === 0 ? (
        <div className="hbar-sc-tooltip-empty">{NO_CLUSTERS_MESSAGE}</div>
      ) : (
        <>
          <div className="hbar-sc-tooltip-count">{`${count} cluster${count !== 1 ? "s" : ""}`}</div>
          <table className="hbar-sc-tooltip-table">
            <thead>
              <tr>
                <th className="hbar-sc-tooltip-th">Cluster</th>
                <th className="hbar-sc-tooltip-th hbar-sc-tooltip-th-pages">Pages</th>
                <th
                  className="hbar-sc-tooltip-th hbar-sc-tooltip-th-conf"
                  title="mean HDBSCAN membership probability of the cluster's pages"
                >
                  Conf
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.cluster_name}>
                  <td className="hbar-sc-tooltip-name" title={m.cluster_name}>
                    {m.cluster_name}
                  </td>
                  <td className="hbar-sc-tooltip-pages">{m.page_count}</td>
                  <td className="hbar-sc-tooltip-conf">
                    {m.mean_membership_probability !== null ? m.mean_membership_probability.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>,
    portalEl
  );
}
