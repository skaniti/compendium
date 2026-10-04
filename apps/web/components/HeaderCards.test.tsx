import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HeaderCards from "./HeaderCards";
import TimeWindowProvider from "./TimeWindowProvider";
import { useGraph, __resetGraphCacheForTest } from "@/hooks/useGraph";
import * as apiModule from "@/lib/api";
import * as SessionProviderModule from "./SessionProvider";
import type { SessionRole } from "./SessionProvider";
import type { ClusteringStatus, GraphPayload, ReclusterResult, TopicInterest } from "@/lib/types";

// Ports app.py's _build_graph_widgets (Dash source of truth) into a
// JSX-parity suite: CLUSTERING / DATE RANGE / SUPERCLUSTERS cards. All
// fixtures are synthetic, per the batch-02 fixtures rule. Every test mocks
// lib/api's fetchers per the repo's established convention (DiaryPanel.test.tsx
// / TopicDetail.test.tsx) -- HeaderCards fires fetchClusteringStatus,
// fetchTopics, and (via the real useGraph() hook) fetchGraph on mount, so
// every test needs all three mocked and the module-level graph cache reset.

const EMPTY_GRAPH: GraphPayload = { nodes: [], links: [], clusters: [], super_clusters: [], groups: [] };

const NO_RUNS_STATUS: ClusteringStatus = {
  run_number: null,
  title: "CLUSTERING (NO RUNS YET)",
  stats_line1: "no recluster yet",
  stats_line2: "",
  freshness_label: "No cache",
  freshness_color: "",
};

function makeStatus(overrides: Partial<ClusteringStatus> = {}): ClusteringStatus {
  return { ...NO_RUNS_STATUS, ...overrides };
}

function makeTopic(overrides: Partial<TopicInterest> & { keyword: string }): TopicInterest {
  return { icon_id: null, cluster_count: 0, ...overrides };
}

function makeReclusterResult(overrides: Partial<ReclusterResult> = {}): ReclusterResult {
  return { cluster_count: 5, noise_count: 1, naming_cost: 0.01, elapsed_seconds: 25, ...overrides };
}

// Default happy-path mocks -- individual tests override whichever fetcher
// they care about via a fresh vi.spyOn call before rendering.
function mockDefaults() {
  vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
  vi.spyOn(apiModule, "fetchClusteringStatus").mockResolvedValue(makeStatus());
  vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
}

// vi.advanceTimersByTimeAsync alone leaves the setTimeout callback's
// setState update unflushed under React 19 + vitest fake timers -- wrapping
// in act() forces React to flush the resulting re-render before the
// assertion that follows (same gotcha/fix as ScTooltip.test.tsx's own
// advanceTimers helper).
async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// HeaderCards reads useSession() for the demo recluster lock; mock the hook
// (SearchBar.test.tsx's convention). beforeEach defaults to admin.
function mockSession(overrides: { role?: SessionRole | null; actingAsDemo?: boolean } = {}) {
  vi.spyOn(SessionProviderModule, "useSession").mockReturnValue({
    role: overrides.role ?? "admin",
    account: "test@example.com",
    actingAsDemo: overrides.actingAsDemo ?? false,
    adminOriginEmail: undefined,
    showNoise: false,
    status: "hydrated",
    refresh: vi.fn(),
  });
}

function renderHeaderCards(children?: ReactNode) {
  return render(
    <TimeWindowProvider>
      <HeaderCards />
      {children}
    </TimeWindowProvider>
  );
}

// Test-only probe: a second useGraph() consumer so a test can call
// refresh() directly to simulate a recluster/mutation completing
// elsewhere and bumping graphVersion.
function GraphVersionProbe() {
  const { refresh } = useGraph();
  return (
    <button
      onClick={() => {
        void refresh();
      }}
    >
      bump-graph-version
    </button>
  );
}

