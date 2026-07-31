"use client";

import { useEffect, useState, type CSSProperties } from "react";
import SandboxOverlayChip from "@/components/sandbox/SandboxOverlayChip";
import { fetchGraph } from "@/lib/api";
import type { GraphPayload } from "@/lib/types";

// Task S1 (batch 03 graph canvas port) scaffolding for the F2 bake-off's
// "A2: React-owned" sandbox -- see plan Task S3 for what lands in the
// mount slot below (components/sandbox/GraphA2.tsx, rendering the scene
// graph from React state fed by lib/graph/useForceLayout.ts). This page
// only proves the plumbing: fetch the real graph payload through 02's
// fetchGraph(), render a full-viewport dark container, and surface the
// shared overlay chip. No dots render yet, so "time-to-first-dots" here is
// really fetch-to-placeholder-render -- S3 re-points MARK_FIRST_DOTS at
// the renderer's own first-paint instead of changing this page's
// structure. Deliberately the same shape as graph-a1/page.tsx (same
// plumbing, different variant label + mark names) so the two sandboxes
// differ only in what S2/S3 drop into the mount slot, not in how the
// bake-off measures them.

const VARIANT_LABEL = "A2: react-owned";
const MARK_FETCH_START = "sandbox-a2-fetch-start";
const MARK_FIRST_DOTS = "sandbox-a2-first-dots";
const MEASURE_NAME = "sandbox-a2-time-to-first-dots";

const CONTAINER_STYLE: CSSProperties = {
  minHeight: "100vh",
  width: "100%",
  background: "var(--bg)",
  color: "var(--text)",
  colorScheme: "dark",
  position: "relative",
  boxSizing: "border-box",
};

const MOUNT_SLOT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const ERROR_STYLE: CSSProperties = {
  color: "var(--text)",
  opacity: 0.7,
  fontSize: "0.85rem",
};

export default function GraphA2SandboxPage() {
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    performance.mark(MARK_FETCH_START);
    fetchGraph()
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Marks once the placeholder below has committed with fetched data --
  // a separate effect (runs after the DOM commit triggered by setPayload
  // above) so this times render, not just data arrival. S3 moves this
  // mark into GraphA2's own first-paint instead.
  useEffect(() => {
    if (payload === null) return;
    performance.mark(MARK_FIRST_DOTS);
    const measure = performance.measure(MEASURE_NAME, MARK_FETCH_START, MARK_FIRST_DOTS);
    setElapsedMs(measure.duration);
  }, [payload]);

  return (
    <div style={CONTAINER_STYLE}>
      <SandboxOverlayChip
        variant={VARIANT_LABEL}
        nodeCount={payload ? payload.nodes.length : null}
        elapsedMs={elapsedMs}
      />
      {/* Mount slot: Task S3 drops components/sandbox/GraphA2.tsx here,
          fed by `payload` and lib/graph/constants.ts's GRAPH_DEFAULTS. */}
      <div style={MOUNT_SLOT_STYLE} data-testid="graph-a2-mount-slot">
        {error ? <p style={ERROR_STYLE}>Couldn&apos;t load graph: {error}</p> : null}
      </div>
    </div>
  );
}
