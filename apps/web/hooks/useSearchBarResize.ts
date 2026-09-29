"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Port of assets/search_stream.js's tab minimize/maximize + attachResize
// (Dash: #search-tab toggles .minimized on #search-bar; #search-resize-handle
// drag-resizes it, clamped to 70vh, snapping back to minimized if dragged
// below its natural collapsed height). Follows the same conventions as
// usePanelResize.ts: refs for the DOM nodes, an activeDragRef safety net so
// an unmount mid-drag can't leak document-level listeners or leave the body
// cursor/userSelect stuck, and a per-pixel height write straight onto the
// bar's inline style during the drag itself (no React state per mousemove --
// state only changes at the discrete start/end/snap transitions).
//
// Unlike usePanelResize's width (a persisted CSS custom property),
// #search-bar's collapsed/expanded state isn't persisted -- Dash always
// starts minimized on load (search_stream.js's attach(): "Start minimized"),
// so this hook does the same and never reads/writes preferences. Only the
// dragged-open HEIGHT is remembered (ref + sessionStorage, see below), so
// collapse -> expand returns to where the user dragged it.
const MIN_BAR_HEIGHT_FALLBACK_PX = 50;
const MAXIMIZED_HEIGHT_CAP_PX = 400;
const MAXIMIZED_HEIGHT_VIEWPORT_FRACTION = 0.5;
const MAX_DRAG_HEIGHT_VIEWPORT_FRACTION = 0.7; // matches search-bar.css's max-height: 70vh
const SNAP_TO_MINIMIZED_SLACK_PX = 10;
// The last dragged-open height survives collapse/expand (ref) and a reload in
// the same tab (sessionStorage). Fail-open: storage may throw or be absent.
const HEIGHT_STORAGE_KEY = "compendium-search-height";

function readStoredHeight(): number | null {
  try {
    const raw = sessionStorage.getItem(HEIGHT_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStoredHeight(px: number): void {
  try {
    sessionStorage.setItem(HEIGHT_STORAGE_KEY, String(px));
  } catch {
    /* fail-open */
  }
}

interface ActiveDrag {
  onMove: (ev: MouseEvent) => void;
  onUp: () => void;
}

export function useSearchBarResize() {
  const barRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  // null until a drag ends above the snap threshold (lazy-hydrated from storage).
  const lastHeightRef = useRef<number | null>(null);
  // Dash's #search-bar starts with the .minimized class already applied
  // (attach() runs "Start minimized" unconditionally on load).
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);

  const openHeight = useCallback((): number => {
    if (lastHeightRef.current === null) lastHeightRef.current = readStoredHeight();
    const remembered = lastHeightRef.current;
    if (remembered === null) return getMaximizedHeightPx();
    return Math.min(remembered, window.innerHeight * MAX_DRAG_HEIGHT_VIEWPORT_FRACTION);
  }, []);

  const toggleMaximized = useCallback(() => {
    const bar = barRef.current;
    setMaximized((prev) => {
      const next = !prev;
      if (bar) animateToHeight(bar, next ? openHeight() : getMinBarHeight(bar));
      return next;
    });
  }, [openHeight]);

  // search_stream.js's runStreamingQuery(): `if (bar && !isMaximized(bar))
  // setMaximized(bar, true);` -- expand-only (no-op if already maximized),
  // used when sending a query while the bar is collapsed.
  const expand = useCallback(() => {
    const bar = barRef.current;
    setMaximized((prev) => {
      if (prev) return prev;
      if (bar) animateToHeight(bar, openHeight());
      return true;
    });
  }, [openHeight]);

  useEffect(() => {
    const bar = barRef.current;
    const handle = handleRef.current;
    if (!bar || !handle) return;

    function onMouseDown(e: MouseEvent): void {
      e.preventDefault();
      const startY = e.clientY;
      const startH = bar!.offsetHeight;
      const minH = getMinBarHeight(bar!);

      setResizing(true);
      setMaximized(true);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: MouseEvent): void {
        const delta = startY - ev.clientY;
        const maxH = window.innerHeight * MAX_DRAG_HEIGHT_VIEWPORT_FRACTION;
        const newH = Math.max(minH, Math.min(startH + delta, maxH));
        bar!.style.height = `${newH}px`;
      }

      function onUp(): void {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        activeDragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizing(false);

        // If resized down to (near) its minimum, snap to minimized state.
        const currentH = bar!.offsetHeight;
        const snapThreshold = getMinBarHeight(bar!) + SNAP_TO_MINIMIZED_SLACK_PX;
        if (currentH <= snapThreshold) {
          animateToHeight(bar!, getMinBarHeight(bar!));
          setMaximized(false);
        } else {
          lastHeightRef.current = currentH;
          writeStoredHeight(currentH);
        }
      }

      activeDragRef.current = { onMove, onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    handle.addEventListener("mousedown", onMouseDown as EventListener);
    return () => {
      handle.removeEventListener("mousedown", onMouseDown as EventListener);

      const active = activeDragRef.current;
      if (active) {
        document.removeEventListener("mousemove", active.onMove);
        document.removeEventListener("mouseup", active.onUp);
        activeDragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  return { barRef, handleRef, maximized, resizing, toggleMaximized, expand };
}

/** Collapsed height: the resize handle + input row, no conversation. */
function getMinBarHeight(bar: HTMLElement): number {
  const inputRow = bar.querySelector<HTMLElement>(".search-bar-input-row");
  const handle = bar.querySelector<HTMLElement>(".search-resize-handle");
  let h = 0;
  if (handle) h += handle.offsetHeight;
  if (inputRow) h += inputRow.offsetHeight;
  return h || MIN_BAR_HEIGHT_FALLBACK_PX;
}

/** Computed live (not cached at module load) so a window resize between
 * load and first maximize doesn't leave a stale value -- matches
 * search_stream.js's getMaximizedHeight(). */
function getMaximizedHeightPx(): number {
  return Math.min(MAXIMIZED_HEIGHT_CAP_PX, window.innerHeight * MAXIMIZED_HEIGHT_VIEWPORT_FRACTION);
}

/** CSS transitions can't animate from `height: auto`, so freeze the current
 * pixel height as the transition start, force a reflow, then set the target
 * -- same two-step dance as search_stream.js's setMaximized(). */
function animateToHeight(bar: HTMLElement, targetPx: number): void {
  bar.style.height = `${bar.offsetHeight}px`;
  void bar.offsetHeight; // force reflow
  bar.style.height = `${targetPx}px`;
}
