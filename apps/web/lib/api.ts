import type {
  ClusteringStatus,
  DiaryWindow,
  GraphPayload,
  MemberExclusion,
  NodeDetail,
  PageContent,
  PageSortColumn,
  PipelinePagesResponse,
  PipelineSummary,
  PipelineTimeline,
  RangeKey,
  ReclusterResult,
  SortDir,
  TimeWindow,
  TopicInterest,
  TopicMember,
} from "./types";
import { sessionMayResume } from "./session-policy-client";

// D3 (session-expiry-tuning): module-level single-flight refresh, shared by
// every concurrent 401 handler below (and app/login/LoginPageClient.tsx's
// mount-time resume attempt). Without this, three panels 401ing on the same
// stale page load would each rotate the refresh token, and the backend's
// reuse-detection would treat the 2nd/3rd rotation as a stolen-token replay
// and revoke every token for the user -- exactly the failure mode spec D3
// calls out. Deliberately plain `fetch`, NOT apiFetch: apiFetch calling
// recoverSession on ITS OWN 401 would recurse.
let inFlightRecovery: Promise<boolean> | null = null;

export function recoverSession(): Promise<boolean> {
  if (inFlightRecovery) return inFlightRecovery;
  // Item 6 (session-expiry-tuning review fixes): the `finally` that clears
  // inFlightRecovery lives on the OUTER promise (chained after the async
  // IIFE settles), not inside the IIFE's own try/finally -- a synchronous
  // throw from anything added to this function in the future (before or
  // outside the inner try) would otherwise leave inFlightRecovery pointing
  // at an already-settled (rejected) promise forever, wedging every future
  // caller onto a dead cached promise instead of retrying.
  inFlightRecovery = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    inFlightRecovery = null;
  });
  return inFlightRecovery;
}

// A request whose body is an already-partially-consumed (or one-shot)
// ReadableStream can't be safely re-issued a second time -- retrying it
// would either throw ("body stream already read") or send an empty body.
// Every other body shape (string, FormData, URLSearchParams, undefined,
// ...) round-trips fine through a second `fetch(...args)` call.
function hasStreamBody(init: RequestInit | undefined): boolean {
  return typeof ReadableStream !== "undefined" && init?.body instanceof ReadableStream;
}

// Thin fetch wrapper: closes the client-side UX loop when the HttpOnly
// access_token cookie is gone/expired. D1 (batch 04 auth/session parity) --
// this is UX only, not a second enforcement layer; the backend's
// verify_api_key is what actually rejects unauthenticated requests. A 401
// here just means "bounce to /login" instead of leaving callers to render a
// blank/broken state against data that will never arrive.
//
// D3 (session-expiry-tuning): before bouncing, a 401 gets ONE silent
// recovery attempt when the session_policy cookie says it's worth trying
// (sessionMayResume -- policy.resume and still within its idle window) and
// the request is safely retryable. This is what lets a page load with an
// already-expired access token hydrate normally instead of always bouncing
// to /login -- the common case once idle tracking survives reloads (D2).
//
// Kept args as a passthrough tuple (not a fixed (input, init) signature) so
// call sites that omit `init` still hit `fetch` with exactly the arguments
// they gave -- callers/tests that assert `fetch` was called with a single
// argument (e.g. lib/preferences.ts's GET) keep working unchanged.
export async function apiFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await fetch(...args);
  if (res.status === 401) {
    const init = args[1];
    if (!hasStreamBody(init) && sessionMayResume(Date.now())) {
      const recovered = await recoverSession();
      if (recovered) {
        const retryRes = await fetch(...args);
        if (retryRes.status === 401) {
          redirectToLogin();
        }
        return retryRes;
      }
    }
    redirectToLogin();
  }
  return res;
}

// Shared choke point for "bounce to /login", exported so other 401-aware
// call sites (lib/agent-stream.ts's streamAgentQuery, which talks to
// fetch directly rather than through apiFetch so it can read the raw
// stream body) can reuse the exact same guard instead of duplicating it.
//
// Batch-04 fix-round bug: the root layout wraps EVERY route (including
// /login itself, app/layout.tsx) in SessionProvider/ThemeProvider, both of
// which fire an authenticated GET on mount (/api/auth/me,
// /api/auth/preferences via ThemeProvider's getPreferences()).
// SessionProvider already guards its own hydration call against /login
// (see its own comment), but that only prevented ONE of the two mount-time
// calls -- ThemeProvider's getPreferences() -> apiFetch had no such guard.
// An unauthenticated prod visitor landing on /login got: 401 from
// preferences -> assign("/login") -> full reload -> remount -> 401 again,
// an infinite reload loop. Guarding here, at apiFetch's own 401 handling,
// closes the loop for every current AND future caller in one place,
// instead of requiring every mount-effect that might 401 to remember its
// own /login check.
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  // Full reload (not router navigation) is deliberate: an expired/invalid
  // session must invalidate every client-side cache/context, same as the
  // explicit sign-out/login flows (components/Header.tsx, app/login/page.tsx).
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload required after session invalidation
  window.location.assign("/login");
}

