import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  fetchClusteringStatus,
  fetchDiaryWindows,
  fetchGraph,
  fetchNodeDetail,
  fetchPageContent,
  postRecluster,
} from "./api";

// D1 (batch 04 auth/session parity): apiFetch is a thin fetch wrapper, not a
// second enforcement layer -- the backend's verify_api_key is what actually
// rejects unauthenticated requests. This just closes the UX loop client-side:
// a 401 body means the HttpOnly cookie is gone/expired, so bounce to /login
// instead of leaving the caller to render a blank/broken state.

describe("apiFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards args to fetch and returns its response untouched on 200", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    const res = await apiFetch("/api/foo", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", { method: "POST" });
    expect(res.status).toBe(200);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("calls fetch with exactly the args given (no injected second arg)", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    await apiFetch("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith("/api/foo");
  });

  it("on a 401 in the browser, navigates to /login via window.location.assign", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });

    await apiFetch("/api/foo");

    expect(assignMock).toHaveBeenCalledWith("/login");
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("still returns the 401 response so callers can behave (not swallowed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    const res = await apiFetch("/api/foo");

    expect(res.status).toBe(401);
  });

  it("on a 401 while already on /login, does not navigate (no reload loop)", async () => {
    // Batch-04 fix-round bug: the root layout wraps /login in
    // SessionProvider/ThemeProvider too. ThemeProvider's mount effect
    // calls getPreferences() -> apiFetch; an unauthenticated prod visitor
    // landing on /login got a 401 -> assign("/login") -> full reload ->
    // remount -> 401 again, forever. Still returns the 401 Response so
    // callers' existing swallow-and-fallback contracts (lib/preferences.ts)
    // hold.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/login", assign: assignMock });

    const res = await apiFetch("/api/foo");

    expect(assignMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("on a 401 elsewhere, still navigates to /login exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/graph", assign: assignMock });

    await apiFetch("/api/foo");

    expect(assignMock).toHaveBeenCalledWith("/login");
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("on a 500, does not navigate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });

    await apiFetch("/api/foo");

    expect(assignMock).not.toHaveBeenCalled();
  });

  it("server-side (no window) on a 401 never navigates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });
    vi.stubGlobal("window", undefined);

    const res = await apiFetch("/api/foo");

    expect(assignMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("propagates a rejected fetch instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(apiFetch("/api/foo")).rejects.toThrow("network down");
  });
});

// Task 4 (batch 02): typed fetchers built on apiFetch, consumed by the
// graph/diary/clustering panels landing in tasks 5-7. Shapes verified
// against the real backend at HEAD -- see lib/types.ts for the field
// lists and the reasoning behind each. All requests go through apiFetch so
// they inherit its 401-redirect interceptor for free; that behavior is
// exercised once above (describe("apiFetch")) and not re-tested per
// fetcher here.

describe("fetchGraph", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/graph (through the proxy) and returns the parsed payload", async () => {
    const payload = {
      nodes: [],
      links: [],
      clusters: [],
      super_clusters: [],
      groups: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGraph();

    expect(fetchMock).toHaveBeenCalledWith("/api/graph");
    expect(result).toEqual(payload);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchGraph()).rejects.toThrow("fetchGraph failed: 500 Internal Server Error");
  });
});

describe("fetchDiaryWindows", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/diary/windows with the granularity query param", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDiaryWindows("day");

    expect(fetchMock).toHaveBeenCalledWith("/api/diary/windows?granularity=day");
  });

  it("omits filter_node_id entirely when not given", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDiaryWindows("week");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).not.toContain("filter_node_id");
  });

  it("includes filter_node_id when given", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDiaryWindows("month", "42");

    expect(fetchMock).toHaveBeenCalledWith("/api/diary/windows?granularity=month&filter_node_id=42");
  });

  it("returns the parsed array of windows", async () => {
    const windows = [
      {
        key: "2026-07-25",
        label: "Fri Jul 25",
        node_ids: ["101"],
        graph_node_ids: ["some-page-title"],
        cluster_freq: { "3": 2 },
        cluster_names: { "3": "Rust internals" },
        page_count: 2,
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(windows), { status: 200 })));

    await expect(fetchDiaryWindows("day")).resolves.toEqual(windows);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 422, statusText: "Unprocessable Entity" })));

    await expect(fetchDiaryWindows("day")).rejects.toThrow(
      "fetchDiaryWindows failed: 422 Unprocessable Entity"
    );
  });
});

