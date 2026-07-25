import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGraph, __resetGraphCacheForTest } from "./useGraph";
import * as api from "@/lib/api";
import type { GraphNode, GraphPayload } from "@/lib/types";

// Module-level fetch-once cache (Task 5, batch 02) -- multiple useGraph()
// consumers (header, canvas, panels) mounted at once must share ONE
// fetchGraph() flight rather than each firing their own request.
// __resetGraphCacheForTest() mirrors the vendor one-shot init pattern
// (components/CompendiumLoader.tsx / Starfield.tsx's dynamic import(),
// which is ESM-cached and only initializes once per module load): without
// resetting it here, a fetched graph or in-flight promise from one test
// would bleed into the next.

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    label: overrides.id,
    level: 0,
    kind: "topic",
    visit_count: 0,
    parent_id: null,
    children_ids: [],
    capture_ids: [],
    page_urls: [],
    first_visited_at: null,
    ...overrides,
  };
}

function payloadWith(nodes: GraphNode[]): GraphPayload {
  return { nodes, links: [], clusters: [], super_clusters: [], groups: [] };
}

describe("useGraph", () => {
  beforeEach(() => {
    __resetGraphCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the graph once and exposes it, with loading flipping back to false", async () => {
    const payload = payloadWith([makeNode({ id: "root" })]);
    vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

    const { result } = renderHook(() => useGraph());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.graph).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it("single-flight dedupe: mounting multiple consumers concurrently only calls fetchGraph once", async () => {
    const payload = payloadWith([makeNode({ id: "root" })]);
    const fetchSpy = vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

    const { result: r1 } = renderHook(() => useGraph());
    const { result: r2 } = renderHook(() => useGraph());
    const { result: r3 } = renderHook(() => useGraph());

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(r1.current.loading).toBe(false));
    await waitFor(() => expect(r2.current.loading).toBe(false));
    await waitFor(() => expect(r3.current.loading).toBe(false));

    expect(r1.current.graph).toEqual(payload);
    expect(r2.current.graph).toEqual(payload);
    expect(r3.current.graph).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a fetch failure as `error` rather than throwing out of the hook", async () => {
    vi.spyOn(api, "fetchGraph").mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useGraph());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.graph).toBeNull();
  });

  it("refresh() refetches (post-recluster use case), replacing the cached graph", async () => {
    const first = payloadWith([makeNode({ id: "root" })]);
    const second = payloadWith([makeNode({ id: "root" }), makeNode({ id: "child", parent_id: "root" })]);
    const fetchSpy = vi.spyOn(api, "fetchGraph").mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { result } = renderHook(() => useGraph());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.graph).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.graph).toEqual(second);
  });

  it("nodeById returns the matching node, or undefined for an unknown id", async () => {
    const payload = payloadWith([makeNode({ id: "root" }), makeNode({ id: "child", parent_id: "root" })]);
    vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

    const { result } = renderHook(() => useGraph());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.nodeById("child")?.id).toBe("child");
    expect(result.current.nodeById("nope")).toBeUndefined();
  });

  it("parentOf returns the parent node, or undefined for a root or unknown id", async () => {
    const payload = payloadWith([makeNode({ id: "root" }), makeNode({ id: "child", parent_id: "root" })]);
    vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

    const { result } = renderHook(() => useGraph());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.parentOf("child")?.id).toBe("root");
    expect(result.current.parentOf("root")).toBeUndefined();
    expect(result.current.parentOf("nope")).toBeUndefined();
  });

  describe("breadcrumbFor", () => {
    it("walks parent_id up to the root, root-first ending at the node itself (leaf -> root chain)", async () => {
      const payload = payloadWith([
        makeNode({ id: "root" }),
        makeNode({ id: "mid", parent_id: "root" }),
        makeNode({ id: "leaf", parent_id: "mid" }),
      ]);
      vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

      const { result } = renderHook(() => useGraph());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.breadcrumbFor("leaf").map((n) => n.id)).toEqual(["root", "mid", "leaf"]);
    });

    it("returns a single-element chain for a root-only node", async () => {
      const payload = payloadWith([makeNode({ id: "root" })]);
      vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

      const { result } = renderHook(() => useGraph());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.breadcrumbFor("root").map((n) => n.id)).toEqual(["root"]);
    });

    it("returns an empty array for an unknown node id (documented fallback)", async () => {
      const payload = payloadWith([makeNode({ id: "root" })]);
      vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

      const { result } = renderHook(() => useGraph());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.breadcrumbFor("does-not-exist")).toEqual([]);
    });

    it("guards against a parent_id cycle instead of looping forever", async () => {
      // Pathological/corrupt data: a <-> b reference each other as parent.
      const payload = payloadWith([
        makeNode({ id: "a", parent_id: "b" }),
        makeNode({ id: "b", parent_id: "a" }),
      ]);
      vi.spyOn(api, "fetchGraph").mockResolvedValue(payload);

      const { result } = renderHook(() => useGraph());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const chain = result.current.breadcrumbFor("a").map((n) => n.id);
      // Terminates (this assertion running at all is the real guard-against-
      // infinite-loop proof) and never repeats a node.
      expect(new Set(chain).size).toBe(chain.length);
      expect(chain[chain.length - 1]).toBe("a");
      expect(chain.length).toBeLessThanOrEqual(2);
    });
  });
});
