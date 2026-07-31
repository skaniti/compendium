import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import GraphA1 from "./GraphA1";
import type { GraphPayload } from "@/lib/types";

// Task S2: unit-tests the WIRING (container/data/opts shape, onFirstPaint
// timing) against a mocked lib/graph/d3-graph-vendor.js rather than letting
// the real vendor module run -- unlike lib/vendor/*.js's simpler DOM-poll
// scripts (see CompendiumLoader.test.tsx/Starfield.test.tsx, which run the
// real vendored file), d3-graph-vendor.js does a real D3 force layout +
// SVG measurement (getBBox/getScreenCTM) that jsdom doesn't implement --
// mocking keeps this test fast and deterministic. Live rendering against
// the real vendor + a real dataset is verified separately (see task-S2
// report's live-check section), not here.
const renderMock = vi.fn();
vi.mock("@/lib/graph/d3-graph-vendor.js", () => ({
  render: (...args: unknown[]) => renderMock(...args),
}));

afterEach(() => {
  cleanup();
  renderMock.mockClear();
});

const TINY_PAYLOAD: GraphPayload = {
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

describe("GraphA1", () => {
  it("mounts a #d3-graph-container div and calls the vendor's render() with it", async () => {
    const { container } = render(<GraphA1 data={TINY_PAYLOAD} />);

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    const mountEl = container.querySelector("#d3-graph-container");
    expect(mountEl).not.toBeNull();

    const [calledContainer, calledData, calledOpts] = renderMock.mock.calls[0] as [
      HTMLElement,
      GraphPayload,
      { icons?: unknown; onSelect?: (kind: string | null, id: string | null) => void },
    ];
    expect(calledContainer).toBe(mountEl);
    expect(calledData).toBe(TINY_PAYLOAD);
    expect(calledOpts.icons).toBeTruthy();
    expect(typeof calledOpts.onSelect).toBe("function");
  });

  it("calls onFirstPaint once render() returns", async () => {
    const onFirstPaint = vi.fn();
    render(<GraphA1 data={TINY_PAYLOAD} onFirstPaint={onFirstPaint} />);

    await waitFor(() => expect(onFirstPaint).toHaveBeenCalledTimes(1));
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when onFirstPaint is omitted", async () => {
    render(<GraphA1 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
  });

  it("forwards opts.onSelect through to a console stub", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    render(<GraphA1 data={TINY_PAYLOAD} />);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));

    const [, , calledOpts] = renderMock.mock.calls[0] as [
      unknown,
      unknown,
      { onSelect: (kind: string | null, id: string | null) => void },
    ];
    calledOpts.onSelect("cluster", "cluster-1");
    expect(infoSpy).toHaveBeenCalledWith("[GraphA1] select", { kind: "cluster", id: "cluster-1" });
    infoSpy.mockRestore();
  });
});
