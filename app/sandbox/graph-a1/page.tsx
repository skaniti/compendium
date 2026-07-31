"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import GraphA1 from "@/components/sandbox/GraphA1";
import SandboxOverlayChip from "@/components/sandbox/SandboxOverlayChip";
import { fetchGraph } from "@/lib/api";
import type { GraphPayload } from "@/lib/types";

// Task S1 (batch 03 graph canvas port) scaffolding for the F2 bake-off's
// "A1: port-intact" sandbox, extended by Task S2: components/sandbox/
// GraphA1.tsx (a near-verbatim port of the Dash d3_graph.js renderer) now
// mounts in the slot below once the fetch resolves. time-to-first-dots is
// measured from fetch-start to GraphA1's onFirstPaint callback, which
// fires right after the vendor's render() call returns (synchronous
// layout+paint) -- not from the old payload-arrival placeholder mark.

const VARIANT_LABEL = "A1: port-intact";
const MARK_FETCH_START = "sandbox-a1-fetch-start";
const MARK_FIRST_DOTS = "sandbox-a1-first-dots";
const MEASURE_NAME = "sandbox-a1-time-to-first-dots";

// S2 fix: CONTAINER_STYLE previously used minHeight (indefinite) instead
// of height. GraphA1's mounted div reads the container's measured size via
// a ResizeObserver (d3-graph-vendor.js, ported verbatim from Dash) and
// re-applies it to the SVG viewBox + zoom fit on every observed change --
// with an indefinite-height ancestor chain (minHeight percentages resolve
// against an "auto" reference), that produced a real feedback loop: each
// observed size nudged the SVG's rendered box a few px taller, which
// triggered another observation, taller again, unbounded (verified via
// CDP: container height grew ~28px per ResizeObserver tick with zero user
// interaction). A definite `height: 100vh` on this root breaks the loop --
// every descendant's percentage height now resolves against a fixed
// reference instead of another percentage.
const CONTAINER_STYLE: CSSProperties = {
  height: "100vh",
  width: "100%",
  background: "var(--bg)",
  color: "var(--text)",
  colorScheme: "dark",
  position: "relative",
  boxSizing: "border-box",
  overflow: "hidden",
};

const MOUNT_SLOT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
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

  // Passed to GraphA1 as onFirstPaint -- fires once the vendor's render()
  // call actually returns (dots painted), not on payload arrival/placeholder
  // commit like the pre-S2 version of this mark.
  const handleFirstPaint = useCallback(() => {
    performance.mark(MARK_FIRST_DOTS);
    const measure = performance.measure(MEASURE_NAME, MARK_FETCH_START, MARK_FIRST_DOTS);
    setElapsedMs(measure.duration);
  }, []);

  return (
    <div style={CONTAINER_STYLE}>
      <SandboxOverlayChip
        variant={VARIANT_LABEL}
        nodeCount={payload ? payload.nodes.length : null}
        elapsedMs={elapsedMs}
      />
      <div style={MOUNT_SLOT_STYLE} data-testid="graph-a1-mount-slot">
        {error ? <p style={ERROR_STYLE}>Couldn&apos;t load graph: {error}</p> : null}
        {payload ? <GraphA1 data={payload} onFirstPaint={handleFirstPaint} /> : null}
      </div>
    </div>
  );
}
