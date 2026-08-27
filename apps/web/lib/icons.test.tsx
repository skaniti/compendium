import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import iconDataRaw from "./icon-data.json";
import { getIconsGrouped, groupIcons, TopicIcon, type IconEntry } from "./icons";

// Task 8-C1: port of the Dash icon mechanism (frontend/dash/utils/
// icon_helpers.py + assets/icon_data.json). The real sidecar has 246 icons
// across 39 categories where every icon's category is already a member of
// _category_order -- there is no real-data example of the "Uncategorized"
// bucket, so that behavior is exercised via a small synthetic fixture fed
// through the exported `groupIcons` helper (the pure function
// `getIconsGrouped()` delegates to, over the real sidecar's data).

const iconData = iconDataRaw as { _category_order: string[]; icons: Record<string, IconEntry> };

describe("getIconsGrouped", () => {
  it("returns categories in _category_order order, omitting empty ones", () => {
    const grouped = getIconsGrouped();
    const groupedCats = grouped.map(([cat]) => cat);
    // Every returned category must appear in the canonical order, in the
    // same relative sequence as _category_order (subsequence check -- the
    // real sidecar happens to have zero empty categories, but the ordering
    // invariant is what matters).
    const orderIndex = new Map(iconData._category_order.map((c, i) => [c, i]));
    const indices = groupedCats.map((c) => orderIndex.get(c));
    expect(indices.every((i) => i !== undefined)).toBe(true);
    const sorted = [...(indices as number[])].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  it("sorts icon ids within each category", () => {
    const grouped = getIconsGrouped();
    for (const [, ids] of grouped) {
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    }
  });

  it("covers every icon in the real sidecar exactly once", () => {
    const grouped = getIconsGrouped();
    const flat = grouped.flatMap(([, ids]) => ids);
    expect(flat.length).toBe(Object.keys(iconData.icons).length);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe("groupIcons (synthetic fixture)", () => {
  const order = ["Alpha", "Beta"];
  const icons: Record<string, IconEntry> = {
    "b-icon": { label: "B", category: "Beta", viewBox: "0 0 1 1", paths: [] },
    "a-icon": { label: "A", category: "Alpha", viewBox: "0 0 1 1", paths: [] },
    "a2-icon": { label: "A2", category: "Alpha", viewBox: "0 0 1 1", paths: [] },
    "mystery-icon": { label: "M", category: "Nonexistent Category", viewBox: "0 0 1 1", paths: [] },
  };

  it("groups in category-order, sorted ids, omitting empty categories", () => {
    expect(groupIcons(icons, order)).toEqual([
      ["Alpha", ["a-icon", "a2-icon"]],
      ["Beta", ["b-icon"]],
      ["Nonexistent Category", ["mystery-icon"]],
    ]);
  });

  it("puts icons whose category is not in the order list into an Uncategorized-style trailing bucket", () => {
    const grouped = groupIcons(icons, order);
    const last = grouped[grouped.length - 1];
    expect(last[0]).toBe("Nonexistent Category");
    expect(last[1]).toEqual(["mystery-icon"]);
  });

  it("omits a category from the order list entirely if it has no icons", () => {
    const grouped = groupIcons(icons, ["Alpha", "Empty", "Beta"]);
    expect(grouped.map(([cat]) => cat)).toEqual(["Alpha", "Beta", "Nonexistent Category"]);
  });

  it("defaults an icon with no category field to Uncategorized", () => {
    const withMissing: Record<string, IconEntry> = {
      ...icons,
      "no-cat-icon": { label: "N", viewBox: "0 0 1 1", paths: [] } as unknown as IconEntry,
    };
    const grouped = groupIcons(withMissing, order);
    const uncategorized = grouped.find(([cat]) => cat === "Uncategorized");
    expect(uncategorized?.[1]).toContain("no-cat-icon");
  });
});

describe("TopicIcon", () => {
  // "cloud" is the real sidecar's simplest entry: a single path, viewBox
  // "0 0 72 72", category "Nature & Weather" -- picked so the path-count and
  // viewBox assertions below are exact, not approximate.
  const cloudPath = iconData.icons.cloud.paths[0];

  it("renders an inline svg with the icon's viewBox and one path per entry", () => {
    const { container } = render(<TopicIcon iconId="cloud" size={24} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 72 72");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(1);
    expect(paths[0].getAttribute("d")).toBe(cloudPath);
  });

  it("defaults stroke to currentColor and strokeWidth to 1.5, with no dasharray attribute", () => {
    const { container } = render(<TopicIcon iconId="cloud" size={16} />);
    const path = container.querySelector("path");
    expect(path?.getAttribute("fill")).toBe("none");
    expect(path?.getAttribute("stroke")).toBe("currentColor");
    expect(path?.getAttribute("stroke-width")).toBe("1.5");
    expect(path?.getAttribute("stroke-linecap")).toBe("round");
    expect(path?.getAttribute("stroke-linejoin")).toBe("round");
    expect(path?.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("passes through an explicit stroke color and strokeWidth", () => {
    const { container } = render(
      <TopicIcon iconId="cloud" size={16} stroke="#facc15" strokeWidth={2} />
    );
    const path = container.querySelector("path");
    expect(path?.getAttribute("stroke")).toBe("#facc15");
    expect(path?.getAttribute("stroke-width")).toBe("2");
  });

  it("passes through strokeDasharray when given", () => {
    const { container } = render(
      <TopicIcon iconId="cloud" size={16} strokeDasharray="6,4" />
    );
    const path = container.querySelector("path");
    expect(path?.getAttribute("stroke-dasharray")).toBe("6,4");
  });

  it("passes through className onto the svg element", () => {
    const { container } = render(<TopicIcon iconId="cloud" size={16} className="my-icon" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("my-icon");
  });

  it("renders one path per multi-path icon (abacus, 29 paths)", () => {
    const { container } = render(<TopicIcon iconId="abacus" size={16} />);
    expect(container.querySelectorAll("path").length).toBe(
      iconData.icons.abacus.paths.length
    );
  });

  it("renders nothing for an unknown icon id", () => {
    const { container } = render(<TopicIcon iconId="not-a-real-icon" size={16} />);
    expect(container.innerHTML).toBe("");
  });
});
