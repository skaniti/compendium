"use client";

import type { CSSProperties } from "react";

// Shared readout for the F2 graph-canvas bake-off sandboxes
// (app/sandbox/graph-a1, app/sandbox/graph-a2). Task S1 has no variant
// renderer yet -- elapsedMs is fetch-to-placeholder-render -- so this chip
// is deliberately generic (variant name + node count + elapsed ms) rather
// than reading anything renderer-specific. S2/S3 re-point elapsedMs at
// fetch-to-first-dots once the real D3/React renderer lands in the mount
// slot; this component's props/markup don't need to change for that.
export interface SandboxOverlayChipProps {
  variant: string;
  nodeCount: number | null;
  elapsedMs: number | null;
}

const CHIP_STYLE: CSSProperties = {
  position: "fixed",
  top: 12,
  left: 12,
  zIndex: 10,
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  fontFamily: "monospace",
  fontSize: "0.75rem",
  lineHeight: 1.6,
  pointerEvents: "none",
};

export default function SandboxOverlayChip({ variant, nodeCount, elapsedMs }: SandboxOverlayChipProps) {
  return (
    <div style={CHIP_STYLE} data-testid="sandbox-overlay-chip">
      <div>{variant}</div>
      <div>nodes: {nodeCount ?? "…"}</div>
      <div>time-to-first-dots: {elapsedMs !== null ? `${elapsedMs.toFixed(1)}ms` : "…"}</div>
    </div>
  );
}
