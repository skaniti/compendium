import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import ScTooltips, { ScTooltip } from "./ScTooltip";
import * as apiModule from "@/lib/api";
import type { TopicInterest, TopicMember } from "@/lib/types";

// vi.advanceTimersByTimeAsync alone leaves the setTimeout callback's
// setState update unflushed under React 19 + fake timers (observed: two
// back-to-back advances straddling the 150ms mark render nothing even
// though the state update ran) -- wrapping in act() forces React to flush
// the resulting re-render before the assertion that follows.
async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Ports topics.py's _render_sc_tooltip + assets/sc_tooltip_hover.js's
// hover-intent/suppression/hide behavior into a JSX-parity suite (Task
// 8-C3). All fixtures synthetic; every fetcher mocked per the repo's
// established convention (vi.spyOn(apiModule, ...)).
//
// ScTooltips (default export) is the orchestrator HeaderCards mounts
// unconditionally; ScTooltip (named) is the presentational panel it renders
// once a slot is visible. Both self-portal into #sc-popovers-portal, created/
// torn down by this suite the same way ScPopover.test.tsx does.

function makeTopic(overrides: Partial<TopicInterest> & { keyword: string }): TopicInterest {
  return { icon_id: null, cluster_count: 0, ...overrides };
}

function makeMember(overrides: Partial<TopicMember> & { cluster_name: string }): TopicMember {
  return { page_count: 1, mean_membership_probability: 0.5, ...overrides };
}

let portal: HTMLDivElement;

function makeTile(slot: number): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = "hbar-sc-tile hbar-sc-tile-allocated";
  tile.setAttribute("data-sc-tile-slot", String(slot));
  document.body.appendChild(tile);
  return tile;
}

describe("ScTooltip (presentational)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    portal = document.createElement("div");
    portal.id = "sc-popovers-portal";
    document.body.appendChild(portal);
  });

  afterEach(() => {
    portal.remove();
  });

  it("renders nothing when #sc-popovers-portal is absent", () => {
    portal.remove();
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 0 });
    const { container } = render(<ScTooltip slot={0} topic={topic} members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("memberless (cluster_count 0): title + empty message, no table", () => {
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 0 });
    render(<ScTooltip slot={0} topic={topic} members={[]} />);

    expect(screen.getByText("Cooking")).toHaveClass("hbar-sc-tooltip-title");
    expect(screen.getByText("no clusters in the latest run")).toHaveClass("hbar-sc-tooltip-empty");
    expect(document.querySelector(".hbar-sc-tooltip-table")).not.toBeInTheDocument();
  });

  it("count pluralization: 1 cluster (singular) vs. N clusters (plural)", () => {
    const singular = makeTopic({ keyword: "Cooking", cluster_count: 1 });
    const { rerender } = render(<ScTooltip slot={0} topic={singular} members={[]} />);
    expect(screen.getByText("1 cluster")).toBeInTheDocument();

    const plural = makeTopic({ keyword: "Cooking", cluster_count: 3 });
    rerender(<ScTooltip slot={0} topic={plural} members={[]} />);
    expect(screen.getByText("3 clusters")).toBeInTheDocument();
  });

  it("renders the table header + one row per member, with conf formatting", () => {
    const topic = makeTopic({ keyword: "Cooking", cluster_count: 2 });
    const members = [
      makeMember({ cluster_name: "Sourdough", page_count: 5, mean_membership_probability: 0.874 }),
      makeMember({ cluster_name: "Knife Skills", page_count: 2, mean_membership_probability: null }),
    ];
    render(<ScTooltip slot={0} topic={topic} members={members} />);

    const ths = Array.from(document.querySelectorAll(".hbar-sc-tooltip-th")).map((el) => el.textContent);
    expect(ths).toEqual(["Cluster", "Pages", "Conf"]);
    expect(document.querySelector(".hbar-sc-tooltip-th-conf")).toHaveAttribute(
      "title",
      "mean HDBSCAN membership probability of the cluster's pages"
    );

    const rows = Array.from(document.querySelectorAll(".hbar-sc-tooltip-table tbody tr"));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".hbar-sc-tooltip-name")).toHaveTextContent("Sourdough");
    expect(rows[0].querySelector(".hbar-sc-tooltip-pages")).toHaveTextContent("5");
    expect(rows[0].querySelector(".hbar-sc-tooltip-conf")).toHaveTextContent("0.87");
    expect(rows[1].querySelector(".hbar-sc-tooltip-conf")).toHaveTextContent("—");
  });

  it("positions below its tile, clamped at both edges", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    const tile = makeTile(0);

    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const base = { x: 0, y: 0, toJSON: () => ({}) };
      if (this === tile) {
        return { ...base, top: 100, left: -50, bottom: 130, right: -19, width: 31, height: 30 } as DOMRect;
      }
      if (this.classList.contains("hbar-sc-tooltip")) {
        return { ...base, top: 0, left: 0, bottom: 0, right: 240, width: 240, height: 120 } as DOMRect;
      }
      return { ...base, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });

    const topic = makeTopic({ keyword: "Cooking", cluster_count: 0 });
    render(<ScTooltip slot={0} topic={topic} members={[]} />);

    const tooltip = document.querySelector(".hbar-sc-tooltip") as HTMLElement;
    expect(tooltip.style.top).toBe("138px");
    // tileRect.left (-50) is left of the viewport pad -- the tooltip (unlike
    // the popover) also clamps the LEFT edge up to 8.
    expect(tooltip.style.left).toBe("8px");

    rectSpy.mockRestore();
    tile.remove();
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });
});

