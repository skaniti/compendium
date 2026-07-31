"use client";

import { useEffect, useRef } from "react";
import type { GraphPayload } from "@/lib/types";
import iconDataRaw from "@/lib/icon-data.json";
import type { IconEntry } from "@/lib/icons";

// Task S2 (batch 03 graph canvas port) -- "A1: port-intact" sandbox spike.
// Mounts lib/graph/d3-graph-vendor.js's exported render(container, data,
// opts) against a real ref'd div, mirroring the dynamic-import idiom
// lib/vendor/*.js already uses in this repo (components/Starfield.tsx,
// components/CompendiumLoader.tsx): the vendor module touches `window`/
// `document` at module-eval time, so it's loaded from a client-only
// useEffect rather than a static top-level import (which would break SSR).
//
// `id="d3-graph-container"` matches the selector app/styles/theme.css
// already ported (batch 01) for the graph canvas mask + watermark/group-
// label/edge-chip rules -- see that file's `#d3-graph-container > svg`
// comment.
//
// No live-update wiring: this sandbox mounts once against the initial
// fetchGraph() payload (see app/sandbox/graph-a1/page.tsx) -- render()
// itself is idempotent against later calls (module-level `svg` state), but
// nothing here re-invokes it, matching the "sandbox bar" being
// deliberately partial.

interface IconDataFile {
  _category_order: string[];
  icons: Record<string, IconEntry>;
}
const iconData = iconDataRaw as IconDataFile;

export interface GraphA1Props {
  data: GraphPayload;
  // Fires once the vendor's render() call returns -- render() lays out and
  // paints synchronously (see the vendor file's own top-of-file docstring:
  // "Layout is computed synchronously ... then rendered once"), so by the
  // time this fires dots are actually on screen, unlike the placeholder
  // page's old payload-arrival mark.
  onFirstPaint?: () => void;
}

export default function GraphA1({ data, onFirstPaint }: GraphA1Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/graph/d3-graph-vendor.js").then((vendor) => {
      if (cancelled || !containerRef.current) return;
      vendor.render(containerRef.current, data, {
        icons: iconData.icons,
        // Sandbox bar: click-select wired to a console stub (S4's bake-off
        // promotion wires this to real selection UI instead).
        onSelect: (kind, id) => {
          console.info("[GraphA1] select", { kind, id });
        },
        // tunerSnapshot omitted -- GRAPH_DEFAULTS (code defaults) applies.
      });
      onFirstPaint?.();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once by
    // design (see the header comment above); data/onFirstPaint are the
    // initial fetch's stable values for this sandbox's scope.
  }, []);

  return <div id="d3-graph-container" ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
