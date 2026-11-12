import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScPopover, { type ScPopoverProps } from "./ScPopover";
import * as apiModule from "@/lib/api";
import { getIconsGrouped } from "@/lib/icons";
import type { MemberExclusion, TopicInterest, TopicMember, TopicSuggestion } from "@/lib/types";

// Ports topics.py's _render_sc_popover / _render_sc_icon_picker_flat + the
// sc_add/sc_delete/sc_rename/sc_select_icon/sc_exclude_member/
// sc_restore_member callbacks, plus sc_popover_position.js's Esc/outside-click
// dismissal, into a JSX-parity suite (Task 8-C3). All fixtures synthetic.
// Every mutation fetcher is mocked per the repo's established convention
// (HeaderCards.test.tsx / TopicDetail.test.tsx: vi.spyOn(apiModule, ...)).
//
// ScPopover self-portals into #sc-popovers-portal (a plain DOM node this
// suite creates/tears down itself, since AppShell -- the real owner -- isn't
// mounted here); RTL's auto-cleanup unmounts the React-rendered portal
// CONTENT but not that manually-appended container node, so it's torn down
// explicitly in afterEach.

function makeTopic(overrides: Partial<TopicInterest> & { keyword: string }): TopicInterest {
  return { icon_id: null, cluster_count: 0, ...overrides };
}

function makeMember(overrides: Partial<TopicMember> & { cluster_name: string }): TopicMember {
  return { page_count: 1, mean_membership_probability: 0.5, ...overrides };
}

function makeExclusion(overrides: Partial<MemberExclusion> & { keyword: string; cluster_name: string }): MemberExclusion {
  return { cluster_slug: overrides.cluster_name.toLowerCase().replace(/\s+/g, "-"), created_at: "2026-01-01T00:00:00", ...overrides };
}

// Real icon ids/categories from lib/icon-data.json (read via getIconsGrouped()
// itself rather than hardcoded strings, so this can't drift from the actual
// sidecar) -- the first category's first three icons, alphabetically sorted
// within that category.
const [FIRST_CATEGORY, FIRST_CATEGORY_ICONS] = getIconsGrouped()[0];
const ICON_A = FIRST_CATEGORY_ICONS[0]; // this topic's own icon
const ICON_B = FIRST_CATEGORY_ICONS[1]; // another topic's icon
const ICON_C = FIRST_CATEGORY_ICONS[2]; // unused by anyone

let portal: HTMLDivElement;

function makeSuggestion(overrides: Partial<TopicSuggestion> & { id: number; label: string }): TopicSuggestion {
  return {
    source: "suggested", topic: null, topic_similarity: null, interest_tier: "core",
    evidence: { n_weeks: 13, span_days: 210 }, member_count: 9, page_count: 82,
    cluster_ids: [], cluster_names: Array.from({ length: 9 }, (_, i) => `Member cluster ${i + 1}`),
    split_proposal: null, cluster_slugs: [], ...overrides,
  };
}

function mockMemberFetches(members: TopicMember[] = [], exclusions: MemberExclusion[] = []) {
  vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue(members);
  vi.spyOn(apiModule, "fetchMemberExclusions").mockResolvedValue(exclusions);
}

function renderPopover(overrides: Partial<ScPopoverProps> = {}) {
  const onClose = vi.fn();
  const refetchTopics = vi.fn();
  const refreshGraph = vi.fn().mockResolvedValue(undefined);
  const refetchSuggestions = vi.fn();
  const refetchStatus = vi.fn();
  const props: ScPopoverProps = {
    slot: 0,
    topic: undefined,
    topics: [],
    onClose,
    refetchTopics,
    refreshGraph,
    suggestions: [],
    refetchSuggestions,
    refetchStatus,
    demoLocked: false,
    plainDemo: false,
    ...overrides,
  };
  const result = render(<ScPopover {...props} />);
  return { ...result, onClose, refetchTopics, refreshGraph, refetchSuggestions, refetchStatus, props };
}

