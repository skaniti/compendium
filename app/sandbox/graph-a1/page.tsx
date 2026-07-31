"use client";

import { useEffect, useState, type CSSProperties } from "react";
import SandboxOverlayChip from "@/components/sandbox/SandboxOverlayChip";
import { fetchGraph } from "@/lib/api";
import type { GraphPayload } from "@/lib/types";

// Task S1 (batch 03 graph canvas port) scaffolding for the F2 bake-off's
// "A1: port-intact" sandbox -- see plan Task S2 for what lands in the
// mount slot below (components/sandbox/GraphA1.tsx, a near-verbatim port
// of the Dash d3_graph.js renderer). This page only proves the plumbing:
// fetch the real graph payload through 02's fetchGraph(), render a
// full-viewport dark container, and surface the shared overlay chip. No
// dots render yet, so "time-to-first-dots" here is really
// fetch-to-placeholder-render -- S2 re-points MARK_FIRST_DOTS at the
// renderer's own first-paint instead of changing this page's structure.

const VARIANT_LABEL = "A1: port-intact";
const MARK_FETCH_START = "sandbox-a1-fetch-start";
const MARK_FIRST_DOTS = "sandbox-a1-first-dots";
const MEASURE_NAME = "sandbox-a1-time-to-first-dots";

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

export default function GraphA1SandboxPage() {
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
  // above) so this times render, not just data arrival. S2 moves this
  // mark into GraphA1's own first-paint instead.
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
      {/* Mount slot: Task S2 drops components/sandbox/GraphA1.tsx here,
          fed by `payload` and lib/graph/constants.ts's GRAPH_DEFAULTS. */}
      <div style={MOUNT_SLOT_STYLE} data-testid="graph-a1-mount-slot">
        {error ? <p style={ERROR_STYLE}>Couldn&apos;t load graph: {error}</p> : null}
      </div>
    </div>
  );
}
