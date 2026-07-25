import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiaryPanel from "./DiaryPanel";
import NavProvider, { useNav } from "./NavProvider";
import * as apiModule from "@/lib/api";
import type { DiaryWindow } from "@/lib/types";

// Ports layouts/session_diary.py's render_session_diary + _build_window_card
// (Dash source of truth) into a JSX-parity suite. All fixtures below are
// synthetic (no real capture data), per the batch-02 fixtures rule.

function makeWindow(overrides: Partial<DiaryWindow> & { key: string }): DiaryWindow {
  return {
    label: overrides.key,
    node_ids: [],
    graph_node_ids: [`${overrides.key}-graph-a`, `${overrides.key}-graph-b`],
    cluster_freq: {},
    cluster_names: {},
    page_count: 0,
    ...overrides,
  };
}

// Probe: reads nav state directly and exposes buttons to dispatch actions
// that only batch 03's real graph/topic-detail UI would otherwise trigger
// (SELECT_NODE) -- mirrors NavProvider.test.tsx's Consumer pattern, scoped
// to just what this suite needs to assert click-dispatch outcomes.
function Probe() {
  const { state, dispatch } = useNav();
  return (
    <div>
      <span data-testid="probe-selected">{state.selectedNodeId ?? "none"}</span>
      <span data-testid="probe-filter-key">{state.filterWindowKey ?? "none"}</span>
      <span data-testid="probe-filter-ids">{state.filterHighlightIds.join(",")}</span>
      <button onClick={() => dispatch({ type: "SELECT_NODE", id: "probe-node" })}>
        probe-select-node
      </button>
    </div>
  );
}

function renderPanel(granularity: "day" | "week" | "month" = "day") {
  return render(
    <NavProvider>
      <DiaryPanel granularity={granularity} />
      <Probe />
    </NavProvider>
  );
}