describe("ScPopover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    portal = document.createElement("div");
    portal.id = "sc-popovers-portal";
    document.body.appendChild(portal);
  });

  afterEach(() => {
    portal.remove();
  });

  it("renders nothing when #sc-popovers-portal is absent from the DOM", () => {
    portal.remove();
    const { container } = renderPopover();
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector(".hbar-sc-popover")).not.toBeInTheDocument();
  });

  // ── Empty slot: ADD flow ────────────────────────────────────────────────

  it("empty slot: renders the ADD SUPERCLUSTER form", () => {
    renderPopover({ topic: undefined });
    expect(screen.getByText("ADD SUPERCLUSTER")).toHaveClass("hbar-sc-popover-title");
    const input = screen.getByPlaceholderText("e.g. Earth Science");
    expect(input).toHaveClass("hbar-sc-input");
    expect(input).toHaveAttribute("maxlength", "36");
    expect(screen.getByText("Add")).toHaveClass("hbar-sc-add-btn");
  });

  it("add: Enter and the Add button both submit the same trimmed keyword", async () => {
    const addSpy = vi.spyOn(apiModule, "addTopic").mockResolvedValue([]);
    const { refetchTopics, refreshGraph } = renderPopover({ topics: [] });

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "  Earth Science{Enter}");
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("Earth Science"));
    await waitFor(() => expect(refetchTopics).toHaveBeenCalledTimes(1));
    expect(refreshGraph).toHaveBeenCalledTimes(1);

    addSpy.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, "Cooking");
    await userEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("Cooking"));
  });

  it("add: empty/whitespace input is a no-op (no fetch, no close)", async () => {
    const addSpy = vi.spyOn(apiModule, "addTopic");
    const { onClose } = renderPopover();

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "   {Enter}");

    expect(addSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("add: duplicate keyword (case-insensitive) closes WITHOUT adding", async () => {
    const addSpy = vi.spyOn(apiModule, "addTopic");
    const { onClose } = renderPopover({ topics: [makeTopic({ keyword: "Music" })] });

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "MUSIC{Enter}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("add: shows the spinner while pending, then closes + refetches + refreshes on success", async () => {
    let resolveAdd!: (value: TopicInterest[]) => void;
    const addPromise = new Promise<TopicInterest[]>((resolve) => {
      resolveAdd = resolve;
    });
    vi.spyOn(apiModule, "addTopic").mockReturnValue(addPromise);
    const { onClose, refetchTopics, refreshGraph } = renderPopover();

    const spinner = document.querySelector(".hbar-sc-popover-spinner") as HTMLElement;
    expect(spinner.style.display).toBe("none");

    const input = screen.getByPlaceholderText("e.g. Earth Science");
    await userEvent.type(input, "Earth Science{Enter}");

    expect(spinner.style.display).toBe("inline-block");
    expect(onClose).not.toHaveBeenCalled();

    resolveAdd([]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(refreshGraph).toHaveBeenCalledTimes(1);
    expect(spinner.style.display).toBe("none");
  });

  // ── Allocated slot: rename ──────────────────────────────────────────────

  it("rename: empty and unchanged (case-insensitive) input are no-ops", async () => {
    mockMemberFetches();
    const renameSpy = vi.spyOn(apiModule, "renameTopic");
    const topic = makeTopic({ keyword: "Cooking" });
    renderPopover({ topic, topics: [topic] });

    const input = document.querySelector(".hbar-sc-rename-row .hbar-sc-input") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "{Enter}");
    expect(renameSpy).not.toHaveBeenCalled();

    await userEvent.type(input, "COOKING{Enter}");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("rename: success refetches + refreshes but keeps the popover open (no close, no spinner)", async () => {
    mockMemberFetches();
    vi.spyOn(apiModule, "renameTopic").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking" });
    const { onClose, refetchTopics, refreshGraph } = renderPopover({ topic, topics: [topic] });

    const input = document.querySelector(".hbar-sc-rename-row .hbar-sc-input") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "Baking{Enter}");

    await waitFor(() => expect(refetchTopics).toHaveBeenCalledTimes(1));
    expect(refreshGraph).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // Rename never drives the spinner (Dash: sc_rename_topic has no `running=`).
    const spinner = document.querySelector(".hbar-sc-rename-row .hbar-sc-popover-spinner") as HTMLElement;
    expect(spinner.style.display).toBe("none");
  });

  // ── Allocated slot: delete ──────────────────────────────────────────────

  it("delete: shows the spinner while pending, then closes + refetches + refreshes on success", async () => {
    mockMemberFetches();
    let resolveDelete!: (value: TopicInterest[]) => void;
    const deletePromise = new Promise<TopicInterest[]>((resolve) => {
      resolveDelete = resolve;
    });
    vi.spyOn(apiModule, "removeTopic").mockReturnValue(deletePromise);
    const topic = makeTopic({ keyword: "Cooking" });
    const { onClose, refetchTopics, refreshGraph } = renderPopover({ topic, topics: [topic] });

    const deleteBtn = screen.getByRole("button", { name: "Delete supercluster" });
    await userEvent.click(deleteBtn);

    const spinner = document.querySelector(".hbar-sc-rename-row .hbar-sc-popover-spinner") as HTMLElement;
    expect(spinner.style.display).toBe("inline-block");
    expect(onClose).not.toHaveBeenCalled();

    resolveDelete([]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });

  // ── Icon picker ──────────────────────────────────────────────────────────

  it("icon picker: renders every category + icon from getIconsGrouped(), in order", async () => {
    mockMemberFetches();
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    renderPopover({ topic, topics: [topic] });

    const grouped = getIconsGrouped();
    const totalIcons = grouped.reduce((n, [, ids]) => n + ids.length, 0);
    const sections = Array.from(document.querySelectorAll(".hbar-sc-pick-section"));
    const cells = Array.from(document.querySelectorAll(".hbar-sc-pick-cell"));

    expect(sections.map((s) => s.textContent)).toEqual(grouped.map(([category]) => category));
    expect(cells).toHaveLength(totalIcons);
    expect(sections[0]).toHaveTextContent(FIRST_CATEGORY);
  });

  it("icon picker: active/used classes reflect this topic's own icon vs. another topic's", async () => {
    mockMemberFetches();
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    const other = makeTopic({ keyword: "Music", icon_id: ICON_B });
    renderPopover({ topic, topics: [topic, other] });

    const cellFor = (iconId: string) => document.querySelector(`.hbar-sc-pick-cell[aria-label="${iconId}"]`) as HTMLElement;

    expect(cellFor(ICON_A)).toHaveClass("hbar-sc-pick-cell active");
    expect(cellFor(ICON_A)).not.toHaveClass("used");
    expect(cellFor(ICON_B)).toHaveClass("hbar-sc-pick-cell used");
    expect(cellFor(ICON_B)).not.toHaveClass("active");
    expect(cellFor(ICON_C)).toHaveClass("hbar-sc-pick-cell");
    expect(cellFor(ICON_C)).not.toHaveClass("active");
    expect(cellFor(ICON_C)).not.toHaveClass("used");
  });

  it("icon picker: the cell's svg inherits stroke (parity with the hydrated sprite)", async () => {
    mockMemberFetches();
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    renderPopover({ topic, topics: [topic] });

    const cell = document.querySelector(`.hbar-sc-pick-cell[aria-label="${ICON_C}"]`) as HTMLElement;
    const svg = cell.querySelector("svg.hbar-sc-pick-glyph") as SVGElement;
    expect(svg).toBeInTheDocument();
    const path = svg.querySelector("path") as SVGPathElement;
    expect(path.getAttribute("stroke")).toBe("inherit");
  });

  it("icon picker: clicking a used cell is a no-op", async () => {
    mockMemberFetches();
    const setIconSpy = vi.spyOn(apiModule, "setTopicIcon");
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    const other = makeTopic({ keyword: "Music", icon_id: ICON_B });
    const { refetchTopics } = renderPopover({ topic, topics: [topic, other] });

    await userEvent.click(document.querySelector(`.hbar-sc-pick-cell[aria-label="${ICON_B}"]`) as HTMLElement);

    expect(setIconSpy).not.toHaveBeenCalled();
    expect(refetchTopics).not.toHaveBeenCalled();
  });

  it("icon picker: selecting an unused icon calls setTopicIcon + refetch + refresh, and stays open", async () => {
    mockMemberFetches();
    vi.spyOn(apiModule, "setTopicIcon").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    const { onClose, refetchTopics, refreshGraph } = renderPopover({ topic, topics: [topic] });

    await userEvent.click(document.querySelector(`.hbar-sc-pick-cell[aria-label="${ICON_C}"]`) as HTMLElement);

    await waitFor(() => expect(apiModule.setTopicIcon).toHaveBeenCalledWith("Cooking", ICON_C));
    expect(refetchTopics).toHaveBeenCalledTimes(1);
    expect(refreshGraph).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── MEMBERS / EXCLUDED ───────────────────────────────────────────────────

  it("members: fetches with the SC_POPOVER_MEMBER_CAP (50) and renders rows", async () => {
    const membersSpy = vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([
      makeMember({ cluster_name: "Sourdough" }),
      makeMember({ cluster_name: "Knife Skills" }),
    ]);
    vi.spyOn(apiModule, "fetchMemberExclusions").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 2 });
    renderPopover({ topic, topics: [topic] });

    await waitFor(() => expect(membersSpy).toHaveBeenCalledWith("Cooking", 50));
    expect(await screen.findByText("Sourdough")).toBeInTheDocument();
    expect(screen.getByText("Knife Skills")).toBeInTheDocument();
    expect(document.querySelectorAll(".hbar-sc-member-row")).toHaveLength(2);
  });

  it("members: zero members renders the empty state instead of a list", async () => {
    mockMemberFetches([], []);
    const topic = makeTopic({ keyword: "Cooking" });
    renderPopover({ topic, topics: [topic] });

    expect(await screen.findByText("no clusters in the latest run")).toHaveClass("hbar-sc-tooltip-empty");
  });

  it("exclude: calls addMemberExclusion, refetches members+exclusions, and refreshes the graph", async () => {
    const membersSpy = vi
      .spyOn(apiModule, "fetchTopicMembers")
      .mockResolvedValue([makeMember({ cluster_name: "Sourdough" })]);
    vi.spyOn(apiModule, "fetchMemberExclusions").mockResolvedValue([]);
    const excludeSpy = vi.spyOn(apiModule, "addMemberExclusion").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 1 });
    const { refreshGraph } = renderPopover({ topic, topics: [topic] });

    await screen.findByText("Sourdough");
    expect(membersSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Exclude Sourdough" }));

    await waitFor(() => expect(excludeSpy).toHaveBeenCalledWith("Cooking", "Sourdough"));
    await waitFor(() => expect(membersSpy).toHaveBeenCalledTimes(2));
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });

  it("allocated body: no native title= anywhere; controls are labelled and hover shows the chart-kit tooltip", async () => {
    mockMemberFetches(
      [makeMember({ cluster_name: "Sourdough" })],
      [makeExclusion({ keyword: "Cooking", cluster_name: "Burnt Toast" })]
    );
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 1 });
    renderPopover({ topic, topics: [topic] });
    await screen.findByText("Sourdough");
    await screen.findByText("Burnt Toast");

    expect(document.querySelectorAll(".hbar-sc-popover [title]")).toHaveLength(0);

    const hover = (el: HTMLElement) => fireEvent.mouseEnter(el, { clientX: 20, clientY: 20 });
    const expectTip = (el: HTMLElement, text: string | RegExp) => {
      hover(el);
      expect(screen.getByRole("tooltip")).toHaveTextContent(text);
      fireEvent.mouseLeave(el);
      expect(screen.queryByRole("tooltip")).toBeNull();
    };
    expectTip(screen.getByRole("button", { name: "Delete supercluster" }), "Delete supercluster");
    expectTip(screen.getByRole("button", { name: "Exclude Sourdough" }), /Doesn't belong here/);
    expectTip(screen.getByRole("button", { name: "Restore Burnt Toast" }), /Restore -- eligible/);
    expectTip(screen.getByText("Sourdough"), "Sourdough"); // the name is ellipsised in the narrow list
    expectTip(screen.getByRole("button", { name: ICON_A }), ICON_A);
  });

  it("icon cells are keyboard-reachable: Enter picks an unused icon", async () => {
    mockMemberFetches();
    const setSpy = vi.spyOn(apiModule, "setTopicIcon").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    renderPopover({ topic, topics: [topic] });

    const cell = screen.getByRole("button", { name: ICON_C });
    cell.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("Cooking", ICON_C));
  });

  it("excluded section: only renders when this keyword has exclusions (case/keyword filtered)", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    vi.spyOn(apiModule, "fetchMemberExclusions").mockResolvedValue([
      makeExclusion({ keyword: "cooking", cluster_name: "Burnt Toast" }),
      makeExclusion({ keyword: "music", cluster_name: "Off Topic" }),
    ]);
    const topic = makeTopic({ keyword: "Cooking" });
    renderPopover({ topic, topics: [topic] });

    expect(await screen.findByText("EXCLUDED")).toBeInTheDocument();
    expect(screen.getByText("Burnt Toast")).toBeInTheDocument();
    expect(screen.queryByText("Off Topic")).not.toBeInTheDocument();
  });

  it("restore: calls removeMemberExclusion, refetches members+exclusions ONLY (no graph refresh)", async () => {
    const exclusionsSpy = vi
      .spyOn(apiModule, "fetchMemberExclusions")
      .mockResolvedValue([makeExclusion({ keyword: "Cooking", cluster_name: "Burnt Toast" })]);
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const restoreSpy = vi.spyOn(apiModule, "removeMemberExclusion").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking" });
    const { refreshGraph } = renderPopover({ topic, topics: [topic] });

    await screen.findByText("Burnt Toast");
    expect(exclusionsSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Restore Burnt Toast" }));

    await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith("Cooking", "Burnt Toast"));
    await waitFor(() => expect(exclusionsSpy).toHaveBeenCalledTimes(2));
    expect(refreshGraph).not.toHaveBeenCalled();
  });

  // ── Escape / outside click ───────────────────────────────────────────────

  it("Escape closes the popover and stops propagation (capture phase)", async () => {
    const { onClose } = renderPopover();
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bubbleListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubbleListener);
  });

  it("a non-Escape key is a no-op", () => {
    const { onClose } = renderPopover();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("outside click closes; clicks inside the portal or on a tile do not", async () => {
    const tile = document.createElement("div");
    tile.className = "hbar-sc-tile";
    tile.setAttribute("data-sc-tile-slot", "0");
    document.body.appendChild(tile);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    const { onClose } = renderPopover();

    await userEvent.click(screen.getByText("ADD SUPERCLUSTER")); // inside the portal
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(tile);
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(outside);
    expect(onClose).toHaveBeenCalledTimes(1);

    tile.remove();
    outside.remove();
  });

  // ── Positioning ──────────────────────────────────────────────────────────

  it("positions below its tile, clamped at the right edge", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });

    const tile = document.createElement("div");
    tile.setAttribute("data-sc-tile-slot", "0");
    document.body.appendChild(tile);

    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const base = { x: 0, y: 0, toJSON: () => ({}) };
      if (this === tile) {
        return { ...base, top: 100, left: 900, bottom: 130, right: 931, width: 31, height: 30 } as DOMRect;
      }
      if (this.classList.contains("hbar-sc-popover")) {
        return { ...base, top: 0, left: 0, bottom: 0, right: 240, width: 240, height: 300 } as DOMRect;
      }
      return { ...base, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });

    renderPopover({ slot: 0 });

    const popover = document.querySelector(".hbar-sc-popover") as HTMLElement;
    // top = tileRect.bottom (130) + 8 = 138.
    expect(popover.style.top).toBe("138px");
    // maxLeft = 1000 - 240 - 8 = 752; tileRect.left (900) > maxLeft, so
    // left clamps to max(8, 752) = 752.
    expect(popover.style.left).toBe("752px");

    rectSpy.mockRestore();
    tile.remove();
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });
});

