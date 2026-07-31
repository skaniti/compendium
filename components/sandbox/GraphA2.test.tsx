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
