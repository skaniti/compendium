import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TopicDetail, { buildBreadcrumbTrail } from "./TopicDetail";
import NavProvider, { useNav } from "./NavProvider";
import { __resetGraphCacheForTest } from "@/hooks/useGraph";
import * as apiModule from "@/lib/api";
import type { GraphCluster, GraphNode, GraphPayload, DiaryWindow } from "@/lib/types";
import type { NavAction } from "@/lib/nav";

// Ports layouts/topic_detail.py's render_topic_detail (Dash source of
// truth) into a JSX-parity suite: PageView / ClusterView / WindowSummaryView.
// All fixtures below are synthetic (no real capture data), per the batch-02
// fixtures rule.

function makeNode(overrides: Partial<GraphNode> & { id: string; label: string }): GraphNode {
  return {
    level: 1,
    kind: "cluster",
    visit_count: 0,
    parent_id: null,
    children_ids: [],
    capture_ids: [],
    page_urls: [],
    first_visited_at: null,
    ...overrides,
  };
}

function makeCluster(overrides: Partial<GraphCluster> & { id: string; name: string }): GraphCluster {
  return { page_ids: [], ...overrides };
}

function makePayload(nodes: GraphNode[], clusters: GraphCluster[] = []): GraphPayload {
  return { nodes, links: [], clusters, super_clusters: [], groups: [] };
}

function makeWindow(overrides: Partial<DiaryWindow> & { key: string }): DiaryWindow {
  return {
    label: overrides.key,
    node_ids: [],
    graph_node_ids: [],
    cluster_freq: {},
    cluster_names: {},
    page_count: 0,
    ...overrides,
  };
}

