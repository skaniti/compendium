import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMemberExclusion,
  addTopic,
  apiFetch,
  fetchClusteringStatus,
  fetchDiaryWindows,
  fetchGraph,
  fetchMemberExclusions,
  fetchNodeDetail,
  fetchPageContent,
  fetchTopicMembers,
  fetchTopics,
  postRecluster,
  removeMemberExclusion,
  removeTopic,
  renameTopic,
  setTopicIcon,
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

// Task 8-C1 (header-widget-cards batch foundations): topic-interest
// fetchers, mirroring the graph/diary/clustering fetchers' idioms above
// (throw-on-non-ok, apiFetch passthrough). Shapes verified against
// compendium-explorer/backend/api/main.py's Topics section at HEAD -- see
// lib/types.ts for the field lists. Two endpoints here (members, rename)
// landed in the explorer repo concurrently with this task; their shapes
// were dictated to the backend implementer verbatim.

describe("fetchTopics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/topics and unwraps .topics", async () => {
    const topics = [{ keyword: "rust", icon_id: "gear", cluster_count: 3 }];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topics }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTopics();

    expect(fetchMock).toHaveBeenCalledWith("/api/topics");
    expect(result).toEqual(topics);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchTopics()).rejects.toThrow("fetchTopics failed: 500 Internal Server Error");
  });
});

describe("fetchTopicMembers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/topics/{keyword}/members (encoded) with no query when limit omitted", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ members: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTopicMembers("rust lang");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust%20lang/members");
  });

  it("includes ?limit= when given", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ members: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTopicMembers("rust", 5);

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust/members?limit=5");
  });

  it("unwraps .members", async () => {
    const members = [
      { cluster_name: "Rust internals", page_count: 4, mean_membership_probability: 0.82 },
      { cluster_name: "Cargo tooling", page_count: 2, mean_membership_probability: null },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ members }), { status: 200 }))
    );

    await expect(fetchTopicMembers("rust")).resolves.toEqual(members);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchTopicMembers("rust")).rejects.toThrow(
      "fetchTopicMembers failed: 500 Internal Server Error"
    );
  });
});

describe("fetchMemberExclusions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/topics/exclusions and unwraps .exclusions", async () => {
    const exclusions = [
      { keyword: "rust", cluster_slug: "cargo-tooling", cluster_name: "Cargo tooling", created_at: "2026-07-01T00:00:00" },
    ];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ exclusions }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMemberExclusions();

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/exclusions");
    expect(result).toEqual(exclusions);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(fetchMemberExclusions()).rejects.toThrow(
      "fetchMemberExclusions failed: 500 Internal Server Error"
    );
  });
});

describe("addTopic", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs /api/topics with a JSON {keyword} body and unwraps .topics", async () => {
    const topics = [{ keyword: "rust", icon_id: null, cluster_count: 0 }];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topic: topics[0], topics }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await addTopic("rust");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "rust" }),
    });
    expect(result).toEqual(topics);
  });

  it("throws on a 403 (demo-gated mutation) rather than special-casing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403, statusText: "Forbidden" })));

    await expect(addTopic("rust")).rejects.toThrow("addTopic failed: 403 Forbidden");
  });
});

describe("removeTopic", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs /api/topics/{keyword} (encoded) and unwraps .topics", async () => {
    const topics: unknown[] = [];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topics }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await removeTopic("rust lang");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust%20lang", { method: "DELETE" });
    expect(result).toEqual(topics);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 404, statusText: "Not Found" })));

    await expect(removeTopic("missing")).rejects.toThrow("removeTopic failed: 404 Not Found");
  });
});

describe("renameTopic", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes /api/topics/{keyword} with a JSON {keyword: newKeyword} body and unwraps .topics", async () => {
    const topics = [{ keyword: "rust-lang", icon_id: null, cluster_count: 0 }];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topics }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await renameTopic("rust", "rust-lang");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "rust-lang" }),
    });
    expect(result).toEqual(topics);
  });

  it("encodes the path keyword but not the JSON body", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topics: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await renameTopic("rust lang", "rust lang 2");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust%20lang", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "rust lang 2" }),
    });
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 400, statusText: "Bad Request" })));

    await expect(renameTopic("rust", "")).rejects.toThrow("renameTopic failed: 400 Bad Request");
  });
});

describe("setTopicIcon", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs /api/topics/{keyword}/icon with a JSON {icon_id} body and unwraps .topics", async () => {
    const topics = [{ keyword: "rust", icon_id: "gear", cluster_count: 0 }];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ topics }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setTopicIcon("rust", "gear");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/rust/icon", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon_id: "gear" }),
    });
    expect(result).toEqual(topics);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 404, statusText: "Not Found" })));

    await expect(setTopicIcon("missing", "gear")).rejects.toThrow(
      "setTopicIcon failed: 404 Not Found"
    );
  });
});

describe("addMemberExclusion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs /api/topics/exclusions with a JSON body and unwraps .exclusions", async () => {
    const exclusions = [
      { keyword: "rust", cluster_slug: "cargo-tooling", cluster_name: "Cargo tooling", created_at: "2026-07-01T00:00:00" },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ exclusions, unlabeled: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await addMemberExclusion("rust", "Cargo tooling");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/exclusions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "rust", cluster_name: "Cargo tooling" }),
    });
    expect(result).toEqual(exclusions);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 403, statusText: "Forbidden" })));

    await expect(addMemberExclusion("rust", "Cargo tooling")).rejects.toThrow(
      "addMemberExclusion failed: 403 Forbidden"
    );
  });
});

describe("removeMemberExclusion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs /api/topics/exclusions with a JSON body and unwraps .exclusions", async () => {
    const exclusions: unknown[] = [];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ exclusions }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await removeMemberExclusion("rust", "Cargo tooling");

    expect(fetchMock).toHaveBeenCalledWith("/api/topics/exclusions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "rust", cluster_name: "Cargo tooling" }),
    });
    expect(result).toEqual(exclusions);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })));

    await expect(removeMemberExclusion("rust", "Cargo tooling")).rejects.toThrow(
      "removeMemberExclusion failed: 500 Internal Server Error"
    );
  });
});
