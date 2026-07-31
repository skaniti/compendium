import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GraphPayload } from "@/lib/types";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";

// S2 fix round 1 (review finding 2): exercises the REAL vendor module's
// container-changed guard (header comment delta #10) directly against
// jsdom -- GraphA1.test.tsx mocks lib/graph/d3-graph-vendor.js (see that
// file's own header comment: the real module does a D3 force layout + SVG
// measurement jsdom doesn't implement), so it can never observe this.
//
// A minimal 1-node, 0-cluster, 0-link payload keeps the real render()
// pipeline jsdom-safe: 0 clusters means measureLabelDims/getBBox-driven
// label measurement is never reached (only called per-cluster), and every
// SANDBOX_SECTION_GATES section that touches getScreenCTM/getBBox
// (nebula/watermark/edgeChip/tooltip/lodNicety) is off by default anyway.
const ONE_NODE_PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "page-1",
      label: "Test Page",
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [],
  super_clusters: [],
  groups: [],
};

describe("d3-graph-vendor render() container-changed guard", () => {
  beforeEach(() => {
    // Pre-seeds a real --galaxy-0 custom property so render()'s
    // retryColors() self-scheduling setTimeout loop (up to 15x/200ms,
    // polling for real CSS custom properties) finds one immediately and
    // never schedules a timer -- keeps the test deterministic and avoids
    // leaking pending timers across tests.
    document.documentElement.style.setProperty("--galaxy-0", "#4e79a7");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--galaxy-0");
  });

  it("builds a fresh SVG in a newly mounted container after a remount", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");

    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, {});
    expect(containerA.querySelector("svg")).not.toBeNull();

    // Simulate GraphA1 unmounting (its container leaves the document) and
    // remounting into a brand-new container -- e.g. navigating away from
    // and back to /sandbox/graph-a1.
    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    render(containerB, ONE_NODE_PAYLOAD, {});

    // Pre-fix: the module-level `svg` still pointed at containerA's
    // (detached) <svg>, so the internal render()'s `if (!svg)` block never
    // ran again -- nothing got appended to containerB at all (the "blank
    // canvas, no error" bug from the review finding).
    expect(containerB.querySelector("svg")).not.toBeNull();
  });

  it("accepts a second mount's tunerSnapshot without throwing (finding 2's __tunerInitialized half)", async () => {
    const { render } = await import("@/lib/graph/d3-graph-vendor.js");
    // Pre-fix, __tunerInitialized never reset past the first mount, so a
    // second mount's tunerSnapshot was silently ignored rather than
    // erroring -- there's no public getter to read the applied tuner state
    // back through, so this is a smoke check (doesn't throw, still paints)
    // rather than a pixel-level assertion. The container-changed guard's
    // `__tunerInitialized = false` reset is what makes applyTunerSnapshot
    // run again here at all.
    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    render(containerA, ONE_NODE_PAYLOAD, { tunerSnapshot: GRAPH_DEFAULTS });

    containerA.remove();
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    expect(() =>
      render(containerB, ONE_NODE_PAYLOAD, {
        tunerSnapshot: { ...GRAPH_DEFAULTS, BASE_LABEL_FONT_SIZE: 11 },
      }),
    ).not.toThrow();
    expect(containerB.querySelector("svg")).not.toBeNull();
  });
});
