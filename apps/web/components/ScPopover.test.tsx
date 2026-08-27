import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScPopover, { type ScPopoverProps } from "./ScPopover";
import * as apiModule from "@/lib/api";
import { getIconsGrouped } from "@/lib/icons";
import type { MemberExclusion, TopicInterest, TopicMember } from "@/lib/types";

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

function mockMemberFetches(members: TopicMember[] = [], exclusions: MemberExclusion[] = []) {
  vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue(members);
  vi.spyOn(apiModule, "fetchMemberExclusions").mockResolvedValue(exclusions);
}

function renderPopover(overrides: Partial<ScPopoverProps> = {}) {
  const onClose = vi.fn();
  const refetchTopics = vi.fn();
  const refreshGraph = vi.fn().mockResolvedValue(undefined);
  const props: ScPopoverProps = {
    slot: 0,
    topic: undefined,
    topics: [],
    onClose,
    refetchTopics,
    refreshGraph,
    ...overrides,
  };
  const result = render(<ScPopover {...props} />);
  return { ...result, onClose, refetchTopics, refreshGraph, props };
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

    const deleteBtn = screen.getByTitle("Delete supercluster");
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

    const cellFor = (iconId: string) => document.querySelector(`.hbar-sc-pick-cell[title="${iconId}"]`) as HTMLElement;

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

    const cell = document.querySelector(`.hbar-sc-pick-cell[title="${ICON_C}"]`) as HTMLElement;
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

    await userEvent.click(document.querySelector(`.hbar-sc-pick-cell[title="${ICON_B}"]`) as HTMLElement);

    expect(setIconSpy).not.toHaveBeenCalled();
    expect(refetchTopics).not.toHaveBeenCalled();
  });

  it("icon picker: selecting an unused icon calls setTopicIcon + refetch + refresh, and stays open", async () => {
    mockMemberFetches();
    vi.spyOn(apiModule, "setTopicIcon").mockResolvedValue([]);
    const topic = makeTopic({ keyword: "Cooking", icon_id: ICON_A });
    const { onClose, refetchTopics, refreshGraph } = renderPopover({ topic, topics: [topic] });

    await userEvent.click(document.querySelector(`.hbar-sc-pick-cell[title="${ICON_C}"]`) as HTMLElement);

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

    await userEvent.click(screen.getByTitle(/Doesn't belong here/));

    await waitFor(() => expect(excludeSpy).toHaveBeenCalledWith("Cooking", "Sourdough"));
    await waitFor(() => expect(membersSpy).toHaveBeenCalledTimes(2));
    expect(refreshGraph).toHaveBeenCalledTimes(1);
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

    await userEvent.click(screen.getByTitle(/Restore/));

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
