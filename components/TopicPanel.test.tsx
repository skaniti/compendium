import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TopicPanel, { type TopicPanelProps } from "./TopicPanel";
import * as apiModule from "@/lib/api";
import { getIconsGrouped } from "@/lib/icons";
import type { TopicInterest } from "@/lib/types";

// Task A1-5: port of graph_canvas.py's #topic-panel add/edit overlay +
// icon picker (:508-568) + callbacks/topics.py's add_topic_server/
// remove_topic/select_icon/toggle_icon_picker + app.py's optimistic-add
// clientside callback (:2932-2988).
//
// IMPORTANT CONTEXT (see task-A1-5-report.md for the full writeup): Dash's
// #topic-panel has had NO live opening affordance since commit 3d4b4b4
// (2026-05-22, "Removed ... 'topics' link from the overlay") -- confirmed
// dead/unreachable via THREE independent sources (toggle_topic_panel's own
// docstring, style.css's plain-demo comment, and that commit's own message).
// Its functionality (add/remove/icon-pick) is otherwise fully covered by
// the already-shipped ScPopover.tsx (02, task 8-C3). This suite still
// covers the panel itself in full per the human-authored mig-03 plan's
// explicit "IN scope ... user-facing graph affordance" framing; the
// opening-affordance wiring (a restored `#topic-toggle-btn`, matching CSS
// already present in app/styles/search-bar.css:648/652/661-662 from an
// earlier batch) lives in GraphCanvas.tsx/GraphCanvas.test.tsx instead.
//
// Unlike ScPopover, this panel is a SINGLE overlay (not per-slot): one
// shared icon-picker-grid retargeted by whichever row's icon button was
// last clicked (toggle_icon_picker's own semantics), no rename affordance
// (Dash's _topic_row/_render_topic_row never had one -- rename is 02's SC
// popover ONLY, brief's hard NO-RENAME rule), no MEMBERS/EXCLUDED section
// (SC-popover-exclusive per spec.md's "NOT in 03" list). Every mutation
// fetcher is mocked per the repo's established convention (vi.spyOn(apiModule, ...)).

function makeTopic(overrides: Partial<TopicInterest> & { keyword: string }): TopicInterest {
  return { icon_id: null, cluster_count: 0, ...overrides };
}

// Real icon ids/categories from lib/icon-data.json (ScPopover.test.tsx's own
// convention) so fixtures can't drift from the actual sidecar.
const [FIRST_CATEGORY, FIRST_CATEGORY_ICONS] = getIconsGrouped()[0];
const ICON_A = FIRST_CATEGORY_ICONS[0]; // this topic's own icon
const ICON_B = FIRST_CATEGORY_ICONS[1]; // another topic's icon
const ICON_C = FIRST_CATEGORY_ICONS[2]; // unused by anyone