describe("DiaryPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Loading / error states ─────────────────────────────────────────

  it("renders nothing while the initial fetch is in flight (no empty-state flash)", () => {
    vi.spyOn(apiModule, "fetchDiaryWindows").mockReturnValue(new Promise(() => {}));
    const { container } = renderPanel();

    expect(container.querySelector(".panel-scroll")).not.toBeInTheDocument();
    expect(container.querySelector(".placeholder-text")).not.toBeInTheDocument();
  });

  it("renders a minimal placeholder-text error line on fetch failure", async () => {
    vi.spyOn(apiModule, "fetchDiaryWindows").mockRejectedValue(new Error("network down"));
    const { container } = renderPanel();

    await waitFor(() => expect(container.querySelector(".placeholder-text")).toBeInTheDocument());
    expect(container.querySelector(".placeholder-text")).toHaveTextContent(/network down/);
    // Deliberately not the empty-state's .panel-scroll wrapper -- distinct
    // markup from a confirmed-zero-windows result.
    expect(container.querySelector(".panel-scroll")).not.toBeInTheDocument();
  });

  it('empty state: "No pages yet." and the outer node IS .panel-scroll (no wrapper)', async () => {
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);
    const { container } = renderPanel();

    await screen.findByText("No pages yet.");
    const root = container.firstElementChild;
    expect(root?.className).toBe("panel-scroll");
    expect(root?.querySelector(".placeholder-text")).toHaveTextContent("No pages yet.");
  });

  it("non-empty state: .panel-scroll is nested inside a plain wrapper div (asymmetric vs empty)", async () => {
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([makeWindow({ key: "w1", label: "Today" })]);
    const { container } = renderPanel();

    await screen.findByText("Today");
    const root = container.firstElementChild;
    expect(root?.tagName).toBe("DIV");
    expect(root?.className).toBe("");
    expect(root?.querySelector(":scope > .panel-scroll")).not.toBeNull();
  });

  // ── Card structure ──────────────────────────────────────────────────

  it("renders session-card structure with the expected class names", async () => {
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([
      makeWindow({
        key: "w1",
        label: "Mon Jul 21",
        page_count: 2,
        cluster_freq: { a: 1 },
        cluster_names: { a: "Cooking" },
      }),
    ]);
    const { container } = renderPanel();

    await screen.findByText("Mon Jul 21");
    const card = container.querySelector(".session-card");
    expect(card).toBeInTheDocument();
    expect(card?.querySelector(".session-header")).toHaveTextContent("Mon Jul 21");
    expect(card?.querySelector(".session-card-body")).toBeInTheDocument();
    expect(card?.querySelector(".card-summary")).toBeInTheDocument();
    expect(card?.querySelector(".tag-container")).toBeInTheDocument();
    expect(card?.querySelector(".tag-pill")).toHaveTextContent("Cooking");
  });

  // ── Active accent (filterWindowKey) ─────────────────────────────────

  it("window-header click dispatches SET_WINDOW_FILTER with graph_node_ids, and accents that window", async () => {
    const w1 = makeWindow({ key: "w1", label: "Window One" });
    const w2 = makeWindow({ key: "w2", label: "Window Two" });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1, w2]);
    renderPanel();
    await screen.findByText("Window One");

    await userEvent.click(screen.getByText("Window Two"));

    expect(screen.getByText("Window Two").closest("button")).toHaveClass("session-header active");
    expect(screen.getByText("Window One").closest("button")).not.toHaveClass("active");
    expect(screen.getByTestId("probe-filter-key")).toHaveTextContent("w2");
    expect(screen.getByTestId("probe-filter-ids")).toHaveTextContent("w2-graph-a,w2-graph-b");
  });

  it("overflow-btn click dispatches the identical SET_WINDOW_FILTER as the window header", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "Overflow Window",
      cluster_freq: { a: 4, b: 3, c: 2, d: 1 },
      cluster_names: { a: "A", b: "B", c: "C", d: "D" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();
    await screen.findByText("Overflow Window");

    await userEvent.click(screen.getByText("+1 more"));

    expect(screen.getByTestId("probe-filter-key")).toHaveTextContent("w1");
    expect(screen.getByTestId("probe-filter-ids")).toHaveTextContent("w1-graph-a,w1-graph-b");
  });

  // ── Pill highlight (selection) ──────────────────────────────────────

  it("tag-pill click dispatches SELECT_CLUSTER and the matching pill gains .highlighted", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "Window One",
      cluster_freq: { a: 1 },
      cluster_names: { a: "Cooking" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();
    await screen.findByText("Cooking");

    expect(screen.getByText("Cooking")).not.toHaveClass("highlighted");
    await userEvent.click(screen.getByText("Cooking"));

    await waitFor(() => expect(screen.getByText("Cooking")).toHaveClass("tag-pill highlighted"));
    expect(screen.getByTestId("probe-selected")).toHaveTextContent("a");
  });

  // ── Pill sort order + top-3/overflow ────────────────────────────────

  it("sorts pills by frequency desc, then name asc as a tiebreak", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "Sorted Window",
      cluster_freq: { a: 2, b: 2, c: 1 },
      cluster_names: { a: "Zeta", b: "Alpha", c: "Gamma" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    const { container } = renderPanel();
    await screen.findByText("Sorted Window");

    const pillLabels = Array.from(container.querySelectorAll(".tag-pill")).map((el) => el.textContent);
    expect(pillLabels).toEqual(["Alpha", "Zeta", "Gamma"]);
  });

  it("caps pills at 3 and renders a tag-overflow button for the rest", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "Five Clusters",
      cluster_freq: { a: 5, b: 4, c: 3, d: 2, e: 1 },
      cluster_names: { a: "A", b: "B", c: "C", d: "D", e: "E" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    const { container } = renderPanel();
    await screen.findByText("Five Clusters");

    expect(container.querySelectorAll(".tag-pill")).toHaveLength(3);
    const overflow = container.querySelector(".tag-overflow");
    expect(overflow).toHaveTextContent("+2 more");
  });

  it("renders no overflow button when there are exactly 3 clusters", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "Three Clusters",
      cluster_freq: { a: 1, b: 1, c: 1 },
      cluster_names: { a: "A", b: "B", c: "C" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    const { container } = renderPanel();
    await screen.findByText("Three Clusters");

    expect(container.querySelectorAll(".tag-pill")).toHaveLength(3);
    expect(container.querySelector(".tag-overflow")).not.toBeInTheDocument();
  });

  // ── Summary text branches ───────────────────────────────────────────

  it("summary: <=3 tags joins all names", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "W",
      page_count: 4,
      cluster_freq: { a: 1, b: 1 },
      cluster_names: { a: "Alpha", b: "Beta" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();

    await screen.findByText("Explored Alpha, Beta across 4 pages");
  });

  it("summary: zero tags falls back to 'various topics', plural pages", async () => {
    const w1 = makeWindow({ key: "w1", label: "W", page_count: 2 });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();

    await screen.findByText("Explored various topics across 2 pages");
  });

  it("summary: zero tags + single page uses singular 'page'", async () => {
    const w1 = makeWindow({ key: "w1", label: "W", page_count: 1 });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();

    await screen.findByText("Explored various topics across 1 page");
  });

  it("summary: >3 tags shows top 3 + extra count", async () => {
    const w1 = makeWindow({
      key: "w1",
      label: "W",
      page_count: 10,
      cluster_freq: { a: 5, b: 4, c: 3, d: 2, e: 1 },
      cluster_names: { a: "A", b: "B", c: "C", d: "D", e: "E" },
    });
    vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([w1]);
    renderPanel();

    await screen.findByText("Explored A, B, C and 2 more across 10 pages");
  });

  // ── Refetch behavior ────────────────────────────────────────────────

  it("refetches when granularity changes", async () => {
    const spy = vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);
    const { rerender } = render(
      <NavProvider>
        <DiaryPanel granularity="day" />
        <Probe />
      </NavProvider>
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenNthCalledWith(1, "day", undefined);

    rerender(
      <NavProvider>
        <DiaryPanel granularity="week" />
        <Probe />
      </NavProvider>
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenNthCalledWith(2, "week", undefined);
  });

  it("refetches when nav selection changes, passing the selected id as filterNodeId", async () => {
    const spy = vi.spyOn(apiModule, "fetchDiaryWindows").mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenNthCalledWith(1, "day", undefined);

    await userEvent.click(screen.getByText("probe-select-node"));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenNthCalledWith(2, "day", "probe-node");
  });

  it("does not blank previously-loaded cards while a refetch is in flight", async () => {
    let resolveSecond: (value: DiaryWindow[]) => void = () => {};
    const w1 = makeWindow({ key: "w1", label: "Stays Visible" });
    const spy = vi
      .spyOn(apiModule, "fetchDiaryWindows")
      .mockResolvedValueOnce([w1])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );
    renderPanel();
    await screen.findByText("Stays Visible");

    await userEvent.click(screen.getByText("probe-select-node"));
    // Refetch is now in flight (second mock implementation, unresolved) --
    // the previously-rendered card must still be visible, not replaced by
    // `null`/nothing.
    expect(screen.getByText("Stays Visible")).toBeInTheDocument();

    resolveSecond([w1]);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Stays Visible")).toBeInTheDocument();
  });
});
