"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useNav } from "./NavProvider";
import { useGraph } from "@/hooks/useGraph";
import { fetchDiaryWindows, fetchPageContent } from "@/lib/api";
import type { NavAction, NavState } from "@/lib/nav";
import type { DiaryWindow, GraphCluster, GraphNode, Granularity, PageContent } from "@/lib/types";

// Ports layouts/topic_detail.py's render_topic_detail + its three branch
// renderers into JSX. Dispatch order mirrors render_topic_detail:55-125
// exactly (see TopicDetail's own body below):
//   1. no selection, filter active -> WindowSummaryView
//   2. no selection, no filter -> the "click a node" placeholder (already
//      hardcoded in TopicDetailPanel.tsx; moved here as this branch)
//   3. selectedNodeId resolves to a graph node -> PageView
//   4. not a node, but some graph node's parent_id === selectedNodeId
//      -> ClusterView
//   5. else -> "Node not found."
//
// PageView is the v2 layout (no breadcrumb -- a cluster pill replaces it;
// see topic_detail.py:130-135's own comment on why). ClusterView and
// WindowSummaryView keep the v1-style breadcrumb/chip/pill chrome.

type NodeLookup = (id: string) => GraphNode | undefined;

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Mirrors assets/local_time.js's "date" case ("Feb 24, 2026") -- Dash needed
// a client-side rewrite script because it renders server-side in UTC; this
// component is a client island (`useState`/`useEffect` below), so `Date`'s
// local getters already give browser-local components directly, no
// epoch-then-rewrite two-step needed.
function formatLocalDate(d: Date): string {
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Mirrors _word_count (topic_detail.py:228-230): whitespace-split, empty
// string -> 0.
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Python's f"{n:,}" thousands-separator formatting -- en-US grouping is the
// same comma-every-3-digits shape, pinned explicitly so this doesn't drift
// with a test runner's default locale.
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Mirrors _cluster_display_name (topic_detail.py:15-27): DB-authored name
// first, falling back to a lossy title-cased slug transform ONLY when the
// slug has no matching row. Python's str.title() capitalizes after any
// non-letter; this simpler "first letter of each space-separated word"
// version is close enough for the last-resort fallback path (real names
// come from `clusterNames` almost all the time).
function titleCaseWords(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function clusterDisplayName(id: string, clusterNames: Record<string, string>): string {
  return clusterNames[id] || titleCaseWords(id.replace(/_/g, " "));
}

function buildClusterNameMap(clusters: GraphCluster[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of clusters ?? []) map[c.id] = c.name;
  return map;
}

// Mirrors _time_window_label's "all"/no-window branch (topic_detail.py:37-57)
// -- batch 02 has no date-range picker (Task 8), so the active window is
// always "all". Dash's version reads DB MIN(visited_at) directly; graph.nodes
// IS the client-side equivalent set of active pages (graph_builder.py builds
// exactly one node per active page), so the min across ALL of them is the
// same "since earliest active page" value regardless of which node is
// selected -- this caption is a GLOBAL label, not per-node.
function timeWindowLabel(nodes: GraphNode[]): string {
  let minMs = Infinity;
  for (const n of nodes) {
    if (!n.first_visited_at) continue;
    const t = new Date(n.first_visited_at).getTime();
    if (!Number.isNaN(t) && t < minMs) minMs = t;
  }
  if (!Number.isFinite(minMs)) return "all time";
  return `since ${formatLocalDate(new Date(minMs))}`;
}

const MAX_BREADCRUMB_HOPS = 8;

export interface BreadcrumbCrumb {
  id: string | null;
  label: string;
}

// Mirrors _build_breadcrumbs' walk (topic_detail.py:647-709), built in the
// component per the brief rather than reusing hooks/useGraph.ts's
// breadcrumbFor (that helper returns [] for a cluster slug -- the wrong
// shape here, since ClusterView's own selectedNodeId typically IS a cluster
// slug with no graph-node entry).
//
// Exported for direct unit testing of the "start at a real page node, hop up
// to a cluster-slug parent" arm of the walk (chain.push + continue via
// node.parent_id below): through TopicDetail's own dispatch, ClusterView only
// ever renders once selectedNodeId has ALREADY failed nodeById (branch 4
// requires "not a node"), so live navigation only ever exercises the
// single-hop "starts as a cluster slug" case. Dash's own _build_breadcrumbs
// keeps the real-node starting branch too, for the same reason (its comment:
// "Continue up if SC view ever lands") -- this mirrors that generality even
// though it's presently reached only via this direct test, not via the
// component's live render path.
export function buildBreadcrumbTrail(
  startId: string,
  nodeById: NodeLookup,
  clusterNames: Record<string, string>
): BreadcrumbCrumb[] {
  const chain: BreadcrumbCrumb[] = [];
  let currentId: string | null = startId;
  let hops = 0;
  while (currentId && hops < MAX_BREADCRUMB_HOPS) {
    const node = nodeById(currentId);
    if (node) {
      chain.push({ id: currentId, label: node.label });
      currentId = node.parent_id;
    } else {
      // Unknown id -> cluster slug (no graph node entry): resolve via the
      // DB-authored name and stop -- clusters are top-level under Home.
      chain.push({ id: currentId, label: clusterDisplayName(currentId, clusterNames) });
      currentId = null;
    }
    hops += 1;
  }
  chain.push({ id: null, label: "Home" });
  chain.reverse();
  return chain;
}

export default function TopicDetail() {
  const { state, dispatch } = useNav();
  const { graph, nodeById } = useGraph();
  const { selectedNodeId, filterWindowKey } = state;

  // Branch 1/2 (render_topic_detail:96-105): nothing selected.
  if (selectedNodeId == null) {
    if (filterWindowKey != null) {
      return (
        <WindowSummaryView filterWindowKey={filterWindowKey} nodeById={nodeById} dispatch={dispatch} />
      );
    }
    return (
      <div className="panel-scroll">
        <p className="placeholder-text">Click a node in the graph to see details.</p>
      </div>
    );
  }

  const clusterNames = buildClusterNameMap(graph?.clusters);

  // Branch 3 (render_topic_detail:110 onward): a real graph node.
  const node = nodeById(selectedNodeId);
  if (node) {
    return (
      // key={node.id} forces a fresh PageView instance per node: without
      // it, clicking from node A (content already loaded) to node B would
      // render B's title/caption for one frame with A's stale content card
      // still mounted, until the content-fetch effect's own reset catches
      // up. Remounting sidesteps that cross-node flash entirely rather
      // than relying on effect timing.
      <PageView
        key={node.id}
        node={node}
        allNodes={graph?.nodes ?? []}
        clusterNames={clusterNames}
        dispatch={dispatch}
      />
    );
  }

  // Branch 4 (render_topic_detail:112-121): not a node, but some node's
  // parent_id names it -- a cluster (or per-page faux-cluster) slug.
  const members = (graph?.nodes ?? []).filter((n) => n.parent_id === selectedNodeId);
  if (members.length > 0) {
    return (
      <ClusterView
        clusterId={selectedNodeId}
        members={members}
        clusterNames={clusterNames}
        nodeById={nodeById}
        state={state}
        dispatch={dispatch}
      />
    );
  }

  // Branch 5 (render_topic_detail:122-125): neither.
  return (
    <div className="panel-scroll">
      <p className="placeholder-text">Node not found.</p>
    </div>
  );
}

// ── PageView (topic_detail.py:127-225, v2 layout: cluster pill, no
//    breadcrumb) ──────────────────────────────────────────────────────────

interface PageViewProps {
  node: GraphNode;
  allNodes: GraphNode[];
  clusterNames: Record<string, string>;
  dispatch: (action: NavAction) => void;
}

function PageView({ node, allNodes, clusterNames, dispatch }: PageViewProps) {
  // `null` covers both "still loading" and "resolved, nothing usable" --
  // PageView has no loading-flicker concern to guard against (unlike
  // DiaryPanel's stale-while-revalidate list), since omitting the card
  // entirely is *also* the correct final state when every url 404s; there's
  // no visible difference between the two to protect against.
  const [pageContent, setPageContent] = useState<PageContent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPageContent(null);

    async function run() {
      // Dash's loop (topic_detail.py:249-275): try each page_url in order,
      // first non-null content row wins.
      for (const url of node.page_urls) {
        const result = await fetchPageContent(url);
        if (cancelled) return;
        if (result) {
          setPageContent(result);
          return;
        }
      }
    }

    if (node.page_urls.length > 0) {
      void run();
    }

    return () => {
      cancelled = true;
    };
  }, [node]);

  // (1) Cluster pill (real cluster) / "Unclustered" span (parent_id ===
  // "_unclustered") / nothing at all (null, "root", or "_solo_"-prefixed).
  // See topic_detail.py:137-174.
  let clusterBadge: ReactNode = null;
  if (
    node.parent_id &&
    node.parent_id !== "root" &&
    node.parent_id !== "_unclustered" &&
    !node.parent_id.startsWith("_solo_")
  ) {
    const parentId = node.parent_id;
    clusterBadge = (
      <button
        type="button"
        className="nav-btn"
        style={{
          fontSize: "0.7rem",
          padding: "2px 8px",
          marginBottom: "4px",
          background: "var(--tag-bg)",
          color: "var(--tag-text)",
          border: "none",
          borderRadius: "10px",
          cursor: "pointer",
        }}
        onClick={() => dispatch({ type: "SELECT_CLUSTER", id: parentId })}
      >
        {clusterDisplayName(parentId, clusterNames)}
      </button>
    );
  } else if (node.parent_id === "_unclustered") {
    clusterBadge = (
      <span
        style={{
          fontSize: "0.7rem",
          padding: "2px 8px",
          marginBottom: "4px",
          background: "var(--surface)",
          color: "var(--text-muted)",
          borderRadius: "10px",
          display: "inline-block",
        }}
      >
        Unclustered
      </span>
    );
  }

  // (2) Title: link when a page_url exists, else a plain header div.
  const firstUrl = node.page_urls[0];
  const titleEl = firstUrl ? (
    <a
      href={firstUrl}
      target="_blank"
      rel="noreferrer"
      className="detail-header"
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      {node.label}
    </a>
  ) : (
    <div className="detail-header">{node.label}</div>
  );

  // (3) Visit caption -- singular/plural visit count + the GLOBAL "since
  // earliest active page" (or "all time") label (Task 8 makes this dynamic
  // per date-range picker).
  const visitWord = node.visit_count === 1 ? "visit" : "visits";
  const caption = `${node.visit_count} ${visitWord} ${timeWindowLabel(allNodes)}`;

  return (
    <div className="panel-scroll" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {clusterBadge}
      {titleEl}
      <p className="detail-caption" style={{ margin: "0 0 6px 0" }}>
        {caption}
      </p>
      {pageContent && <PageContentCard content={pageContent} />}
    </div>
  );
}