describe("fetchNodeDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/graph/nodes/{id} (URI-encoded) and returns the parsed detail", async () => {
    const detail = {
      node: {
        id: "some node/id",
        label: "Some Node",
        level: 1,
        kind: "topic",
        visit_count: 3,
        parent_id: null,
        children_ids: [],
        capture_ids: [],
        page_urls: [],
        first_visited_at: null,
      },
      subtree: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNodeDetail("some node/id");

    expect(fetchMock).toHaveBeenCalledWith("/api/graph/nodes/some%20node%2Fid");
    expect(result).toEqual(detail);
  });

  it("returns null on a 404 (unknown node id) rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchNodeDetail("missing")).resolves.toBeNull();
  });

  it("throws a descriptive error on other non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchNodeDetail("some-id")).rejects.toThrow(
      "fetchNodeDetail failed: 500 Internal Server Error"
    );
  });
});

describe("fetchPageContent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/pages/content with the url query param (encoded) and returns parsed content", async () => {
    const content = {
      pid: 7,
      url: "https://example.com/a?b=c",
      domain: "example.com",
      extracted_text: "hello world",
      content_summary: "a summary",
      tool_selected: "readability",
      has_usable_html: true,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(content), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPageContent("https://example.com/a?b=c");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages/content?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc"
    );
    expect(result).toEqual(content);
  });

  it("returns null on a 404 (no content for that url) rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchPageContent("https://example.com/missing")).resolves.toBeNull();
  });

  it("throws a descriptive error on other non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchPageContent("https://example.com/x")).rejects.toThrow(
      "fetchPageContent failed: 500 Internal Server Error"
    );
  });
});

describe("fetchClusteringStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/clustering/status and returns the parsed status", async () => {
    const status = {
      run_number: 12,
      title: "CLUSTERING (RUN #12)",
      stats_line1: "42 clusters · 5 topics",
      stats_line2: "8% noise",
      freshness_label: "3h ago",
      freshness_color: "#facc15",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClusteringStatus();

    expect(fetchMock).toHaveBeenCalledWith("/api/clustering/status");
    expect(result).toEqual(status);
  });

  it("returns the no-run/no-cache presentation strings verbatim", async () => {
    const status = {
      run_number: null,
      title: "CLUSTERING (NO RUNS YET)",
      stats_line1: "no recluster yet",
      stats_line2: "",
      freshness_label: "No cache",
      freshness_color: "",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));

    await expect(fetchClusteringStatus()).resolves.toEqual(status);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchClusteringStatus()).rejects.toThrow(
      "fetchClusteringStatus failed: 500 Internal Server Error"
    );
  });
});

describe("postRecluster", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs /api/recluster with no body and returns the parsed result", async () => {
    const result = {
      cluster_count: 10,
      noise_count: 3,
      naming_cost: 0.02,
      elapsed_seconds: 5.4,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const parsed = await postRecluster();

    expect(fetchMock).toHaveBeenCalledWith("/api/recluster", { method: "POST" });
    expect(parsed).toEqual(result);
  });

  it("passes through extra keys the backend adds beyond the four common ones", async () => {
    const result = {
      cluster_count: 0,
      noise_count: 0,
      naming_cost: 0,
      elapsed_seconds: 0,
      skipped: "already_running",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })));

    await expect(postRecluster()).resolves.toEqual(result);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(postRecluster()).rejects.toThrow("postRecluster failed: 500 Internal Server Error");
  });
});
