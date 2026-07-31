"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import GraphA2 from "@/components/sandbox/GraphA2";
import SandboxOverlayChip from "@/components/sandbox/SandboxOverlayChip";
import { fetchGraph } from "@/lib/api";
import type { GraphPayload } from "@/lib/types";

// Task S1 (batch 03 graph canvas port) scaffolding for the F2 bake-off's
// "A2: React-owned" sandbox, extended by Task S3: components/sandbox/
// GraphA2.tsx (the React-owned scene-graph renderer, fed by lib/graph/
// useForceLayout.ts + lib/graph/Zoom.tsx) now mounts in the slot below
// once the fetch resolves. time-to-first-dots is measured from fetch-start
// to GraphA2's onFirstPaint callback, which fires right after the force
// layout's first commit (the phyllotaxis seed -- see useForceLayout.ts's
// header comment) -- not from the old payload-arrival placeholder mark.
// Same wiring shape as graph-a1/page.tsx (the S2 task applied the same
// treatment there first); see this file's git history pre-S3 for the
// placeholder-only version.

const VARIANT_LABEL = "A2: react-owned";
const MARK_FETCH_START = "sandbox-a2-fetch-start";
const MARK_FIRST_DOTS = "sandbox-a2-first-dots";
const MEASURE_NAME = "sandbox-a2-time-to-first-dots";

// S2 fix (graph-a1/page.tsx) applied here too: minHeight (indefinite) on an
// ancestor chain whose descendants also use percentage heights produces a
// ResizeObserver feedback loop the moment anything in the tree measures its
// own size (see that file's S2 fix comment for the verified failure mode).
// GraphA2 doesn't use a ResizeObserver (see its own header comment), so
// this sandbox never hit that loop -- but a definite height is still the
// correct container contract for an SVG sized via getBoundingClientRect,
// and matching graph-a1/page.tsx keeps the two sandboxes' plumbing
// identical apart from the mount slot's contents.
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

  // Passed to GraphA2 as onFirstPaint -- fires once the force layout's
  // first commit lands (the phyllotaxis seed, before any sim ticking), not
  // on payload arrival/placeholder commit like the pre-S3 version of this
  // mark.
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
      <div style={MOUNT_SLOT_STYLE} data-testid="graph-a2-mount-slot">
        {error ? <p style={ERROR_STYLE}>Couldn&apos;t load graph: {error}</p> : null}
        {payload ? <GraphA2 data={payload} onFirstPaint={handleFirstPaint} /> : null}
      </div>
    </div>
  );
}