function renderPanel(overrides: Partial<TopicPanelProps> = {}) {
  const onClose = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const props: TopicPanelProps = {
    onClose,
    graphVersion: 0,
    refresh,
    ...overrides,
  };
  const result = render(<TopicPanel {...props} />);
  return { ...result, onClose, refresh, props };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TopicPanel", () => {
  it("renders the header title + close button, and fetches topics once on mount", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    renderPanel();

    expect(screen.getByText("Topic Interests")).toBeInTheDocument();
    expect(document.getElementById("topic-panel-close")).toBeInTheDocument();
    await waitFor(() => expect(apiModule.fetchTopics).toHaveBeenCalledTimes(1));
  });

  it("close button calls onClose", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const { onClose } = renderPanel();

    await userEvent.click(document.getElementById("topic-panel-close") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the add row (input + Add button) with Dash's exact placeholder/maxLength", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    expect(input).toHaveAttribute("maxlength", "36");
    expect(screen.getByText("Add")).toHaveClass("topic-add-btn");
  });

  it("empty topics: renders 'No topics yet. Add one above.' inside #topic-list-container", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    renderPanel();

    await waitFor(() => expect(apiModule.fetchTopics).toHaveBeenCalled());
    const container = document.getElementById("topic-list-container");
    expect(container).toHaveTextContent("No topics yet. Add one above.");
  });

  it("renders one row per topic (keyword, icon button, remove button), no empty message", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "Cooking", icon_id: ICON_A }),
      makeTopic({ keyword: "Music", icon_id: ICON_B }),
    ]);
    renderPanel();

    expect(await screen.findByText("Cooking")).toBeInTheDocument();
    expect(screen.getByText("Music")).toBeInTheDocument();
    expect(screen.queryByText("No topics yet. Add one above.")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".topic-icon-btn")).toHaveLength(2);
  });

  // ── No rename affordance (hard parity rule) ─────────────────────────────

  it("never renders a rename input anywhere (NO-RENAME parity rule -- rename lives only in 02's SC popover)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking" })]);
    renderPanel();

    await screen.findByText("Cooking");
    // The keyword is a read-only <span>, never an <input>.
    expect(document.querySelectorAll("input")).toHaveLength(1); // only the ADD input
    expect((document.querySelectorAll("input")[0] as HTMLInputElement).placeholder).toBe("e.g. Earth Science");
  });

  // ── Add ──────────────────────────────────────────────────────────────────

  it("add: Enter and the Add button both submit the trimmed keyword", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const addSpy = vi.spyOn(apiModule, "addTopic").mockResolvedValue([]);
    renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science") as HTMLInputElement;
    await userEvent.type(input, "  Earth Science{Enter}");
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("Earth Science"));

    addSpy.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, "Cooking");
    await userEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("Cooking"));
  });

  it("add: clears the input immediately (Dash's clientside optimistic-add callback)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    vi.spyOn(apiModule, "addTopic").mockResolvedValue([]);
    renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science") as HTMLInputElement;
    await userEvent.type(input, "Earth Science{Enter}");
    expect(input.value).toBe("");
  });

  it("add: empty/whitespace input is a no-op (no fetch)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const addSpy = vi.spyOn(apiModule, "addTopic");
    renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "   {Enter}");

    expect(addSpy).not.toHaveBeenCalled();
  });

  it("add: duplicate keyword (case-insensitive) is a client-side no-op (no fetch)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Music" })]);
    const addSpy = vi.spyOn(apiModule, "addTopic");
    renderPanel();

    await screen.findByText("Music");
    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "MUSIC{Enter}");

    expect(addSpy).not.toHaveBeenCalled();
  });

  it("add: success refetches + refreshes but does NOT close the panel (Dash: add_topic_server has no panel-style output)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    vi.spyOn(apiModule, "addTopic").mockResolvedValue([]);
    const { onClose, refresh } = renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "Earth Science{Enter}");

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(apiModule.fetchTopics).toHaveBeenCalledTimes(2); // mount + post-add refetch
    expect(onClose).not.toHaveBeenCalled();
  });

  it("add: shows an optimistic loading row (spinner + dimmed keyword) while the request is in flight", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    let resolveAdd!: (value: TopicInterest[]) => void;
    const addPromise = new Promise<TopicInterest[]>((resolve) => {
      resolveAdd = resolve;
    });
    vi.spyOn(apiModule, "addTopic").mockReturnValue(addPromise);
    renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "Earth Science{Enter}");

    expect(screen.getByText("Earth Science")).toBeInTheDocument();
    expect(document.querySelector(".topic-spinner")).toBeInTheDocument();

    resolveAdd([]);
    await waitFor(() => expect(document.querySelector(".topic-spinner")).not.toBeInTheDocument());
  });

  it("add: API rejection is swallowed -- no crash, panel stays open, no refresh/refetch bump", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    vi.spyOn(apiModule, "addTopic").mockRejectedValue(new Error("boom"));
    const { onClose, refresh } = renderPanel();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "Earth Science{Enter}");

    await waitFor(() => expect(document.querySelector(".topic-spinner")).not.toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── Remove ───────────────────────────────────────────────────────────────

  it("remove: clicking a row's x calls removeTopic, refetches, and refreshes", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking" })]);
    const removeSpy = vi.spyOn(apiModule, "removeTopic").mockResolvedValue([]);
    const { refresh } = renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector("#topic-list-container button") as HTMLElement);

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("Cooking"));
    await waitFor(() => expect(apiModule.fetchTopics).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("remove: API rejection is swallowed -- no crash, no refresh", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking" })]);
    vi.spyOn(apiModule, "removeTopic").mockRejectedValue(new Error("boom"));
    const { refresh } = renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector("#topic-list-container button") as HTMLElement);

    await waitFor(() => expect(apiModule.removeTopic).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText("Cooking")).toBeInTheDocument();
  });

  // ── Icon picker ──────────────────────────────────────────────────────────

  it("icon picker: hidden until a row's icon button is clicked", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    renderPanel();

    await screen.findByText("Cooking");
    expect(document.getElementById("icon-picker-grid")).not.toHaveClass("show");
    expect(document.querySelectorAll(".icon-pick-cell")).toHaveLength(0);
  });

  it("icon picker: clicking a row's icon button opens it, rendering every category + icon from getIconsGrouped()", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);

    const grouped = getIconsGrouped();
    const totalIcons = grouped.reduce((n, [, ids]) => n + ids.length, 0);
    expect(document.getElementById("icon-picker-grid")).toHaveClass("show");
    const sections = Array.from(document.querySelectorAll(".icon-picker-category-section"));
    expect(sections.map((s) => s.querySelector(".icon-picker-category-header")?.textContent)).toEqual(
      grouped.map(([category]) => category)
    );
    expect(document.querySelectorAll(".icon-pick-cell")).toHaveLength(totalIcons);
    expect(sections[0]).toHaveTextContent(FIRST_CATEGORY);
  });

  it("icon picker: clicking the SAME row's icon button again closes it (toggle)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    renderPanel();

    await screen.findByText("Cooking");
    const iconBtn = document.querySelector(".topic-icon-btn") as HTMLElement;
    await userEvent.click(iconBtn);
    expect(document.getElementById("icon-picker-grid")).toHaveClass("show");

    await userEvent.click(iconBtn);
    expect(document.getElementById("icon-picker-grid")).not.toHaveClass("show");
    expect(document.querySelectorAll(".icon-pick-cell")).toHaveLength(0);
  });

  it("icon picker: clicking a DIFFERENT row's icon button re-targets without needing to close first", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "Cooking", icon_id: ICON_A }),
      makeTopic({ keyword: "Music", icon_id: ICON_B }),
    ]);
    renderPanel();

    await screen.findByText("Cooking");
    const iconBtns = document.querySelectorAll(".topic-icon-btn");
    await userEvent.click(iconBtns[0] as HTMLElement);
    expect(document.querySelector(`.icon-pick-cell[title="${ICON_A}"]`)).toHaveClass("active");

    await userEvent.click(iconBtns[1] as HTMLElement);
    expect(document.getElementById("icon-picker-grid")).toHaveClass("show");
    expect(document.querySelector(`.icon-pick-cell[title="${ICON_B}"]`)).toHaveClass("active");
    expect(document.querySelector(`.icon-pick-cell[title="${ICON_A}"]`)).not.toHaveClass("active");
  });

  it("icon picker: active/used classes reflect this topic's own icon vs. another topic's", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "Cooking", icon_id: ICON_A }),
      makeTopic({ keyword: "Music", icon_id: ICON_B }),
    ]);
    renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);

    const cellFor = (iconId: string) => document.querySelector(`.icon-pick-cell[title="${iconId}"]`) as HTMLElement;
    expect(cellFor(ICON_A)).toHaveClass("active");
    expect(cellFor(ICON_A)).not.toHaveClass("icon-pick-used");
    expect(cellFor(ICON_B)).toHaveClass("icon-pick-used");
    expect(cellFor(ICON_B)).not.toHaveClass("active");
    expect(cellFor(ICON_C)).not.toHaveClass("active");
    expect(cellFor(ICON_C)).not.toHaveClass("icon-pick-used");
  });

  it("icon picker: clicking a used cell is a no-op", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([
      makeTopic({ keyword: "Cooking", icon_id: ICON_A }),
      makeTopic({ keyword: "Music", icon_id: ICON_B }),
    ]);
    const setIconSpy = vi.spyOn(apiModule, "setTopicIcon");
    renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);
    await userEvent.click(document.querySelector(`.icon-pick-cell[title="${ICON_B}"]`) as HTMLElement);

    expect(setIconSpy).not.toHaveBeenCalled();
  });

  it("icon picker: clicking the already-active cell is a no-op", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    const setIconSpy = vi.spyOn(apiModule, "setTopicIcon");
    renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);
    await userEvent.click(document.querySelector(`.icon-pick-cell[title="${ICON_A}"]`) as HTMLElement);

    expect(setIconSpy).not.toHaveBeenCalled();
  });

  it("icon picker: selecting an unused icon calls setTopicIcon + refetch + refresh, then closes the picker", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    vi.spyOn(apiModule, "setTopicIcon").mockResolvedValue([]);
    const { refresh } = renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);
    await userEvent.click(document.querySelector(`.icon-pick-cell[title="${ICON_C}"]`) as HTMLElement);

    await waitFor(() => expect(apiModule.setTopicIcon).toHaveBeenCalledWith("Cooking", ICON_C));
    await waitFor(() => expect(apiModule.fetchTopics).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.getElementById("icon-picker-grid")).not.toHaveClass("show"));
  });

  it("icon picker: the cell's svg inherits stroke (theme-driven, same idiom as ScPopover)", async () => {
    vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([makeTopic({ keyword: "Cooking", icon_id: ICON_A })]);
    renderPanel();

    await screen.findByText("Cooking");
    await userEvent.click(document.querySelector(".topic-icon-btn") as HTMLElement);

    const cell = document.querySelector(`.icon-pick-cell[title="${ICON_C}"]`) as HTMLElement;
    const svg = cell.querySelector("svg.icon-pick-glyph") as SVGElement;
    expect(svg).toBeInTheDocument();
    const path = svg.querySelector("path") as SVGPathElement;
    expect(path.getAttribute("stroke")).toBe("inherit");
  });

  // ── graphVersion-driven refetch ─────────────────────────────────────────

  it("refetches topics whenever graphVersion changes (stays in sync with mutations made via the SC popover)", async () => {
    const fetchSpy = vi.spyOn(apiModule, "fetchTopics").mockResolvedValue([]);
    const { rerender, props } = renderPanel({ graphVersion: 0 });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    rerender(<TopicPanel {...props} graphVersion={1} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });
});
