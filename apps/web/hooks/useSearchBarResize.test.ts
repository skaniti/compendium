import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { useSearchBarResize } from "./useSearchBarResize";

// jsdom runs no layout: offsetHeight is stubbed per element, and the bar's
// inline `height` (what animateToHeight writes) stands in for the rendered
// height, so tests read bar.style.height.
const KEY = "compendium-search-height";
const holder: { current: ReturnType<typeof useSearchBarResize> | null } = { current: null };
const api = new Proxy({} as ReturnType<typeof useSearchBarResize>, {
  get: (_t, k) => (holder.current as never)[k],
});

function stub(el: HTMLElement, prop: string, value: number): void {
  Object.defineProperty(el, prop, { configurable: true, value });
}

function Harness() {
  const hook = useSearchBarResize();
  useEffect(() => {
    holder.current = hook;
  });
  return createElement(
    "div",
    { ref: hook.barRef, id: "bar" },
    createElement("div", { ref: hook.handleRef, className: "search-resize-handle", id: "h" }),
    createElement("div", { className: "search-bar-input-row" }),
  );
}

function setup(innerHeight = 1000) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  const utils = render(createElement(Harness));
  const bar = utils.container.querySelector("#bar") as HTMLElement;
  stub(bar.querySelector(".search-resize-handle") as HTMLElement, "offsetHeight", 10);
  stub(bar.querySelector(".search-bar-input-row") as HTMLElement, "offsetHeight", 40);
  return { bar, handle: bar.querySelector("#h") as HTMLElement };
}

/** Drag the handle up by `dy` px from a bar of `startH`, then release. */
function drag(bar: HTMLElement, handle: HTMLElement, startH: number, dy: number): void {
  stub(bar, "offsetHeight", startH);
  fireEvent.mouseDown(handle, { clientY: 800 });
  fireEvent.mouseMove(document, { clientY: 800 - dy });
  stub(bar, "offsetHeight", parseFloat(bar.style.height));
  fireEvent.mouseUp(document);
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("useSearchBarResize remembered height", () => {
  it("returns to the dragged height after collapse then expand", () => {
    const { bar, handle } = setup();
    drag(bar, handle, 300, 220); // -> 520
    expect(bar.style.height).toBe("520px");
    act(() => api.toggleMaximized()); // collapse
    expect(bar.style.height).toBe("50px");
    act(() => api.expand());
    expect(bar.style.height).toBe("520px");
    act(() => api.toggleMaximized()); // collapse
    act(() => api.toggleMaximized()); // maximize via the tab
    expect(bar.style.height).toBe("520px");
  });

  it("persists the dragged height to sessionStorage and restores it on first expand after a reload", () => {
    const first = setup();
    drag(first.bar, first.handle, 300, 220);
    expect(sessionStorage.getItem(KEY)).toBe("520");
    cleanup();
    const second = setup();
    act(() => api.expand());
    expect(second.bar.style.height).toBe("520px");
  });

  it("clamps the remembered height to 70% of a shrunken viewport", () => {
    const { bar, handle } = setup(1000);
    drag(bar, handle, 300, 350); // 650 <= 700
    expect(bar.style.height).toBe("650px");
    act(() => api.toggleMaximized());
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    act(() => api.expand());
    expect(bar.style.height).toBe("420px");
  });

  it("falls back to the default maximized height when nothing was dragged", () => {
    const { bar } = setup(1000);
    act(() => api.expand());
    expect(bar.style.height).toBe("400px"); // min(400, 1000 * 0.5)
  });

  it("does not remember a drag that snaps to minimized", () => {
    const { bar, handle } = setup();
    drag(bar, handle, 300, -300); // dragged down: clamps to min 50 -> snap
    expect(sessionStorage.getItem(KEY)).toBeNull();
    act(() => api.expand());
    expect(bar.style.height).toBe("400px");
  });

  it("keeps toggling when sessionStorage throws", () => {
    const { bar, handle } = setup();
    const orig = Storage.prototype;
    const get = orig.getItem, set = orig.setItem;
    orig.getItem = () => { throw new Error("blocked"); };
    orig.setItem = () => { throw new Error("blocked"); };
    try {
      drag(bar, handle, 300, 220);
      act(() => api.toggleMaximized());
      act(() => api.expand());
      expect(bar.style.height).toBe("520px"); // in-memory ref still works
    } finally {
      orig.getItem = get;
      orig.setItem = set;
    }
  });
});
