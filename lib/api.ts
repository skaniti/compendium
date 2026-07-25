import type {
  ClusteringStatus,
  DiaryWindow,
  GraphPayload,
  NodeDetail,
  PageContent,
  ReclusterResult,
} from "./types";

// Thin fetch wrapper: closes the client-side UX loop when the HttpOnly
// access_token cookie is gone/expired. D1 (batch 04 auth/session parity) --
// this is UX only, not a second enforcement layer; the backend's
// verify_api_key is what actually rejects unauthenticated requests. A 401
// here just means "bounce to /login" instead of leaving callers to render a
// blank/broken state against data that will never arrive.
//
// Kept args as a passthrough tuple (not a fixed (input, init) signature) so
// call sites that omit `init` still hit `fetch` with exactly the arguments
// they gave -- callers/tests that assert `fetch` was called with a single
// argument (e.g. lib/preferences.ts's GET) keep working unchanged.
export async function apiFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await fetch(...args);
  if (res.status === 401) {
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

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await apiFetch("/api/graph");
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

export async function postRecluster(): Promise<ReclusterResult> {
  const res = await apiFetch("/api/recluster", { method: "POST" });
  if (!res.ok) throw new Error(`postRecluster failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as ReclusterResult;
}