// ---------------------------------------------------------------------
// Task 4 (batch 02): typed fetchers for the graph/diary/clustering panels
// (tasks 5-7). All go through apiFetch above so a stale/expired session
// bounces to /login the same way every other authenticated call does.
//
// Error convention (deliberately NOT the swallow-and-fallback style of
// lib/preferences.ts, which treats a failed read as a nice-to-have): these
// endpoints back primary panel content, so a non-2xx response throws a
// descriptive Error and lets the caller decide how to render an error
// state, mirroring lib/agent-stream.ts's streamAgentQuery. The one carve-
// out is 404 on the two endpoints where "not found" is an expected, non-
// exceptional outcome (a node id that no longer exists, a url with no
// captured content yet) -- those return null instead of throwing so
// callers can render an empty state without a try/catch.
// ---------------------------------------------------------------------

// Task A1-3 (Step 3, R2's backend counterpart -- explorer aff2f3f): window
// is optional and defaults to the backend's own "all" (GET /api/graph?window,
// backend/api/main.py) -- omitted (or explicitly "all") for the SAME
// "/api/graph" request shape this made before this param existed (no
// behavior change for every pre-existing caller passing zero args). Only
// 7/30/90/365 add the query string; the backend rebuilds fresh from the DB
// for those (does NOT warm graph_cache, unlike "all" -- see its own
// docstring) and hooks/useGraph.ts's cache is refetch-on-change to match
// (no client-side per-window caching either).
export async function fetchGraph(window?: TimeWindow): Promise<GraphPayload> {
  const path = window && window !== "all" ? `/api/graph?window=${encodeURIComponent(window)}` : "/api/graph";
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`fetchGraph failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as GraphPayload;
}

export async function fetchDiaryWindows(
  granularity: "day" | "week" | "month",
  filterNodeId?: string
): Promise<DiaryWindow[]> {
  const params = new URLSearchParams({ granularity });
  // Omit filter_node_id entirely when not given, rather than sending an
  // empty string -- the backend param is `str | None = None`, and an
  // empty-string value is not the same as "no filter" to callers reading
  // the query string.
  if (filterNodeId !== undefined) params.set("filter_node_id", filterNodeId);
  const res = await apiFetch(`/api/diary/windows?${params.toString()}`);
  if (!res.ok) throw new Error(`fetchDiaryWindows failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as DiaryWindow[];
}