describe("ScPopover: suggested superclusters", () => {
  const LIT = makeSuggestion({ id: 11, label: "Literature" });
  const JAPAN = makeSuggestion({ id: 12, label: "Japan", member_count: 2, page_count: 19, evidence: { n_weeks: 4, span_days: 40 }, cluster_names: ["Kyoto", "Edo period"] });
  const SUGGS = [LIT, JAPAN];

  beforeEach(() => {
    vi.restoreAllMocks();
    portal = document.createElement("div");
    portal.id = "sc-popovers-portal";
    document.body.appendChild(portal);
    mockMemberFetches();
  });

  afterEach(() => {
    portal.remove();
  });

  it("suggestion state: title, editable name prefilled, reason line, members (8 + N more), Add and Not interested", () => {
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    expect(screen.getByText("SUGGESTED SUPERCLUSTER")).toBeInTheDocument();
    expect(screen.getByLabelText("Supercluster name")).toHaveValue("Literature");
    expect(screen.getByText("9 clusters · 82 pages · active in 13 weeks over 7 months")).toBeInTheDocument();
    expect(screen.getByText("MEMBERS")).toBeInTheDocument();
    expect(screen.getAllByText(/^Member cluster/)).toHaveLength(8);
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Not interested" })).toBeEnabled();
  });

  it("reason line leaves the active-in part out when the evidence lacks the numbers, and short spans read in days", () => {
    const { unmount } = renderPopover({ suggestions: [makeSuggestion({ id: 1, label: "X", evidence: {} })], initialSuggestionId: 1 });
    expect(screen.getByText("9 clusters · 82 pages")).toBeInTheDocument();
    unmount();
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 12 });
    expect(screen.getByText("2 clusters · 19 pages · active in 4 weeks over 40 days")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("Add with the name unchanged posts accept without a keyword override, then refetches and closes", async () => {
    const acceptSpy = vi.spyOn(apiModule, "acceptTopicSuggestion").mockResolvedValue([]);
    const { onClose, refetchTopics, refetchSuggestions, refreshGraph } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(acceptSpy).toHaveBeenCalledWith(11, undefined);
    expect(refetchTopics).toHaveBeenCalled();
    expect(refetchSuggestions).toHaveBeenCalled();
    expect(refreshGraph).toHaveBeenCalled();
  });

  it("Add with an edited name sends that name (trimmed)", async () => {
    const acceptSpy = vi.spyOn(apiModule, "acceptTopicSuggestion").mockResolvedValue([]);
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    const input = screen.getByLabelText("Supercluster name");
    await userEvent.clear(input);
    await userEvent.type(input, "  books ");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(acceptSpy).toHaveBeenCalledWith(11, "books"));
  });

  it("Enter in the name field adds; an empty name disables Add and Enter does nothing", async () => {
    const acceptSpy = vi.spyOn(apiModule, "acceptTopicSuggestion").mockResolvedValue([]);
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    const input = screen.getByLabelText("Supercluster name");
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.type(input, "{Enter}");
    expect(acceptSpy).not.toHaveBeenCalled();

    await userEvent.type(input, "Books{Enter}");
    await waitFor(() => expect(acceptSpy).toHaveBeenCalledWith(11, "Books"));
  });

  it("a failed Add shows the error in the popover, keeps it open and does not refetch", async () => {
    vi.spyOn(apiModule, "acceptTopicSuggestion").mockRejectedValue(new Error("acceptTopicSuggestion failed: 500 Server Error"));
    const { onClose, refetchTopics } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent('Could not add "Literature": acceptTopicSuggestion failed: 500 Server Error');
    expect(onClose).not.toHaveBeenCalled();
    expect(refetchTopics).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("Not interested posts dismiss, refetches suggestions and status (not the graph), and closes", async () => {
    const dismissSpy = vi.spyOn(apiModule, "dismissTopicSuggestion").mockResolvedValue(undefined);
    const { onClose, refetchSuggestions, refetchStatus, refreshGraph, refetchTopics } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.click(screen.getByRole("button", { name: "Not interested" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dismissSpy).toHaveBeenCalledWith(11);
    expect(refetchSuggestions).toHaveBeenCalled();
    expect(refetchStatus).toHaveBeenCalled();
    expect(refreshGraph).not.toHaveBeenCalled();
    expect(refetchTopics).not.toHaveBeenCalled();
  });

  it("a failed Not interested shows the error and keeps the popover open", async () => {
    vi.spyOn(apiModule, "dismissTopicSuggestion").mockRejectedValue(new Error("dismissTopicSuggestion failed: 404 Not Found"));
    const { onClose } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.click(screen.getByRole("button", { name: "Not interested" }));

    expect(await screen.findByRole("alert")).toHaveTextContent('Could not dismiss "Literature"');
    expect(onClose).not.toHaveBeenCalled();
  });

  it("plus popover: the add form plus a SUGGESTED list (name left, clusters and pages right)", () => {
    renderPopover({ suggestions: SUGGS });

    expect(screen.getByText("ADD SUPERCLUSTER")).toBeInTheDocument();
    expect(screen.getByText("SUGGESTED")).toBeInTheDocument();
    const rows = document.querySelectorAll(".hbar-sc-sugg-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Literature");
    expect(rows[0]).toHaveTextContent("9 clusters · 82 pages");
    expect(rows[1]).toHaveTextContent("Japan");
    expect(rows[1]).toHaveTextContent("2 clusters · 19 pages");
  });

  it("plus popover: no SUGGESTED list when there are no suggestions", () => {
    renderPopover({ suggestions: [] });
    expect(screen.queryByText("SUGGESTED")).toBeNull();
    expect(document.querySelector(".hbar-sc-sugg-list")).toBeNull();
  });

  it("clicking a list row switches the popover to that suggestion", async () => {
    renderPopover({ suggestions: SUGGS });

    await userEvent.click(document.querySelectorAll(".hbar-sc-sugg-row")[1] as HTMLElement);

    expect(screen.getByText("SUGGESTED SUPERCLUSTER")).toBeInTheDocument();
    expect(screen.getByLabelText("Supercluster name")).toHaveValue("Japan");
    expect(screen.queryByText("ADD SUPERCLUSTER")).toBeNull();
  });

  it("allocated popover: no footer while a slot is still free", () => {
    const topics = Array.from({ length: 23 }, (_, i) => makeTopic({ keyword: `t${i}` }));
    renderPopover({ slot: 0, topic: topics[0], topics, suggestions: SUGGS });
    expect(screen.queryByText(/^SUGGESTED \(/)).toBeNull();
  });

  it("allocated popover with every slot full: quiet SUGGESTED (m) footer that switches to the list, with a way back", async () => {
    const topics = Array.from({ length: 24 }, (_, i) => makeTopic({ keyword: `t${i}` }));
    renderPopover({ slot: 0, topic: topics[0], topics, suggestions: SUGGS });

    await userEvent.click(screen.getByText("SUGGESTED (2)"));
    expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);

    await userEvent.click(screen.getByText("‹ Back"));
    expect(screen.getByText("SUGGESTED (2)")).toBeInTheDocument();
  });

  it("allocated popover with every slot full and no suggestions: footer hidden", () => {
    const topics = Array.from({ length: 24 }, (_, i) => makeTopic({ keyword: `t${i}` }));
    renderPopover({ slot: 0, topic: topics[0], topics, suggestions: [] });
    expect(screen.queryByText(/^SUGGESTED \(/)).toBeNull();
  });

  it("the suggestion state always carries a back link: to the add form plus list from a free slot", async () => {
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.click(screen.getByRole("button", { name: "‹ SUGGESTED" }));

    expect(screen.getByText("ADD SUPERCLUSTER")).toBeInTheDocument();
    expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);
  });

  it("the back link from an allocated slot's suggestion goes to the list view", async () => {
    const topics = Array.from({ length: 24 }, (_, i) => makeTopic({ keyword: `t${i}` }));
    renderPopover({ slot: 0, topic: topics[0], topics, suggestions: SUGGS });
    await userEvent.click(screen.getByText("SUGGESTED (2)"));
    await userEvent.click(document.querySelectorAll(".hbar-sc-sugg-row")[0] as HTMLElement);
    expect(screen.getByText("SUGGESTED SUPERCLUSTER")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "‹ SUGGESTED" }));
    expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);
    expect(screen.queryByText("SUGGESTED SUPERCLUSTER")).toBeNull();
  });

  it("when the open suggestion disappears from the list it falls back to the slot's own body, not a dead suggestion", () => {
    const props = {
      slot: 0, topic: undefined, topics: [] as TopicInterest[], onClose: vi.fn(), refetchTopics: vi.fn(),
      refreshGraph: vi.fn().mockResolvedValue(undefined), refetchSuggestions: vi.fn(), refetchStatus: vi.fn(),
      demoLocked: false, plainDemo: false, initialSuggestionId: 11,
    };
    const { rerender } = render(<ScPopover {...props} suggestions={SUGGS} />);
    expect(screen.getByText("SUGGESTED SUPERCLUSTER")).toBeInTheDocument();

    rerender(<ScPopover {...props} suggestions={[JAPAN]} />);

    expect(screen.queryByText("SUGGESTED SUPERCLUSTER")).toBeNull();
    expect(screen.getByText("ADD SUPERCLUSTER")).toBeInTheDocument();
    expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(1);
  });

  it("Add closes the popover as soon as the write lands, before the refetches finish", async () => {
    vi.spyOn(apiModule, "acceptTopicSuggestion").mockResolvedValue([]);
    let releaseRefresh: () => void = () => {};
    const refreshGraph = vi.fn(() => new Promise<void>((resolve) => (releaseRefresh = resolve)));
    const { onClose, refetchTopics } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11, refreshGraph });

    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(refreshGraph).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled(); // closed while refreshGraph is still pending
    expect(refetchTopics).toHaveBeenCalled();
    releaseRefresh();
  });

  it("the existing add-by-name closes before the refresh too", async () => {
    vi.spyOn(apiModule, "addTopic").mockResolvedValue([]);
    let releaseRefresh: () => void = () => {};
    const refreshGraph = vi.fn(() => new Promise<void>((resolve) => (releaseRefresh = resolve)));
    const { onClose } = renderPopover({ refreshGraph });

    await userEvent.type(document.querySelector(".hbar-sc-input") as HTMLInputElement, "Books{Enter}");

    await waitFor(() => expect(refreshGraph).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    releaseRefresh();
  });

  it("a second Add (button or Enter) while one is in flight sends nothing; Not interested too", async () => {
    let resolveAccept: (v: TopicInterest[]) => void = () => {};
    const acceptSpy = vi.spyOn(apiModule, "acceptTopicSuggestion").mockImplementation(() => new Promise((resolve) => (resolveAccept = resolve)));
    const dismissSpy = vi.spyOn(apiModule, "dismissTopicSuggestion").mockResolvedValue(undefined);
    renderPopover({ suggestions: SUGGS, initialSuggestionId: 11 });

    await userEvent.type(screen.getByLabelText("Supercluster name"), "{Enter}");
    await waitFor(() => expect(acceptSpy).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByLabelText("Supercluster name"), "{Enter}");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    expect(dismissSpy).not.toHaveBeenCalled();
    resolveAccept([]);
  });

  describe("demo identity", () => {
    it("suggestion state shows with Add and Not interested locked: aria-disabled, chart-kit tooltip, no request", async () => {
      const acceptSpy = vi.spyOn(apiModule, "acceptTopicSuggestion").mockResolvedValue([]);
      const dismissSpy = vi.spyOn(apiModule, "dismissTopicSuggestion").mockResolvedValue(undefined);
      const { onClose } = renderPopover({ suggestions: SUGGS, initialSuggestionId: 11, demoLocked: true });

      const add = screen.getByRole("button", { name: "Add" });
      const dismiss = screen.getByRole("button", { name: "Not interested" });
      expect(add).toHaveAttribute("aria-disabled", "true");
      expect(dismiss).toHaveAttribute("aria-disabled", "true");
      expect(add).not.toHaveAttribute("title");

      fireEvent.mouseEnter(add, { clientX: 10, clientY: 10 });
      expect(screen.getByRole("tooltip")).toHaveTextContent("Disabled in demo view");
      fireEvent.mouseLeave(add);

      await userEvent.click(add);
      await userEvent.click(dismiss);
      expect(acceptSpy).not.toHaveBeenCalled();
      expect(dismissSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("the suggestion state is marked readable (exempt from the plain-demo hide)", () => {
      renderPopover({ suggestions: SUGGS, initialSuggestionId: 11, demoLocked: true, plainDemo: true });
      expect(document.querySelector(".hbar-sc-popover")).toHaveAttribute("data-sc-demo-readable");
    });

    it("the SUGGESTED list view (reached from the all-allocated footer) is marked readable too", async () => {
      const topics = Array.from({ length: 24 }, (_, i) => makeTopic({ keyword: `t${i}` }));
      renderPopover({ slot: 0, topic: topics[0], topics, suggestions: SUGGS, demoLocked: true, plainDemo: true });
      expect(document.querySelector(".hbar-sc-popover")).not.toHaveAttribute("data-sc-demo-readable");

      await userEvent.click(screen.getByText("SUGGESTED (2)"));
      expect(document.querySelector(".hbar-sc-popover")).toHaveAttribute("data-sc-demo-readable");
      expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);
    });

    it("plain demo login: the plus popover shows only the SUGGESTED list (no add form), readable", () => {
      renderPopover({ suggestions: SUGGS, demoLocked: true, plainDemo: true });
      expect(screen.queryByText("ADD SUPERCLUSTER")).toBeNull();
      expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);
      expect(document.querySelector(".hbar-sc-popover")).toHaveAttribute("data-sc-demo-readable");
    });

    it("plain demo login with no suggestions: the add form renders as before, not readable", () => {
      renderPopover({ suggestions: [], demoLocked: true, plainDemo: true });
      expect(screen.getByText("ADD SUPERCLUSTER")).toBeInTheDocument();
      expect(document.querySelector(".hbar-sc-popover")).not.toHaveAttribute("data-sc-demo-readable");
    });

    it("admin viewing as demo keeps the add form above the list, with Add / Not interested still locked", () => {
      renderPopover({ suggestions: SUGGS, demoLocked: true, plainDemo: false });
      expect(screen.getByText("ADD SUPERCLUSTER")).toBeInTheDocument();
      expect(document.querySelectorAll(".hbar-sc-sugg-row")).toHaveLength(2);
    });

    it("a non-demo allocated popover is not marked readable", () => {
      renderPopover({ topic: makeTopic({ keyword: "x" }), topics: [makeTopic({ keyword: "x" })], suggestions: SUGGS });
      expect(document.querySelector(".hbar-sc-popover")).not.toHaveAttribute("data-sc-demo-readable");
    });
  });
});
