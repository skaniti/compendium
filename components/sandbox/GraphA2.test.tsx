import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import GraphA2 from "./GraphA2";
import { GRAPH_DEFAULTS } from "@/lib/graph/constants";
import type { GraphPayload } from "@/lib/types";

// Task S3: unit-tests GraphA2's WIRING against a tiny synthetic payload --
// unlike GraphA1.test.tsx (which mocks the vendor module entirely to
// sidestep jsdom's missing getBBox/getScreenCTM), GraphA2 is a plain SVG
// scene graph driven by React state/refs, and its own d3-force sim/d3-zoom
// usage works fine against jsdom (no getBBox/getScreenCTM calls on this
// component's own render path -- those only show up in Zoom.tsx's
// collision-cull pass, which no-ops when every rect measures {0,0,0,0}, see
// that file's own comment). Live rendering against the real backend +
// real dataset is verified separately (task-S3 report's live-check
// section), not here.

const TINY_PAYLOAD: GraphPayload = {
  nodes: [
    {
      id: "p1",
      label: "Page One",
      level: 0,
      kind: "cluster",
      visit_count: 1,
      parent_id: "c1",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/one"],
      first_visited_at: null,
    },
    {
      id: "p2",
      label: "Page Two",
      level: 0,
      kind: "cluster",
      visit_count: 2,
      parent_id: "c1",
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/two"],
      first_visited_at: null,
    },
    {
      id: "p3",
      label: "Solo Page",
      level: 0,
      kind: "singleton",
      visit_count: 1,
      parent_id: null,
      children_ids: [],
      capture_ids: [],
      page_urls: ["https://example.com/solo"],
      first_visited_at: null,
    },
  ],
  links: [],
  clusters: [{ id: "c1", name: "Cluster One", page_ids: ["p1", "p2"] }],
  super_clusters: [],
  groups: [],
};

afterEach(() => {
  cleanup();
});

