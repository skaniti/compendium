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

export function usePanelResize() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leftHandleRef = useRef<HTMLDivElement | null>(null);
  const rightHandleRef = useRef<HTMLDivElement | null>(null);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const leftHandle = leftHandleRef.current;
    const rightHandle = rightHandleRef.current;
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!container || !leftHandle || !rightHandle || !leftPanel || !rightPanel) return;

    const detachLeft = attachHandle(leftHandle, container, leftPanel, "left");
    const detachRight = attachHandle(rightHandle, container, rightPanel, "right");
    return () => {
      detachLeft();
      detachRight();
    };
  }, []);

  return { containerRef, leftHandleRef, rightHandleRef, leftPanelRef, rightPanelRef };
}

function attachHandle(
  handle: HTMLElement,
  container: HTMLElement,
  panel: HTMLElement,
  side: Side,
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

      const computed = getComputedStyle(container);
      const leftPct = computed.getPropertyValue("--panel-left-width").trim() || "20%";
      const rightPct = computed.getPropertyValue("--panel-right-width").trim() || "20%";

      void patchPreferences({ panel_left_width: leftPct, panel_right_width: rightPct });
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  handle.addEventListener("mousedown", onMouseDown as EventListener);
  return () => handle.removeEventListener("mousedown", onMouseDown as EventListener);
}
