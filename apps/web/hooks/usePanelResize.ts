"use client";

import { useEffect, useRef } from "react";
import { patchPreferences } from "@/lib/preferences";

// Port of assets/panel_resize.js. Two independent resize handles
// (#resize-handle-left between left<->center, #resize-handle-right between
// center<->right) drag-resize the left/right panels; the center panel is
// flex: 1 1 auto and auto-fills whatever's left. During a drag the new
// width is written straight onto the container's inline style as a CSS
// custom property (--panel-left-width / --panel-right-width) -- no React
// state, so dragging doesn't thrash re-renders. On mouseup both current
// widths are read back and persisted via patchPreferences, matching Dash's
// panel_left_width / panel_right_width preference keys exactly.
const MIN_PANEL_WIDTH_PX = 120;
const MAX_PANEL_WIDTH_FRACTION = 0.4;

type Side = "left" | "right";

interface ActiveDrag {
  onMove: (ev: MouseEvent) => void;
  onUp: () => void;
}

// canPersist: demo sessions (AppShell.tsx's isDemo: a direct demo login or
// an admin viewing as demo) get a 403 from the backend's
// update_preferences endpoint on ANY PATCH. false skips the patchPreferences call on mouseup
// entirely; the drag itself (DOM width updates via the CSS custom property)
// is untouched. Defaults to true so every existing call site (PanelGrid,
// with no session context threaded through) behaves exactly as before this
// param existed.
export function usePanelResize(canPersist: boolean = true) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leftHandleRef = useRef<HTMLDivElement | null>(null);
  const rightHandleRef = useRef<HTMLDivElement | null>(null);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  // Handlers for whichever drag is currently in progress (at most one at a
  // time -- a single mouse can't start a second drag before releasing the
  // first). Unmounting mid-drag never fires the handle's own onUp (that
  // only runs on a real mouseup), so without this the document-level
  // mousemove/mouseup listeners -- and the cursor/userSelect body styles --
  // would leak past the component's lifetime.
  const activeDragRef = useRef<ActiveDrag | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const leftHandle = leftHandleRef.current;
    const rightHandle = rightHandleRef.current;
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!container || !leftHandle || !rightHandle || !leftPanel || !rightPanel) return;

    const detachLeft = attachHandle(leftHandle, container, leftPanel, "left", activeDragRef, canPersist);
    const detachRight = attachHandle(rightHandle, container, rightPanel, "right", activeDragRef, canPersist);
    return () => {
      detachLeft();
      detachRight();

      const active = activeDragRef.current;
      if (active) {
        document.removeEventListener("mousemove", active.onMove);
        document.removeEventListener("mouseup", active.onUp);
        activeDragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, [canPersist]);

  return { containerRef, leftHandleRef, rightHandleRef, leftPanelRef, rightPanelRef };
}

function attachHandle(
  handle: HTMLElement,
  container: HTMLElement,
  panel: HTMLElement,
  side: Side,
  activeDragRef: { current: ActiveDrag | null },
  canPersist: boolean,
): () => void {
  function onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.offsetWidth;
    const containerWidth = container.offsetWidth;

    handle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent): void {
      let delta = ev.clientX - startX;
      // Left handle: dragging right -> left panel wider.
      // Right handle: dragging left -> right panel wider.
      if (side === "right") delta = -delta;

      const maxWidth = containerWidth * MAX_PANEL_WIDTH_FRACTION;
      const newWidth = Math.max(MIN_PANEL_WIDTH_PX, Math.min(startWidth + delta, maxWidth));
      const pct = `${((newWidth / containerWidth) * 100).toFixed(2)}%`;

      container.style.setProperty(`--panel-${side}-width`, pct);
    }

    function onUp(): void {
      handle.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      activeDragRef.current = null;

      const computed = getComputedStyle(container);
      const leftPct = computed.getPropertyValue("--panel-left-width").trim() || "20%";
      const rightPct = computed.getPropertyValue("--panel-right-width").trim() || "20%";

      // Plain demo: skip the PATCH entirely -- see usePanelResize's own
      // canPersist doc comment for why (known 403, Dash parity). The drag
      // itself already applied above via the CSS custom property.
      if (canPersist) {
        void patchPreferences({ panel_left_width: leftPct, panel_right_width: rightPct });
      }
    }

    activeDragRef.current = { onMove, onUp };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  handle.addEventListener("mousedown", onMouseDown as EventListener);
  return () => handle.removeEventListener("mousedown", onMouseDown as EventListener);
}