function PageContentCard({ content }: { content: PageContent }) {
  return content.has_usable_html ? <ArchivedIframeCard content={content} /> : <PlaintextCard content={content} />;
}

// Mirrors _render_archived_iframe (topic_detail.py:402-486).
function ArchivedIframeCard({ content }: { content: PageContent }) {
  const metaLine = ["archived copy", content.domain].filter(Boolean).join(" · ");
  return (
    <div
      style={{
        background: "var(--surface, #fff)",
        color: "var(--text)",
        borderRadius: "8px",
        border: "1px solid var(--border, #e0e0e0)",
        marginTop: "8px",
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: "0",
        width: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px 4px 12px", flexShrink: "0" }}>
        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", margin: "0 0 4px 0" }}>
          <span title={content.tool_selected ? `captured via ${content.tool_selected}` : ""}>{metaLine}</span>
          {content.url && (
            <a
              href={content.url}
              target="_blank"
              rel="noreferrer"
              style={{ float: "right", color: "var(--highlight, #b39bf3)", textDecoration: "none" }}
            >
              open original ↗
            </a>
          )}
        </p>
      </div>
      <iframe
        src={`/api/pages/${content.pid}/preview`}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        style={{
          width: "100%",
          flex: "1 1 auto",
          minHeight: "0",
          border: "none",
          background: "#fff",
          display: "block",
        }}
      />
    </div>
  );
}

// Mirrors the plaintext branch of _fetch_and_render_page_content
// (topic_detail.py:287-399).
function PlaintextCard({ content }: { content: PageContent }) {
  const metaParts = [content.domain, content.tool_selected ? `via ${content.tool_selected}` : null].filter(
    Boolean
  ) as string[];

  return (
    <div
      style={{
        background: "var(--surface, #fff)",
        color: "var(--text)",
        borderRadius: "8px",
        border: "1px solid var(--border, #e0e0e0)",
        marginTop: "8px",
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 240px)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px 4px 12px", flexShrink: "0" }}>
        {metaParts.length > 0 && (
          <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", margin: "0 0 4px 0" }}>
            {metaParts.join(" · ")}
          </p>
        )}
      </div>
      <div style={{ padding: "0 12px 10px 12px", overflowY: "auto", flex: "1", minHeight: "0" }}>
        {content.content_summary && (
          <details>
            <summary style={{ fontSize: "0.7rem", cursor: "pointer" }}>
              {`Summary (${formatCount(wordCount(content.content_summary))} words)`}
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.68rem", margin: "4px 0" }}>
              {content.content_summary}
            </pre>
          </details>
        )}
        {content.extracted_text ? (
          <details open>
            <summary style={{ fontSize: "0.7rem", cursor: "pointer" }}>
              {`Full text (${formatCount(wordCount(content.extracted_text))} words)`}
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.68rem", margin: "4px 0" }}>
              {content.extracted_text}
            </pre>
          </details>
        ) : (
          !content.content_summary && (
            <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontStyle: "italic" }}>
              No extracted content available.
            </p>
          )
        )}
      </div>
    </div>
  );
}

// ── ClusterView (topic_detail.py:577-645) ─────────────────────────────────

interface ClusterViewProps {
  clusterId: string;
  members: GraphNode[];
  clusterNames: Record<string, string>;
  nodeById: NodeLookup;
  state: NavState;
  dispatch: (action: NavAction) => void;
}

function ClusterView({ clusterId, members, clusterNames, nodeById, state, dispatch }: ClusterViewProps) {
  // Defensive (topic_detail.py:587-595): a "_solo_"-prefixed id is a
  // per-page faux-cluster, not a real navigable cluster -- shouldn't reach
  // here via the normal UI (PageView's own pill logic never dispatches
  // SELECT_CLUSTER with one), but mirrored for parity.
  if (clusterId.startsWith("_solo_")) {
    return (
      <div className="panel-scroll">
        <p className="placeholder-text">No cluster detail available for this page.</p>
      </div>
    );
  }

  const clusterName = clusterDisplayName(clusterId, clusterNames);
  const { filterWindowKey, selectedNodeId } = state;
  // Dash: "show whenever we're not at the empty-home state" -- structurally
  // always true here (selectedNodeId === clusterId, which is truthy by
  // construction: TopicDetail only renders ClusterView once selectedNodeId
  // already matched some node's parent_id). Kept as the same general
  // condition as topic_detail.py:604-607 rather than hardcoding `true`, for
  // parity and in case a future dispatch path loosens the gate.
  const showHome = Boolean(selectedNodeId || filterWindowKey);
  const trail = selectedNodeId ? buildBreadcrumbTrail(selectedNodeId, nodeById, clusterNames) : [];
  const pageWord = members.length === 1 ? "page" : "pages";
  const sortedMembers = [...members].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return (
    <div className="panel-scroll">
      {filterWindowKey && (
        <div className="filter-chip">
          <span className="filter-chip-label">{`Filter: ${filterWindowKey}`}</span>
          <button
            type="button"
            className="filter-chip-clear"
            title="Clear filter"
            onClick={() => dispatch({ type: "CLEAR_FILTER" })}
          >
            ×
          </button>
        </div>
      )}
      {showHome && (
        <button type="button" className="nav-btn" onClick={() => dispatch({ type: "HOME" })}>
          Home
        </button>
      )}
      {trail.length > 1 && (
        <div className="breadcrumb">
          {trail.map((crumb, i) => {
            const isLast = i === trail.length - 1;
            return (
              <span key={crumb.id ?? "home"}>
                {isLast ? (
                  <span className="breadcrumb-current">{crumb.label}</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="breadcrumb-link"
                      onClick={() => dispatch({ type: "BREADCRUMB_JUMP", id: crumb.id ?? "" })}
                    >
                      {crumb.label}
                    </button>
                    <span className="breadcrumb-sep"> › </span>
                  </>
                )}
              </span>
            );
          })}
        </div>
      )}
      <div className="detail-header">{clusterName}</div>
      <p className="detail-caption">{`Topic cluster · ${members.length} ${pageWord}`}</p>
      <p className="section-label">Pages in this cluster:</p>
      {sortedMembers.map((page) => (
        <button
          key={page.id}
          type="button"
          className="child-item"
          onClick={() => dispatch({ type: "SELECT_NODE", id: page.id })}
        >
          {`${page.label}  (${page.visit_count} visits)`}
        </button>
      ))}
    </div>
  );
}

// ── WindowSummaryView (topic_detail.py:489-574) ───────────────────────────

// Mirrors _render_window_summary's granularity-detection (topic_detail.py:
// 494-499) exactly: contains "-W" -> week; length 7 (YYYY-MM) -> month;
// else day.
function deriveGranularity(key: string): Granularity {
  if (key.includes("-W")) return "week";
  if (key.length === 7) return "month";
  return "day";
}

interface WindowSummaryViewProps {
  filterWindowKey: string;
  nodeById: NodeLookup;
  dispatch: (action: NavAction) => void;
}

function WindowSummaryView({ filterWindowKey, nodeById, dispatch }: WindowSummaryViewProps) {
  const granularity = deriveGranularity(filterWindowKey);
  // undefined = fetch in flight; null = resolved, no match (or the fetch
  // failed) -- distinguished only to avoid a "not found" flash while the
  // request is outstanding, same rationale as DiaryPanel's null-vs-loading
  // split. No caching layer here (brief note): a fresh fetch on every
  // filterWindowKey/granularity change is cheap and simple; there's no
  // shared cache to join like useGraph's.
  const [win, setWin] = useState<DiaryWindow | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setWin(undefined);
    fetchDiaryWindows(granularity, undefined)
      .then((windows) => {
        if (cancelled) return;
        setWin(windows.find((w) => w.key === filterWindowKey) ?? null);
      })
      .catch(() => {
        if (!cancelled) setWin(null);
      });
    return () => {
      cancelled = true;
    };
  }, [filterWindowKey, granularity]);

  if (win === undefined) {
    return null;
  }

  if (win === null) {
    return (
      <div className="panel-scroll">
        <p className="placeholder-text">No pages in this window.</p>
      </div>
    );
  }

  // Home button: filterWindowKey is truthy by construction whenever this
  // view renders (TopicDetail only reaches it when selectedNodeId is null
  // AND filterWindowKey is set) -- always true in practice; kept as the
  // same general condition Dash uses (topic_detail.py:513-515) rather than
  // hardcoding `true`.
  const showHome = Boolean(filterWindowKey);
  const sortedClusterIds = Object.keys(win.cluster_freq).sort(
    (a, b) => win.cluster_freq[b] - win.cluster_freq[a]
  );
  // Dash's page list defensively dedupes via a `seen` set while iterating
  // raw records (topic_detail.py:560-563); our graph_node_ids is documented
  // as already-distinct, but the render-time dedupe is mirrored anyway for
  // parity rather than trusting the API contract silently.
  const dedupedIds = Array.from(new Set(win.graph_node_ids));

  return (
    <div className="panel-scroll">
      {showHome && (
        <button type="button" className="nav-btn" onClick={() => dispatch({ type: "HOME" })}>
          Home
        </button>
      )}
      <div className="detail-header">{win.label}</div>
      <p className="detail-caption">{`${win.graph_node_ids.length} pages across ${
        Object.keys(win.cluster_freq).length
      } topics`}</p>
      <p className="section-label">Topics:</p>
      <div className="tag-container">
        {sortedClusterIds.map((cid) => (
          <button
            key={cid}
            type="button"
            className="tag-pill"
            onClick={() => dispatch({ type: "SELECT_CLUSTER", id: cid })}
          >
            {`${win.cluster_names[cid] ?? cid} (${win.cluster_freq[cid]})`}
          </button>
        ))}
      </div>
      <p className="section-label">Pages:</p>
      {dedupedIds.map((id) => (
        <button
          key={id}
          type="button"
          className="nav-btn page-link"
          onClick={() => dispatch({ type: "SELECT_NODE", id })}
        >
          {nodeById(id)?.label ?? id}
        </button>
      ))}
    </div>
  );
}