export async function fetchNodeDetail(nodeId: string): Promise<NodeDetail | null> {
  const res = await apiFetch(`/api/graph/nodes/${encodeURIComponent(nodeId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchNodeDetail failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as NodeDetail;
}

export async function fetchPageContent(url: string): Promise<PageContent | null> {
  const params = new URLSearchParams({ url });
  const res = await apiFetch(`/api/pages/content?${params.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchPageContent failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as PageContent;
}

export async function fetchClusteringStatus(): Promise<ClusteringStatus> {
  const res = await apiFetch("/api/clustering/status");
  if (!res.ok) throw new Error(`fetchClusteringStatus failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as ClusteringStatus;
}

const periodQuery = (range: RangeKey, tz: string) => `range=${range}&tz=${encodeURIComponent(tz)}`;
export async function fetchPipelineSummary(range: RangeKey, tz: string): Promise<PipelineSummary> {
  const res = await apiFetch(`/api/pipeline/summary?${periodQuery(range, tz)}`);
  if (!res.ok) throw new Error(`fetchPipelineSummary failed: ${res.status} ${res.statusText}`);
  return res.json();
}
export async function fetchPipelineTimeline(range: RangeKey, tz: string): Promise<PipelineTimeline> {
  const res = await apiFetch(`/api/pipeline/timeline?${periodQuery(range, tz)}`);
  if (!res.ok) throw new Error(`fetchPipelineTimeline failed: ${res.status} ${res.statusText}`);
  return res.json();
}
export async function fetchPipelinePages(limit: number, offset: number, sort: PageSortColumn, dir: SortDir, range: RangeKey, tz: string): Promise<PipelinePagesResponse> {
  const res = await apiFetch(`/api/pipeline/pages?limit=${limit}&offset=${offset}&sort=${sort}&dir=${dir}&${periodQuery(range, tz)}`);
  if (!res.ok) throw new Error(`fetchPipelinePages failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function postRecluster(): Promise<ReclusterResult> {
  const res = await apiFetch("/api/recluster", { method: "POST" });
  if (!res.ok) throw new Error(`postRecluster failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as ReclusterResult;
}

// ---------------------------------------------------------------------
// Task 8-C1 (header-widget-cards batch foundations): typed fetchers for
// the topic-interest / member-exclusion endpoints, consumed by the header
// widget cards landing next batch. Shapes verified against
// compendium-explorer/backend/api/main.py's Topics section at HEAD -- see
// lib/types.ts for field lists and per-endpoint notes.
//
// Same error convention as the graph/diary/clustering fetchers above: a
// non-ok response throws a descriptive Error rather than swallowing it
// (unlike lib/preferences.ts's nice-to-have GET/PATCH). This includes the
// 403 the mutation endpoints return for a direct-demo session -- the UI
// hides those controls for plain demo, so no special-casing belongs here.
// ---------------------------------------------------------------------

export async function fetchTopics(): Promise<TopicInterest[]> {
  const res = await apiFetch("/api/topics");
  if (!res.ok) throw new Error(`fetchTopics failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { topics: TopicInterest[] };
  return body.topics;
}

export async function fetchTopicMembers(
  keyword: string,
  limit?: number
): Promise<TopicMember[]> {
  const path = `/api/topics/${encodeURIComponent(keyword)}/members`;
  const url = limit !== undefined ? `${path}?limit=${limit}` : path;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`fetchTopicMembers failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { members: TopicMember[] };
  return body.members;
}

export async function fetchMemberExclusions(): Promise<MemberExclusion[]> {
  const res = await apiFetch("/api/topics/exclusions");
  if (!res.ok) throw new Error(`fetchMemberExclusions failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { exclusions: MemberExclusion[] };
  return body.exclusions;
}

export async function addTopic(keyword: string): Promise<TopicInterest[]> {
  const res = await apiFetch("/api/topics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword }),
  });
  if (!res.ok) throw new Error(`addTopic failed: ${res.status} ${res.statusText}`);
  // The backend also returns `topic` (the single added entry); only
  // `topics` (the full updated list) is what callers need.
  const body = (await res.json()) as { topic: TopicInterest; topics: TopicInterest[] };
  return body.topics;
}

export async function removeTopic(keyword: string): Promise<TopicInterest[]> {
  const res = await apiFetch(`/api/topics/${encodeURIComponent(keyword)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`removeTopic failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { topics: TopicInterest[] };
  return body.topics;
}

export async function renameTopic(
  keyword: string,
  newKeyword: string
): Promise<TopicInterest[]> {
  const res = await apiFetch(`/api/topics/${encodeURIComponent(keyword)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: newKeyword }),
  });
  if (!res.ok) throw new Error(`renameTopic failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { topics: TopicInterest[] };
  return body.topics;
}

export async function setTopicIcon(
  keyword: string,
  iconId: string
): Promise<TopicInterest[]> {
  const res = await apiFetch(`/api/topics/${encodeURIComponent(keyword)}/icon`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ icon_id: iconId }),
  });
  if (!res.ok) throw new Error(`setTopicIcon failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { topics: TopicInterest[] };
  return body.topics;
}

export async function addMemberExclusion(
  keyword: string,
  clusterName: string
): Promise<MemberExclusion[]> {
  const res = await apiFetch("/api/topics/exclusions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, cluster_name: clusterName }),
  });
  if (!res.ok) throw new Error(`addMemberExclusion failed: ${res.status} ${res.statusText}`);
  // The backend also returns `unlabeled` (count of clusters immediately
  // unlabeled by the exclusion); only `exclusions` is what callers need.
  const body = (await res.json()) as { exclusions: MemberExclusion[]; unlabeled: number };
  return body.exclusions;
}

export async function removeMemberExclusion(
  keyword: string,
  clusterName: string
): Promise<MemberExclusion[]> {
  const res = await apiFetch("/api/topics/exclusions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, cluster_name: clusterName }),
  });
  if (!res.ok) throw new Error(`removeMemberExclusion failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { exclusions: MemberExclusion[] };
  return body.exclusions;
}