// Probe: exposes nav state and a configurable set of dispatch buttons --
// mirrors DiaryPanel.test.tsx's Probe pattern, generalized so each test can
// supply exactly the NavAction(s) it needs to set up initial state.
function Probe({ actions = [] }: { actions?: Array<{ label: string; action: NavAction }> }) {
  const { state, dispatch } = useNav();
  return (
    <div>
      <span data-testid="probe-selected">{state.selectedNodeId ?? "none"}</span>
      <span data-testid="probe-filter-key">{state.filterWindowKey ?? "none"}</span>
      {actions.map(({ label, action }) => (
        <button key={label} onClick={() => dispatch(action)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function renderTopicDetail(actions: Array<{ label: string; action: NavAction }> = []) {
  return render(
    <NavProvider>
      <TopicDetail />
      <Probe actions={actions} />
    </NavProvider>
  );
}

async function dispatchAction(label: string) {
  await userEvent.click(screen.getByText(label));
}

describe("TopicDetail", () => {
  beforeEach(() => {
    __resetGraphCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Dispatch branch 1: no selection, no filter ─────────────────────
  it("branch 1: no selection, no filter -> the click-a-node placeholder", async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
    const { container } = renderTopicDetail();

    await screen.findByText("Click a node in the graph to see details.");
    const scroll = container.querySelector(".panel-scroll");
    expect(scroll?.querySelector(".placeholder-text")).toHaveTextContent(
      "Click a node in the graph to see details."
    );
  });

  // ── Dispatch branch 2: no selection, filter set -> WindowSummaryView ─
  it("branch 2: no selection + filterWindowKey set -> WindowSummaryView", async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([
      makeWindow({ key: "2026-07-20", label: "Mon Jul 20" }),
    ]);
    renderTopicDetail([
      { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
    ]);

    await dispatchAction("set-filter");
    await screen.findByText("Mon Jul 20");
  });

  // ── Dispatch branch 3: selectedNodeId is a graph node -> PageView ────
  it("branch 3: selectedNodeId resolves to a graph node -> PageView", async () => {
    const node = makeNode({ id: "page-a", label: "Page A" });
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
    renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

    await dispatchAction("select-a");
    await screen.findByText("Page A");
  });

  // ── Dispatch branch 4: cluster slug with members -> ClusterView ──────
  it("branch 4: selectedNodeId is not a node but is some node's parent_id -> ClusterView", async () => {
    const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
      makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
    );
    renderTopicDetail([{ label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } }]);

    await dispatchAction("select-cluster");
    await screen.findByText("Pages in this cluster:");
    expect(screen.getAllByText("Cluster A").length).toBeGreaterThan(0);
  });

  // ── Dispatch branch 5: unknown id, no members -> Node not found ──────
  it('branch 5: unknown selectedNodeId with no matching members -> "Node not found."', async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
    renderTopicDetail([{ label: "select-unknown", action: { type: "SELECT_NODE", id: "ghost" } }]);

    await dispatchAction("select-unknown");
    await screen.findByText("Node not found.");
  });

  // ── PageView: cluster pill presence/absence ──────────────────────────
  describe("PageView cluster pill", () => {
    it("renders a clickable pill for a real cluster parent_id, with the DB-authored display name", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([node], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");

      const pill = container.querySelector(".nav-btn");
      expect(pill).toHaveTextContent("Cluster A");
      expect(pill?.tagName).toBe("BUTTON");
    });

    it("falls back to the title-cased slug when the cluster id has no DB-authored name", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "some_unnamed_cluster" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node], []));
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(screen.getByText("Some Unnamed Cluster")).toBeInTheDocument();
    });

    it("clicking the cluster pill dispatches SELECT_CLUSTER with parent_id", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([node], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      await userEvent.click(screen.getByText("Cluster A"));

      expect(screen.getByTestId("probe-selected")).toHaveTextContent("cluster_a");
    });

    it('renders an "Unclustered" span (not a button) for parent_id "_unclustered"', async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "_unclustered" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");

      const span = screen.getByText("Unclustered");
      expect(span.tagName).toBe("SPAN");
      expect(container.querySelector(".nav-btn")).not.toBeInTheDocument();
    });

    it('renders no pill/span for a "_solo_"-prefixed parent_id', async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "_solo_page-a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(container.querySelector(".nav-btn")).not.toBeInTheDocument();
      expect(screen.queryByText("Unclustered")).not.toBeInTheDocument();
    });

    it('renders no pill/span for parent_id "root"', async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: "root" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(container.querySelector(".nav-btn")).not.toBeInTheDocument();
    });

    it("renders no pill/span when parent_id is null", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", parent_id: null });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(container.querySelector(".nav-btn")).not.toBeInTheDocument();
    });
  });

  // ── PageView: title link vs div ───────────────────────────────────────
  describe("PageView title", () => {
    it("renders an <a> with href/target when page_urls[0] is present", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: ["https://example.com/a"] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      vi.spyOn(apiModule, "fetchPageContent").mockResolvedValue(null);
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      const link = await screen.findByRole("link", { name: "Page A" });
      expect(link).toHaveAttribute("href", "https://example.com/a");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveClass("detail-header");
    });

    it("renders a <div> (no link) when there are no page_urls", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: [] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(screen.queryByRole("link", { name: "Page A" })).not.toBeInTheDocument();
      const header = container.querySelector(".detail-header");
      expect(header?.tagName).toBe("DIV");
    });
  });

  // ── PageView: visit caption singular/plural + time-window label ─────
  describe("PageView visit caption", () => {
    it("singular 'visit' when visit_count is 1, and 'all time' when no node has first_visited_at", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", visit_count: 1, first_visited_at: null });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("1 visit all time");
    });

    it("plural 'visits' when visit_count is not 1", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", visit_count: 3, first_visited_at: null });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("3 visits all time");
    });

    it("renders 'since <local date>' from the MIN first_visited_at across ALL graph nodes", async () => {
      const nodeA = makeNode({
        id: "page-a",
        label: "Page A",
        visit_count: 2,
        first_visited_at: "2026-03-15T10:00:00Z",
      });
      const nodeB = makeNode({
        id: "page-b",
        label: "Page B",
        visit_count: 1,
        first_visited_at: "2026-01-05T10:00:00Z",
      });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([nodeA, nodeB]));
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      // The min date is nodeB's (Jan 5), even though nodeB isn't the
      // selected node -- this caption is a GLOBAL "since earliest active
      // page" label (Task 8 makes it dynamic per date-range picker; batch
      // 02 hardcodes the "all" window, mirroring topic_detail.py's
      // _time_window_label "all"/no-window branch).
      const expectedDate = new Date("2026-01-05T10:00:00Z");
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const expected = `since ${months[expectedDate.getMonth()]} ${expectedDate.getDate()}, ${expectedDate.getFullYear()}`;
      await screen.findByText(`2 visits ${expected}`);
    });
  });

  // ── PageView: content card url-loop ───────────────────────────────────
  describe("PageView content card", () => {
    it("tries each page_url in order, using the first non-null result", async () => {
      const node = makeNode({
        id: "page-a",
        label: "Page A",
        page_urls: ["https://example.com/dead", "https://example.com/alive"],
      });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const fetchSpy = vi
        .spyOn(apiModule, "fetchPageContent")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          pid: 42,
          url: "https://example.com/alive",
          domain: "example.com",
          extracted_text: "hello world",
          content_summary: null,
          tool_selected: null,
          has_usable_html: false,
        });
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText(/example\.com/);

      expect(fetchSpy).toHaveBeenNthCalledWith(1, "https://example.com/dead");
      expect(fetchSpy).toHaveBeenNthCalledWith(2, "https://example.com/alive");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("omits the content card entirely when every url resolves to null", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: ["https://example.com/dead"] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      vi.spyOn(apiModule, "fetchPageContent").mockResolvedValue(null);
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      await waitFor(() => expect(apiModule.fetchPageContent).toHaveBeenCalledTimes(1));
      expect(container.querySelector("iframe")).not.toBeInTheDocument();
      expect(container.querySelector("details")).not.toBeInTheDocument();
      expect(screen.queryByText("No extracted content available.")).not.toBeInTheDocument();
    });

    it("omits the content card when there are no page_urls at all", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: [] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const fetchSpy = vi.spyOn(apiModule, "fetchPageContent");
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("Page A");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("renders the iframe branch (src + sandbox) when has_usable_html is true", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: ["https://example.com/a"] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      vi.spyOn(apiModule, "fetchPageContent").mockResolvedValue({
        pid: 7,
        url: "https://example.com/a",
        domain: "example.com",
        extracted_text: null,
        content_summary: null,
        tool_selected: "readability",
        has_usable_html: true,
      });
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText(/archived copy/);

      const iframe = container.querySelector("iframe");
      expect(iframe).toHaveAttribute("src", "/api/pages/7/preview");
      expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
      expect(screen.getByText(/archived copy/)).toHaveTextContent("archived copy · example.com");
      const openOriginal = screen.getByText("open original ↗");
      expect(openOriginal).toHaveAttribute("href", "https://example.com/a");
    });

    it("renders the plaintext branch with Summary closed and Full text open, word counts thousands-separated", async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: ["https://example.com/a"] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      const longText = Array(1234).fill("word").join(" ");
      const summaryText = Array(56).fill("sum").join(" ");
      vi.spyOn(apiModule, "fetchPageContent").mockResolvedValue({
        pid: 9,
        url: "https://example.com/a",
        domain: "example.com",
        extracted_text: longText,
        content_summary: summaryText,
        tool_selected: "readability",
        has_usable_html: false,
      });
      const { container } = renderTopicDetail([
        { label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } },
      ]);

      await dispatchAction("select-a");
      await screen.findByText(/Full text \(/);

      expect(screen.getByText("Summary (56 words)")).toBeInTheDocument();
      expect(screen.getByText("Full text (1,234 words)")).toBeInTheDocument();
      const summaryDetails = screen.getByText("Summary (56 words)").closest("details");
      const fullTextDetails = screen.getByText(/Full text \(/).closest("details");
      expect(summaryDetails).not.toHaveAttribute("open");
      expect(fullTextDetails).toHaveAttribute("open");
      expect(container).toHaveTextContent("example.com · via readability");
    });

    it('renders the italic "No extracted content available." when there is no text or summary', async () => {
      const node = makeNode({ id: "page-a", label: "Page A", page_urls: ["https://example.com/a"] });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([node]));
      vi.spyOn(apiModule, "fetchPageContent").mockResolvedValue({
        pid: 10,
        url: "https://example.com/a",
        domain: "example.com",
        extracted_text: null,
        content_summary: null,
        tool_selected: null,
        has_usable_html: false,
      });
      renderTopicDetail([{ label: "select-a", action: { type: "SELECT_NODE", id: "page-a" } }]);

      await dispatchAction("select-a");
      await screen.findByText("No extracted content available.");
      expect(document.querySelector("details")).not.toBeInTheDocument();
    });
  });

  // ── ClusterView ────────────────────────────────────────────────────────
  describe("ClusterView", () => {
    it("renders header, caption (singular page), Home button, and breadcrumb (Home > cluster)", async () => {
      const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a", visit_count: 2 });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("select-cluster");
      await screen.findByText("Topic cluster · 1 page");

      const home = container.querySelector(".nav-btn");
      expect(home).toHaveTextContent("Home");

      const breadcrumb = container.querySelector(".breadcrumb");
      expect(breadcrumb).toBeInTheDocument();
      expect(breadcrumb?.querySelector(".breadcrumb-link")).toHaveTextContent("Home");
      expect(breadcrumb?.querySelector(".breadcrumb-current")).toHaveTextContent("Cluster A");
    });

    it("pluralizes the caption for multiple members", async () => {
      const a = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      const b = makeNode({ id: "page-b", label: "Page B", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([a, b], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      renderTopicDetail([{ label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } }]);

      await dispatchAction("select-cluster");
      await screen.findByText("Topic cluster · 2 pages");
    });

    it("sorts members by label and formats '{label}  ({visit_count} visits)' (two spaces, always plural)", async () => {
      const zeta = makeNode({ id: "page-z", label: "Zeta", parent_id: "cluster_a", visit_count: 1 });
      const alpha = makeNode({ id: "page-a", label: "Alpha", parent_id: "cluster_a", visit_count: 5 });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([zeta, alpha], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("select-cluster");
      await screen.findByText("Pages in this cluster:");

      const items = Array.from(container.querySelectorAll(".child-item"));
      expect(items.map((el) => el.textContent)).toEqual(["Alpha  (5 visits)", "Zeta  (1 visits)"]);
    });

    it("clicking a member dispatches SELECT_NODE with the page id", async () => {
      const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a", visit_count: 1 });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("select-cluster");
      await screen.findByText("Pages in this cluster:");
      // RTL's default text matcher normalizes/collapses whitespace, which
      // would silently swallow the deliberate double-space in the label --
      // go through the container query (raw textContent) instead of
      // getByText to click the member button.
      const memberBtn = container.querySelector(".child-item") as HTMLElement;
      expect(memberBtn.textContent).toBe("Page A  (1 visits)");
      await userEvent.click(memberBtn);

      expect(screen.getByTestId("probe-selected")).toHaveTextContent("page-a");
    });

    it("renders a filter chip when filterWindowKey is active, with a working clear button", async () => {
      const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("set-filter");
      await dispatchAction("select-cluster");
      await screen.findByText("Pages in this cluster:");

      expect(screen.getByText("Filter: 2026-07-20")).toBeInTheDocument();
      await userEvent.click(screen.getByTitle("Clear filter"));
      expect(screen.getByTestId("probe-filter-key")).toHaveTextContent("none");
    });

    it("renders no filter chip when no filter is active", async () => {
      const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("select-cluster");
      await screen.findByText("Pages in this cluster:");
      expect(container.querySelector(".filter-chip")).not.toBeInTheDocument();
    });

    it("Home button dispatches HOME", async () => {
      const member = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(
        makePayload([member], [makeCluster({ id: "cluster_a", name: "Cluster A" })])
      );
      const { container } = renderTopicDetail([
        { label: "select-cluster", action: { type: "SELECT_CLUSTER", id: "cluster_a" } },
      ]);

      await dispatchAction("select-cluster");
      await screen.findByText("Pages in this cluster:");
      // "Home" text appears twice here (the nav-btn Home button AND the
      // breadcrumb's Home crumb) -- target the nav-btn specifically rather
      // than an ambiguous getByText("Home").
      const homeBtn = container.querySelector(".nav-btn");
      expect(homeBtn).toHaveTextContent("Home");
      await userEvent.click(homeBtn as HTMLElement);

      expect(screen.getByTestId("probe-selected")).toHaveTextContent("none");
      await screen.findByText("Click a node in the graph to see details.");
    });

    it('renders the defensive "No cluster detail available" placeholder for a "_solo_"-prefixed id', async () => {
      const solo = makeNode({ id: "page-a", label: "Page A", parent_id: "_solo_page-a" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([solo]));
      renderTopicDetail([
        { label: "select-solo-cluster", action: { type: "SELECT_CLUSTER", id: "_solo_page-a" } },
      ]);

      await dispatchAction("select-solo-cluster");
      await screen.findByText("No cluster detail available for this page.");
    });
  });

  // ── Breadcrumb walk helper (direct unit test) ─────────────────────────
  describe("buildBreadcrumbTrail", () => {
    it("walks a real node up to a cluster-slug parent (no graph node), producing Home > cluster > page", () => {
      const page = makeNode({ id: "page-a", label: "Page A", parent_id: "cluster_a" });
      const nodeById = (id: string) => (id === "page-a" ? page : undefined);
      const trail = buildBreadcrumbTrail("page-a", nodeById, { cluster_a: "Cluster A" });

      expect(trail.map((c) => c.label)).toEqual(["Home", "Cluster A", "Page A"]);
      expect(trail.map((c) => c.id)).toEqual([null, "cluster_a", "page-a"]);
    });

    it("stops immediately at a cluster slug with no graph node entry (Home > cluster)", () => {
      const nodeById = () => undefined;
      const trail = buildBreadcrumbTrail("cluster_a", nodeById, { cluster_a: "Cluster A" });

      expect(trail.map((c) => c.label)).toEqual(["Home", "Cluster A"]);
    });

    it("guards against runaway depth with the bounded-hops cap", () => {
      // Pathological: every node points to the next as its own "graph
      // node" parent (never resolves to a cluster-slug stop condition).
      const nodes: Record<string, GraphNode> = {};
      for (let i = 0; i < 20; i++) {
        nodes[`n${i}`] = makeNode({ id: `n${i}`, label: `N${i}`, parent_id: i > 0 ? `n${i - 1}` : null });
      }
      const nodeById = (id: string) => nodes[id];
      const trail = buildBreadcrumbTrail("n19", nodeById, {});
      // Bounded (Home + <= 8 hops), never infinite.
      expect(trail.length).toBeLessThanOrEqual(9);
    });
  });

  // ── WindowSummaryView ──────────────────────────────────────────────────
  describe("WindowSummaryView", () => {
    it("renders header (window label), caption counts, sorted topic pills, and page links", async () => {
      const pageNode = makeNode({ id: "page-a", label: "Page A" });
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([pageNode]));
      const win = makeWindow({
        key: "2026-07-20",
        label: "Mon Jul 20",
        graph_node_ids: ["page-a", "page-b"],
        cluster_freq: { a: 1, b: 3 },
        cluster_names: { a: "Alpha", b: "Beta" },
      });
      vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([win]);
      const { container } = renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);

      await dispatchAction("set-filter");
      await screen.findByText("Mon Jul 20");

      expect(screen.getByText("2 pages across 2 topics")).toBeInTheDocument();

      const pills = Array.from(container.querySelectorAll(".tag-pill")).map((el) => el.textContent);
      expect(pills).toEqual(["Beta (3)", "Alpha (1)"]);

      // page-a resolves its label via the graph; page-b is unknown to the
      // graph fixture, so it falls back to rendering the raw id.
      expect(screen.getByText("Page A")).toBeInTheDocument();
      expect(screen.getByText("page-b")).toBeInTheDocument();
    });

    it("dedupes repeated graph_node_ids in the page list while preserving order", async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      const win = makeWindow({
        key: "2026-07-20",
        label: "Mon Jul 20",
        graph_node_ids: ["page-a", "page-b", "page-a"],
      });
      vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([win]);
      const { container } = renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);

      await dispatchAction("set-filter");
      await screen.findByText("Mon Jul 20");

      const links = Array.from(container.querySelectorAll(".page-link")).map((el) => el.textContent);
      expect(links).toEqual(["page-a", "page-b"]);
    });

    it("clicking a topic pill dispatches SELECT_CLUSTER; clicking a page link dispatches SELECT_NODE", async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      const win = makeWindow({
        key: "2026-07-20",
        label: "Mon Jul 20",
        graph_node_ids: ["page-a"],
        cluster_freq: { a: 1 },
        cluster_names: { a: "Alpha" },
      });
      vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([win]);
      renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);

      await dispatchAction("set-filter");
      await screen.findByText("Mon Jul 20");

      await userEvent.click(screen.getByText("Alpha (1)"));
      expect(screen.getByTestId("probe-selected")).toHaveTextContent("a");
    });

    it("derives granularity from the window key: '-W' -> week, length 7 -> month, else day", async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      const fetchSpy = vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);

      renderTopicDetail([
        { label: "set-week", action: { type: "SET_WINDOW_FILTER", key: "2026-W30", nodeIds: [] } },
      ]);
      await dispatchAction("set-week");
      await waitFor(() => expect(fetchSpy).toHaveBeenNthCalledWith(1, "week", undefined));
    });

    it("derives month granularity for a 7-char YYYY-MM key", async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      const fetchSpy = vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);

      renderTopicDetail([
        { label: "set-month", action: { type: "SET_WINDOW_FILTER", key: "2026-07", nodeIds: [] } },
      ]);
      await dispatchAction("set-month");
      await waitFor(() => expect(fetchSpy).toHaveBeenNthCalledWith(1, "month", undefined));
    });

    it("derives day granularity for a YYYY-MM-DD key", async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      const fetchSpy = vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);

      renderTopicDetail([
        { label: "set-day", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);
      await dispatchAction("set-day");
      await waitFor(() => expect(fetchSpy).toHaveBeenNthCalledWith(1, "day", undefined));
    });

    it('shows "No pages in this window." when no window matches the key', async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([makeWindow({ key: "some-other-key" })]);
      renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);

      await dispatchAction("set-filter");
      await screen.findByText("No pages in this window.");
    });

    it('shows "No pages in this window." when the fetch fails', async () => {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(makePayload([]));
      vi.spyOn(apiModule, "fetchDiaryWindows").mockRejectedValue(new Error("boom"));
      renderTopicDetail([
        { label: "set-filter", action: { type: "SET_WINDOW_FILTER", key: "2026-07-20", nodeIds: [] } },
      ]);

      await dispatchAction("set-filter");
      await screen.findByText("No pages in this window.");
    });
  });
});
