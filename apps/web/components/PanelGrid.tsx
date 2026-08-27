"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePanelResize } from "@/hooks/usePanelResize";

// A CSS custom property isn't a key React.CSSProperties types out of the
// box; this is the standard escape hatch (same shape ThemeProvider's
// generateCssText output gets assigned into via #theme-root, just here as
// an inline style object instead of a <style> tag).
type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

interface PanelGridProps {
  // Server-read initial widths (mirrors Dash's _panel_width_style()).
  // Omitted -> the ported CSS's own var(--panel-*-width, 20%) fallback wins.
  initialLeftWidth?: string;
  initialRightWidth?: string;
  // Threaded down to usePanelResize -- see that hook's own doc comment.
  // Plain demo sessions (AppShell's isPlainDemo) get 403'd on the
  // mouseup PATCH, Dash parity; defaults to true so every existing render
  // of this (client) component without an explicit session context behaves
  // exactly as before this prop existed.
  canPersist?: boolean;
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

export default function PanelGrid({
  initialLeftWidth,
  initialRightWidth,
  canPersist = true,
  left,
  center,
  right,
}: PanelGridProps) {
  const { containerRef, leftPanelRef, leftHandleRef, rightHandleRef, rightPanelRef } =
    usePanelResize(canPersist);

  const style: StyleWithVars = {};
  if (initialLeftWidth) style["--panel-left-width"] = initialLeftWidth;
  if (initialRightWidth) style["--panel-right-width"] = initialRightWidth;

  return (
    <div ref={containerRef} className="app-container" style={style}>
      <div ref={leftPanelRef} className="panel panel-left">
        {left}
      </div>
      <div ref={leftHandleRef} id="resize-handle-left" className="panel-resize-handle" />
      <div className="panel panel-center">{center}</div>
      <div ref={rightHandleRef} id="resize-handle-right" className="panel-resize-handle" />
      <div ref={rightPanelRef} className="panel panel-right">
        {right}
      </div>
    </div>
  );
}