describe("ScTooltips (orchestrator: prefetch + hover-intent)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    portal = document.createElement("div");
    portal.id = "sc-popovers-portal";
    document.body.appendChild(portal);
  });

  afterEach(() => {
    vi.useRealTimers();
    portal.remove();
    document.querySelectorAll("[data-sc-tile-slot]").forEach((el) => el.remove());
  });

  it("prefetches top-5 members for allocated topics only, skipping memberless ones", async () => {
    const membersSpy = vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const topics = [
      makeTopic({ keyword: "Cooking", cluster_count: 3 }),
      makeTopic({ keyword: "Empty Topic", cluster_count: 0 }),
    ];
    render(<ScTooltips topics={topics} openSlot={null} />);
    // Not waitFor -- it polls via real timers, which never fire under
    // vi.useFakeTimers(); flush the pending promise chain directly instead.
    await advanceTimers(0);

    expect(membersSpy).toHaveBeenCalledWith("Cooking", 5);
    expect(membersSpy).not.toHaveBeenCalledWith("Empty Topic", 5);
    expect(membersSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a tooltip after the 150ms hover-intent delay, hides on mouseout", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([makeMember({ cluster_name: "Sourdough" })]);
    const tile = makeTile(0);
    const topics = [makeTopic({ keyword: "Cooking", cluster_count: 1 })];
    render(<ScTooltips topics={topics} openSlot={null} />);
    await advanceTimers(0); // let the prefetch effect's promise settle

    fireEvent.mouseOver(tile);
    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();

    await advanceTimers(149);
    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();

    await advanceTimers(1);
    expect(document.querySelector(".hbar-sc-tooltip")).toBeInTheDocument();
    expect(document.querySelector(".hbar-sc-tooltip-title")).toHaveTextContent("Cooking");

    fireEvent.mouseOut(tile, { relatedTarget: document.body });
    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();
  });

  it("moving within the tile's own children does not re-arm or hide", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const tile = makeTile(0);
    const child = document.createElement("span");
    tile.appendChild(child);
    const topics = [makeTopic({ keyword: "Cooking", cluster_count: 1 })];
    render(<ScTooltips topics={topics} openSlot={null} />);
    await advanceTimers(0);

    fireEvent.mouseOver(tile);
    // Moving from the tile to its own child re-fires mouseover/mouseout with
    // relatedTarget still inside the tile -- must not reset the timer.
    fireEvent.mouseOut(tile, { relatedTarget: child });
    fireEvent.mouseOver(child, { relatedTarget: tile });

    await advanceTimers(150);
    expect(document.querySelector(".hbar-sc-tooltip")).toBeInTheDocument();
  });

  it("suppresses the slot whose popover is open; other slots still show", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const tile0 = makeTile(0);
    const tile1 = makeTile(1);
    const topics = [
      makeTopic({ keyword: "Cooking", cluster_count: 1 }),
      makeTopic({ keyword: "Music", cluster_count: 1 }),
    ];
    render(<ScTooltips topics={topics} openSlot={0} />);
    await advanceTimers(0);

    fireEvent.mouseOver(tile0);
    await advanceTimers(150);
    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument(); // suppressed, timer never armed

    fireEvent.mouseOver(tile1);
    await advanceTimers(150);
    expect(document.querySelector(".hbar-sc-tooltip-title")).toHaveTextContent("Music"); // not suppressed
  });

  it("a popover opening mid-delay cancels the pending tooltip show", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const tile1 = makeTile(1);
    const topics = [
      makeTopic({ keyword: "Cooking", cluster_count: 1 }),
      makeTopic({ keyword: "Music", cluster_count: 1 }),
    ];
    const { rerender } = render(<ScTooltips topics={topics} openSlot={null} />);
    await advanceTimers(0);

    fireEvent.mouseOver(tile1); // not suppressed at schedule time (nothing open yet)
    rerender(<ScTooltips topics={topics} openSlot={1} />); // a popover for slot 1 opens mid-delay
    await advanceTimers(150);

    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();
  });

  it("hides whenever the open popover slot changes (opens/closes/switches)", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const tile1 = makeTile(1);
    const topics = [
      makeTopic({ keyword: "Cooking", cluster_count: 1 }),
      makeTopic({ keyword: "Music", cluster_count: 1 }),
    ];
    const { rerender } = render(<ScTooltips topics={topics} openSlot={null} />);
    await advanceTimers(0);

    fireEvent.mouseOver(tile1);
    await advanceTimers(150);
    expect(document.querySelector(".hbar-sc-tooltip")).toBeInTheDocument();

    rerender(<ScTooltips topics={topics} openSlot={0} />); // a popover just opened (slot 0)
    expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();
  });

  it("hides on mousedown on a tile, window scroll, window wheel, and header-graph-controls scroll", async () => {
    vi.spyOn(apiModule, "fetchTopicMembers").mockResolvedValue([]);
    const tile = makeTile(0);
    // #header-graph-controls must exist BEFORE mount -- the hook reads it
    // once via getHeaderGraphControls() in its listener-setup effect,
    // mirroring the real app where the bar always exists before HeaderCards
    // mounts.
    const hgc = document.createElement("div");
    hgc.id = "header-graph-controls";
    document.body.appendChild(hgc);
    const topics = [makeTopic({ keyword: "Cooking", cluster_count: 1 })];
    render(<ScTooltips topics={topics} openSlot={null} />);
    await advanceTimers(0);

    async function showThenTrigger(trigger: () => void) {
      fireEvent.mouseOver(tile);
      await advanceTimers(150);
      expect(document.querySelector(".hbar-sc-tooltip")).toBeInTheDocument();
      trigger();
      expect(document.querySelector(".hbar-sc-tooltip")).not.toBeInTheDocument();
    }

    await showThenTrigger(() => fireEvent.mouseDown(tile));
    await showThenTrigger(() => fireEvent.scroll(window));
    await showThenTrigger(() => fireEvent.wheel(window));
    await showThenTrigger(() => fireEvent.scroll(hgc));

    hgc.remove();
  });
});