describe("HeaderCards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetGraphCacheForTest();
    mockSession();
  });

  // ── CLUSTERING card ──────────────────────────────────────────────────

  it("renders the static NO RUNS YET title before the clustering-status fetch resolves", () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    vi.spyOn(apiModule, "fetchClusteringStatus").mockReturnValue(new Promise(() => {})); // never resolves
    renderHeaderCards();

    expect(document.getElementById("clustering-card-title")).toHaveTextContent(
      "CLUSTERING (NO RUNS YET)"
    );
    expect(document.getElementById("hbar-cluster-stats-line1")).toHaveTextContent("");
    expect(document.getElementById("hbar-cluster-stats-line2")).toHaveTextContent("");
    expect(document.getElementById("cache-freshness-badge")).toHaveTextContent("");
  });

  it("renders loaded clustering status fields (title, stat lines, freshness badge)", async () => {
    mockDefaults();
    vi.spyOn(apiModule, "fetchClusteringStatus").mockResolvedValue(
      makeStatus({
        run_number: 3,
        title: "CLUSTERING (RUN #3)",
        stats_line1: "5 clusters · 4 topics",
        stats_line2: "12% noise",
        freshness_label: "● 2h ago",
        freshness_color: "#4ade80",
      })
    );
    renderHeaderCards();

    await screen.findByText("CLUSTERING (RUN #3)");
    expect(document.getElementById("hbar-cluster-stats-line1")).toHaveTextContent(
      "5 clusters · 4 topics"
    );
    expect(document.getElementById("hbar-cluster-stats-line2")).toHaveTextContent("12% noise");
    const badge = document.getElementById("cache-freshness-badge") as HTMLElement;
    expect(badge).toHaveTextContent("2h ago");
    expect(badge.style.color).toBe("rgb(74, 222, 128)");
    expect(badge.style.opacity).toBe("");
  });

  it('renders the "No cache" branch styling when freshness_color is empty (recluster.py:113-118 parity)', async () => {
    mockDefaults();
    vi.spyOn(apiModule, "fetchClusteringStatus").mockResolvedValue(
      makeStatus({ freshness_label: "No cache", freshness_color: "" })
    );
    renderHeaderCards();

    const badge = await waitFor(() => {
      const el = document.getElementById("cache-freshness-badge") as HTMLElement;
      expect(el).toHaveTextContent("No cache");
      return el;
    });
    expect(badge.style.color).toBe("var(--on-primary)");
    expect(badge.style.opacity).toBe("0.5");
  });

  it("recluster click: busy class + disabled while in flight, then refresh + status refetch (via graphVersion) + un-busy on success", async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    let resolvePost!: (value: ReclusterResult) => void;
    const postPromise = new Promise<ReclusterResult>((resolve) => {
      resolvePost = resolve;
    });
    const postSpy = vi.spyOn(apiModule, "postRecluster").mockReturnValue(postPromise);
    const statusSpy = vi
      .spyOn(apiModule, "fetchClusteringStatus")
      .mockResolvedValueOnce(makeStatus({ title: "CLUSTERING (NO RUNS YET)" }))
      .mockResolvedValueOnce(makeStatus({ title: "CLUSTERING (RUN #1)", stats_line1: "3 clusters" }));

    renderHeaderCards();
    await screen.findByText("CLUSTERING (NO RUNS YET)");
    expect(statusSpy).toHaveBeenCalledTimes(1);

    const button = document.getElementById("recluster-btn") as HTMLButtonElement;
    // Idle: the centred arrow icon, no spinner (2026-10-04).
    expect(button.querySelector("svg.hbar-recluster-icon")).not.toBeNull();
    expect(button.querySelector(".hbar-recluster-spinner")).toBeNull();
    await userEvent.click(button);

    // Busy state applied synchronously (setBusy(true) runs before the
    // first await inside handleRecluster). The arrow gives way to the
    // fading-tail ring spinner; the button itself no longer rotates.
    expect(button.className).toBe("hbar-recluster-btn is-spinning");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".hbar-recluster-spinner")).not.toBeNull();
    expect(button.querySelector("svg.hbar-recluster-icon")).toBeNull();
    expect(postSpy).toHaveBeenCalledTimes(1);

    // A second click while busy must be impossible.
    await userEvent.click(button);
    expect(postSpy).toHaveBeenCalledTimes(1);

    resolvePost(makeReclusterResult());

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.className).toBe("hbar-recluster-btn");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector("svg.hbar-recluster-icon")).not.toBeNull();
    await screen.findByText("CLUSTERING (RUN #1)");
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  it("recluster failure path: un-busies without calling refresh or refetching status", async () => {
    const fetchGraphSpy = vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const statusSpy = vi.spyOn(apiModule, "fetchClusteringStatus").mockResolvedValue(makeStatus());
    vi.spyOn(apiModule, "postRecluster").mockRejectedValue(new Error("recluster failed"));

    renderHeaderCards();
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchGraphSpy).toHaveBeenCalledTimes(1));

    const button = document.getElementById("recluster-btn") as HTMLButtonElement;
    // postRecluster rejects immediately (already-rejected mock promise), so
    // the busy -> un-busy transition can settle before this awaited click
    // even returns -- assert the settled end state rather than an
    // intermediate busy snapshot (covered by the success-path test above).
    await userEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.className).toBe("hbar-recluster-btn");
    // Failure -- un-busy only, no refresh() (no extra fetchGraph call) and
    // no status refetch.
    expect(fetchGraphSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledTimes(1);
  });

  it("admin: recluster is live, with the Recluster now tooltip (chart-kit style, no native title)", () => {
    mockDefaults();
    renderHeaderCards();

    const button = document.getElementById("recluster-btn") as HTMLButtonElement;
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAccessibleName("Recluster now");
    fireEvent.mouseEnter(button, { clientX: 20, clientY: 20 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Recluster now");
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    ["a direct demo login", false],
    ["an admin viewing as demo", true],
  ])("demo (%s): recluster is greyed out with a demo-view tooltip, and a click sends nothing (2026-10-04)", async (_label, actingAsDemo) => {
    mockDefaults();
    mockSession({ role: "demo", actingAsDemo });
    const postSpy = vi.spyOn(apiModule, "postRecluster").mockResolvedValue(makeReclusterResult());
    renderHeaderCards();

    const button = document.getElementById("recluster-btn") as HTMLButtonElement;
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAccessibleName("Recluster is disabled in demo view");
    fireEvent.mouseEnter(button, { clientX: 20, clientY: 20 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Recluster is disabled in demo view");
    fireEvent.mouseLeave(button);

    await userEvent.click(button);
    expect(postSpy).not.toHaveBeenCalled();
    expect(button.className).toBe("hbar-recluster-btn");
  });

  it("refetches clustering status whenever graphVersion bumps, not just on mount/recluster (final-review I1)", async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const statusSpy = vi
      .spyOn(apiModule, "fetchClusteringStatus")
      .mockResolvedValueOnce(makeStatus({ stats_line1: "5 clusters · 0 topics" }))
      .mockResolvedValueOnce(makeStatus({ stats_line1: "5 clusters · 1 topics" }));

    // GraphVersionProbe's refresh() stands in for a topic mutation
    // (add/delete/rename/icon/exclude) bumping graphVersion via
    // refreshGraph() elsewhere in the tree -- exactly I1's failure
    // scenario, without recluster in the loop at all.
    renderHeaderCards(<GraphVersionProbe />);
    await screen.findByText("5 clusters · 0 topics");
    expect(statusSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByText("bump-graph-version"));

    await screen.findByText("5 clusters · 1 topics");
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  it("polls clustering status every 60 seconds so the freshness badge never freezes (final-review M1)", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
      vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
      const statusSpy = vi
        .spyOn(apiModule, "fetchClusteringStatus")
        .mockResolvedValueOnce(makeStatus({ freshness_label: "● 1m ago", freshness_color: "#4ade80" }))
        .mockResolvedValueOnce(makeStatus({ freshness_label: "● 2m ago", freshness_color: "#4ade80" }));

      renderHeaderCards();
      await advanceTimers(0); // flush the mount-time fetchClusteringStatus() microtask
      expect(document.getElementById("cache-freshness-badge")).toHaveTextContent("1m ago");
      expect(statusSpy).toHaveBeenCalledTimes(1);

      await advanceTimers(59_999);
      expect(statusSpy).toHaveBeenCalledTimes(1); // not yet -- one ms short of the 60s mark

      await advanceTimers(1);
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(document.getElementById("cache-freshness-badge")).toHaveTextContent("2m ago");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── DATE RANGE card ──────────────────────────────────────────────────

  it("renders the four DATE RANGE pills with exact labels, defaulting to All active", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("DATE RANGE");

    const pills = Array.from(document.querySelectorAll(".hbar-pill"));
    expect(pills.map((p) => p.textContent)).toEqual(["7d", "30d", "90d", "All"]);
    expect(screen.getByText("All")).toHaveClass("hbar-pill active");
    expect(screen.getByText("7d")).not.toHaveClass("active");
    expect(screen.getByText("30d")).not.toHaveClass("active");
    expect(screen.getByText("90d")).not.toHaveClass("active");
  });

  it("clicking a pill activates it and deactivates the others", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("DATE RANGE");

    await userEvent.click(screen.getByText("30d"));

    expect(screen.getByText("30d")).toHaveClass("hbar-pill active");
    expect(screen.getByText("All")).not.toHaveClass("active");
    expect(screen.getByText("7d")).not.toHaveClass("active");
    expect(screen.getByText("90d")).not.toHaveClass("active");

    await userEvent.click(screen.getByText("7d"));
    expect(screen.getByText("7d")).toHaveClass("hbar-pill active");
    expect(screen.getByText("30d")).not.toHaveClass("active");
  });

  // ── SUPERCLUSTERS card ───────────────────────────────────────────────

  it("renders the N/12 ALLOCATED title from topics.length", async () => {
    mockDefaults();
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "a" }),
      makeTopic({ keyword: "b" }),
      makeTopic({ keyword: "c" }),
    ]);
    renderHeaderCards();

    const title = await screen.findByText("SUPERCLUSTERS (3/12 ALLOCATED)");
    expect(title).toHaveAttribute("id", "sc-card-title");
    expect(title.className).toBe("hbar-card-title");
  });

  it("renders the overflow title + class when topics.length exceeds MAX_SUPERCLUSTERS", async () => {
    mockDefaults();
    const overflowTopics = Array.from({ length: 13 }, (_, i) => makeTopic({ keyword: `t${i}` }));
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue(overflowTopics);
    renderHeaderCards();

    const title = await screen.findByText("SUPERCLUSTERS OVERFLOW (13/12)");
    expect(title.className).toBe("hbar-card-title hbar-sc-title-overflow");
    // Still exactly 12 rendered tile slots regardless of overflow.
    await waitFor(() =>
      expect(document.querySelectorAll("[data-sc-tile-slot]")).toHaveLength(12)
    );
  });

  it("always renders exactly 12 tile slots with data-sc-tile-slot 0..11", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (0/12 ALLOCATED)");

    const slots = Array.from(document.querySelectorAll("[data-sc-tile-slot]")).map((el) =>
      el.getAttribute("data-sc-tile-slot")
    );
    expect(slots).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
  });

  it("allocated tile (cluster_count > 0): allocated class, bold icon (strokeWidth 2, no dasharray), no title", async () => {
    mockDefaults();
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "cooking", icon_id: "notebook", cluster_count: 3 }),
    ]);
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (1/12 ALLOCATED)");

    const tile = document.querySelector('[data-sc-tile-slot="0"]') as HTMLElement;
    expect(tile.className).toBe("hbar-sc-tile hbar-sc-tile-allocated");
    expect(tile).not.toHaveAttribute("title");
    const path = tile.querySelector("svg path") as SVGPathElement;
    expect(path).toBeInTheDocument();
    expect(path.getAttribute("stroke")).toBe("#ffffff");
    expect(path.getAttribute("stroke-width")).toBe("2");
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("allocated-but-memberless tile (cluster_count === 0): -allocated-empty class, dashed thinner icon, no title", async () => {
    mockDefaults();
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "empty-topic", icon_id: "rocket", cluster_count: 0 }),
    ]);
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (1/12 ALLOCATED)");

    const tile = document.querySelector('[data-sc-tile-slot="0"]') as HTMLElement;
    expect(tile.className).toBe("hbar-sc-tile hbar-sc-tile-allocated hbar-sc-tile-allocated-empty");
    expect(tile).not.toHaveAttribute("title");
    const path = tile.querySelector("svg path") as SVGPathElement;
    expect(path.getAttribute("stroke-width")).toBe("1.5");
    expect(path.getAttribute("stroke-dasharray")).toBe("6,4");
  });

  it("empty slot: empty class, add-a-supercluster title, plus-glyph svg", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (0/12 ALLOCATED)");

    const tile = document.querySelector('[data-sc-tile-slot="0"]') as HTMLElement;
    expect(tile.className).toBe("hbar-sc-tile hbar-sc-tile-empty");
    expect(tile).toHaveAttribute("title", "Add a supercluster (slot 1)");
    const svg = tile.querySelector("svg.hbar-sc-plus");
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelectorAll("line")).toHaveLength(2);

    const tile6 = document.querySelector('[data-sc-tile-slot="5"]') as HTMLElement;
    expect(tile6).toHaveAttribute("title", "Add a supercluster (slot 6)");
  });

  it("tile click toggles the open slot: same slot closes, a different slot switches", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (0/12 ALLOCATED)");

    const body = document.getElementById("sc-card-body") as HTMLElement;
    const tile0 = document.querySelector('[data-sc-tile-slot="0"]') as HTMLElement;
    const tile1 = document.querySelector('[data-sc-tile-slot="1"]') as HTMLElement;

    expect(body).toHaveAttribute("data-open-slot", "");

    await userEvent.click(tile0);
    expect(body).toHaveAttribute("data-open-slot", "0");

    await userEvent.click(tile0);
    expect(body).toHaveAttribute("data-open-slot", "");

    await userEvent.click(tile0);
    expect(body).toHaveAttribute("data-open-slot", "0");

    await userEvent.click(tile1);
    expect(body).toHaveAttribute("data-open-slot", "1");
  });

  it("empty-slot tiles also participate in the same open/close click semantics", async () => {
    mockDefaults();
    renderHeaderCards();
    await screen.findByText("SUPERCLUSTERS (0/12 ALLOCATED)");

    const body = document.getElementById("sc-card-body") as HTMLElement;
    const emptyTile = document.querySelector('[data-sc-tile-slot="3"]') as HTMLElement;

    await userEvent.click(emptyTile);
    expect(body).toHaveAttribute("data-open-slot", "3");

    await userEvent.click(emptyTile);
    expect(body).toHaveAttribute("data-open-slot", "");
  });

  it("refetches topics on mount AND whenever graphVersion bumps (recluster/mutation elsewhere)", async () => {
    vi.spyOn(apiModule, "fetchGraph").mockResolvedValue(EMPTY_GRAPH);
    vi.spyOn(apiModule, "fetchClusteringStatus").mockResolvedValue(makeStatus());
    const topicsSpy = vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);

    renderHeaderCards(<GraphVersionProbe />);
    await waitFor(() => expect(topicsSpy).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByText("bump-graph-version"));

    await waitFor(() => expect(topicsSpy).toHaveBeenCalledTimes(2));
  });
});