describe("GraphA2", () => {
  it("renders one circle.page per node, all with computed positions", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);

    await waitFor(() => {
      expect(container.querySelectorAll("circle.page").length).toBe(3);
    });
    container.querySelectorAll("circle.page").forEach((el) => {
      expect(el.getAttribute("cx")).not.toBeNull();
      expect(el.getAttribute("cy")).not.toBeNull();
      expect(Number.isNaN(Number(el.getAttribute("cx")))).toBe(false);
    });
  });

  it("class-discriminates singleton dots from clustered ones", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));

    expect(container.querySelector('circle[data-kind="singleton"]')?.getAttribute("class")).toBe("page singleton");
    expect(container.querySelector('circle[data-kind="cluster"]')?.getAttribute("class")).toBe("page");
  });

  it("renders a use.star-spikes glyph per node, referencing one of the 4 star defs", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("use.star-spikes").length).toBe(3));
    expect(container.querySelectorAll("path[id^='star-v']").length).toBe(4);
  });

  it("renders a g.hull-label-group with the cluster's wrapped name", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => {
      expect(container.querySelector("g.hull-label-group")).not.toBeNull();
    });
    const group = container.querySelector("g.hull-label-group")!;
    expect(group.getAttribute("data-page-count")).toBe("2");
    expect(group.querySelector("text.hull-label")?.textContent).toBe("Cluster One");
  });

  it("calls onFirstPaint once, after dots exist", async () => {
    const onFirstPaint = vi.fn();
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} onFirstPaint={onFirstPaint} />);

    await waitFor(() => expect(onFirstPaint).toHaveBeenCalledTimes(1));
    expect(container.querySelectorAll("circle.page").length).toBe(3);
  });

  it("does not throw when onFirstPaint/onSelect are omitted", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));
  });

  it("clicking a node's hit circle calls onSelect('node', id)", async () => {
    const onSelect = vi.fn();
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} onSelect={onSelect} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));

    const circle = container.querySelector('circle[data-kind="singleton"]')!;
    fireEvent.click(circle);
    expect(onSelect).toHaveBeenCalledWith("node", "p3");
  });

  it("clicking a hull-label-group calls onSelect('cluster', id)", async () => {
    const onSelect = vi.fn();
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} onSelect={onSelect} />);
    await waitFor(() => expect(container.querySelector("g.hull-label-group")).not.toBeNull());

    fireEvent.click(container.querySelector("g.hull-label-group")!);
    expect(onSelect).toHaveBeenCalledWith("cluster", "c1");
  });

  it("clicking the svg background calls onSelect(null, null)", async () => {
    const onSelect = vi.fn();
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} onSelect={onSelect} />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());

    fireEvent.click(container.querySelector("svg")!);
    expect(onSelect).toHaveBeenCalledWith(null, null);
  });

  it("clicking a dot does not also fire the background onSelect(null, null)", async () => {
    const onSelect = vi.fn();
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} onSelect={onSelect} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));

    fireEvent.click(container.querySelector('circle[data-kind="singleton"]')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("node", "p3");
  });

  it("forwards through a default console stub when onSelect is omitted", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));

    fireEvent.click(container.querySelector('circle[data-kind="singleton"]')!);
    expect(infoSpy).toHaveBeenCalledWith("[GraphA2] select", { kind: "node", id: "p3" });
    infoSpy.mockRestore();
  });

  it("mounts and unmounts cleanly under StrictMode's double-invoked effects (no leaked/double sim)", async () => {
    const onFirstPaint = vi.fn();
    const { container, unmount } = render(
      <StrictMode>
        <GraphA2 data={TINY_PAYLOAD} onFirstPaint={onFirstPaint} />
      </StrictMode>
    );

    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));
    expect(() => unmount()).not.toThrow();
  });

  it("applies an initial fit-to-content transform to g.graph-root", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));

    await waitFor(() => {
      const transform = container.querySelector("g.graph-root")?.getAttribute("transform");
      expect(transform).toBeTruthy();
      expect(transform).toMatch(/translate\(/);
    });
  });

  it("wheel-zooming the svg changes g.graph-root's transform", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));
    await waitFor(() => expect(container.querySelector("g.graph-root")?.getAttribute("transform")).toBeTruthy());

    const before = container.querySelector("g.graph-root")!.getAttribute("transform");
    const svg = container.querySelector("svg")!;
    fireEvent.wheel(svg, { deltaY: -120, deltaMode: 0, clientX: 400, clientY: 300 });

    await waitFor(() => {
      const after = container.querySelector("g.graph-root")!.getAttribute("transform");
      expect(after).not.toBe(before);
    });
  });

  it("screen-clamps circle.page radius after fit (critical fix: not a flat world-unit constant)", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelectorAll("circle.page").length).toBe(3));
    await waitFor(() => expect(container.querySelector("g.graph-root")?.getAttribute("transform")).toBeTruthy());

    const transform = container.querySelector("g.graph-root")!.getAttribute("transform")!;
    const scaleMatch = transform.match(/scale\(([-\d.]+)\)/);
    expect(scaleMatch).not.toBeNull();
    const fitScale = Number(scaleMatch![1]);

    // A non-singleton dot: at fit, ratio(=zoomK/fitZoom) is 1, inside the
    // pageDot band [0.9, 2.1], so effRatio=1 and the painted SCREEN size
    // is BASE_PAGE_DOT_SIZE regardless of what fitScale itself is -- the
    // previous (effRatio/ratio) formula instead held the WORLD radius at a
    // flat BASE_PAGE_DOT_SIZE, so the screen size scaled WITH fitScale
    // (wrong by a factor of fitScale -- see render-helpers.test.ts's
    // clampedScale/pageDotRadius suite for the isolated formula proof).
    const circle = container.querySelector('circle[data-kind="cluster"]')!;
    const worldR = Number(circle.getAttribute("r"));
    expect(worldR * fitScale).toBeCloseTo(GRAPH_DEFAULTS.BASE_PAGE_DOT_SIZE, 1);
  });

  // Review round 2, finding 1: pins the end-to-end (React + Zoom) hull-label
  // tspan y at a NON-1 fitZoom against the vendor's updateLabelScale
  // geometry directly -- round 1's coverage never exercised this (only
  // font-size, and only ever implicitly at the ratio=1 fit moment), which
  // is exactly how the write-fight regression slipped through review.
  it("pins hull-label tspan y to the vendor's screen-clamped geometry at a non-1 fitZoom (finding 1)", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelector("g.hull-label-group")).not.toBeNull());
    await waitFor(() => expect(container.querySelector("g.graph-root")?.getAttribute("transform")).toBeTruthy());

    const scaleOf = () =>
      Number(container.querySelector("g.graph-root")!.getAttribute("transform")!.match(/scale\(([-\d.]+)\)/)![1]);
    const fitZoom = scaleOf();

    const svg = container.querySelector("svg")!;
    fireEvent.wheel(svg, { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300 });
    await waitFor(() => expect(scaleOf()).not.toBeCloseTo(fitZoom, 5));
    const zoomK = scaleOf();
    const ratio = zoomK / fitZoom;
    expect(ratio).not.toBeCloseTo(1, 2); // sanity: genuinely a non-1 ratio scenario

    const text = container.querySelector("text.hull-label")!;
    const clusterTopYMatch = text.getAttribute("transform")!.match(/translate\(0,([-\d.]+)\)/);
    expect(clusterTopYMatch).not.toBeNull();
    const clusterTopY = Number(clusterTopYMatch![1]);
    const lineCount = Number(text.getAttribute("data-line-count"));
    expect(text.getAttribute("data-is-sc")).toBeNull(); // TINY_PAYLOAD's cluster has no super_cluster

    // Vendor :1332-1350 (clLabel branch, non-SC) reproduced directly here
    // (not via this codebase's own clampedScale/hullLabelLineOffsets
    // helpers) so this test pins independently against the vendor formula.
    const { k_min, k_max } = GRAPH_DEFAULTS.SCALE_THRESHOLDS.clLabel;
    const effRatio = Math.min(k_max, Math.max(k_min, ratio));
    const scale = effRatio / zoomK; // vendor clampedScale, :537
    const baseSize = GRAPH_DEFAULTS.BASE_LABEL_FONT_SIZE;
    const lineH = baseSize * 1.2 * scale; // vendor :1336
    const gap = 16 * scale; // vendor :1337
    const newCenterY = clusterTopY - gap - 2 - (lineCount - 1) * (lineH / 2); // vendor :1349
    const startY = newCenterY - ((lineCount - 1) * lineH) / 2;

    // tspan `y` itself is RELATIVE (clusterTopY lives on the wrapping
    // <text>'s `transform` -- see the finding-1 ownership-split comment in
    // GraphA2.tsx's HullLabels); the EFFECTIVE rendered position is
    // clusterTopY + tspan.y, which is what must match the vendor's
    // absolute newCenterY/startY formula -- this also end-to-end validates
    // that the translate+relative-offset split actually reconstructs the
    // correct absolute position.
    const tspans = Array.from(text.querySelectorAll("tspan"));
    expect(tspans.length).toBe(lineCount);
    tspans.forEach((tspan, i) => {
      const effectiveY = clusterTopY + Number(tspan.getAttribute("y"));
      expect(effectiveY).toBeCloseTo(startY + i * lineH, 4);
    });
  });

  // Review round 2, finding 1: the exact "zooming during active settle"
  // scenario the finding describes, in the spirit of round 1's finding-7
  // star-glyph write-fight test -- confirms Zoom's zoom-scaled tspan y
  // write is never clobbered by a subsequent tick-driven re-render (which,
  // before this fix, re-rendered the same attribute from live position
  // data using the UNSCALED vendor constants).
  it("keeps hull-label tspan y pinned to the zoom-scaled anchor across tick-driven re-renders after a zoom event (finding 1 -- no write-fight clobber)", async () => {
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelector("g.hull-label-group")).not.toBeNull());
    await waitFor(() => expect(container.querySelector("g.graph-root")?.getAttribute("transform")).toBeTruthy());

    const svg = container.querySelector("svg")!;
    fireEvent.wheel(svg, { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300 });
    await waitFor(() => expect(container.querySelector("g.graph-root")!.getAttribute("transform")).toMatch(/scale\(/));

    const text = container.querySelector("text.hull-label")!;
    const firstTspanY = () => Number(text.querySelector("tspan")!.getAttribute("y"));
    // The React-owned position-carrying <g> for a page dot's star glyph
    // (see PageDots) -- sampled to prove the sim is ACTIVELY re-rendering
    // during the wait window below, so "tspan y didn't change" is proof
    // of the fix, not a vacuous pass because nothing re-rendered at all.
    const dotTranslate = () => container.querySelector("g.nodes > g")?.getAttribute("transform");

    const afterZoomY = firstTspanY();
    const translateBefore = dotTranslate();

    await new Promise((r) => setTimeout(r, 300));

    expect(dotTranslate()).not.toBe(translateBefore); // sim genuinely kept ticking
    expect(firstTspanY()).toBeCloseTo(afterZoomY, 5); // ...but tspan y held steady
  });

  it("memoizes the hull-label color map -- getComputedStyle call count plateaus across additional ticks (finding 6)", async () => {
    const getComputedStyleSpy = vi.spyOn(window, "getComputedStyle");
    const { container } = render(<GraphA2 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(container.querySelector("g.hull-label-group")).not.toBeNull());

    // Let a few more animation-frame ticks land (the tiny payload settles
    // fast, but a couple more commits should still occur).
    await new Promise((r) => setTimeout(r, 150));
    const countAfterSettling = getComputedStyleSpy.mock.calls.length;

    await new Promise((r) => setTimeout(r, 300));
    const countLater = getComputedStyleSpy.mock.calls.length;

    // Before the fix, buildClusterColorMap()+labelColor() (both
    // getComputedStyle consumers) re-ran on every tick-driven re-render;
    // after memoizing on "positions now exist" (not the ever-incrementing
    // version), the count must stop growing once positions exist.
    expect(countLater).toBe(countAfterSettling);
    getComputedStyleSpy.mockRestore();
  });

  it("handles an empty graph without throwing", async () => {
    const empty: GraphPayload = { nodes: [], links: [], clusters: [], super_clusters: [], groups: [] };
    const { container } = render(<GraphA2 data={empty} />);
    // Nothing to wait for -- the sim never starts (useForceLayout's own
    // `!nodes.length` guard) -- just assert it rendered without throwing.
    expect(container.querySelector("#d3-graph-container")).not.toBeNull();
  });
});
