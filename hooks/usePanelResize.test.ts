import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { usePanelResize } from "./usePanelResize";
import * as preferences from "@/lib/preferences";

// Port of assets/panel_resize.js's drag/clamp/persist recipe. jsdom doesn't
// run layout, so offsetWidth is stubbed per-element via defineProperty --
// the hook reads it fresh on every mousedown (mirrors the original script).
function stubOffsetWidth(el: HTMLElement, width: number): void {
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: width });
}

function Harness() {
  const { containerRef, leftPanelRef, leftHandleRef, rightHandleRef, rightPanelRef } =
    usePanelResize();
  return createElement(
    "div",
    { ref: containerRef, className: "app-container" },
    createElement("div", { ref: leftPanelRef, className: "panel panel-left" }),
    createElement("div", {
      ref: leftHandleRef,
      id: "resize-handle-left",
      className: "panel-resize-handle",
    }),
    createElement("div", { className: "panel panel-center" }),
    createElement("div", {
      ref: rightHandleRef,
      id: "resize-handle-right",
      className: "panel-resize-handle",
    }),
    createElement("div", { ref: rightPanelRef, className: "panel panel-right" }),
  );
}

function renderHarness() {
  const { container, unmount } = render(createElement(Harness));
  const appContainer = container.querySelector(".app-container") as HTMLElement;
  const leftPanel = container.querySelector(".panel-left") as HTMLElement;
  const rightPanel = container.querySelector(".panel-right") as HTMLElement;
  const leftHandle = container.querySelector("#resize-handle-left") as HTMLElement;
  const rightHandle = container.querySelector("#resize-handle-right") as HTMLElement;
  stubOffsetWidth(appContainer, 1000);
  stubOffsetWidth(leftPanel, 200);
  stubOffsetWidth(rightPanel, 200);
  return { appContainer, leftPanel, rightPanel, leftHandle, rightHandle, unmount };
}

describe("usePanelResize", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dragging the left handle right widens the left panel", () => {
    const { appContainer, leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 }); // delta +50 -> 250px / 1000px

    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("25.00%");
  });

  it("dragging the left handle left narrows the left panel", () => {
    const { appContainer, leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 70 }); // delta -30 -> 170px / 1000px

    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("17.00%");
  });

  it("dragging the right handle left widens the right panel (sign is inverted)", () => {
    const { appContainer, rightHandle } = renderHarness();

    fireEvent.mouseDown(rightHandle, { clientX: 800 });
    fireEvent.mouseMove(document, { clientX: 750 }); // delta -50, inverted -> +50 -> 250px

    expect(appContainer.style.getPropertyValue("--panel-right-width")).toBe("25.00%");
  });

  it("clamps the new width at a 120px floor", () => {
    const { appContainer, leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 0 }); // delta -500 -> would be -300px, clamped to 120px

    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("12.00%");
  });

  it("clamps the new width at a 40%-of-container ceiling", () => {
    const { appContainer, leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 2000 }); // huge delta -> would exceed 400px, clamped to 400px

    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("40.00%");
  });

  it("toggles the .active class on the dragged handle for the duration of the drag", () => {
    const { leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    expect(leftHandle.classList.contains("active")).toBe(true);

    fireEvent.mouseUp(document);
    expect(leftHandle.classList.contains("active")).toBe(false);
  });

  it("persists both panel widths via patchPreferences on mouseup", async () => {
    const patchSpy = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    const { leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 }); // -> 25.00%
    fireEvent.mouseUp(document);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith({
      panel_left_width: "25.00%",
      panel_right_width: "20%",
    });
  });

  it("stops updating the width after mouseup (listeners are removed)", () => {
    const { appContainer, leftHandle } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 });
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientX: 900 }); // should be ignored -- no listener anymore

    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("25.00%");
  });

  it("detaches drag listeners and resets body style when unmounted mid-drag", () => {
    const { appContainer, leftHandle, unmount } = renderHarness();

    fireEvent.mouseDown(leftHandle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 }); // -> 25.00%
    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("25.00%");
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    unmount(); // no mouseup ever fired -- drag was still in flight

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // A leaked onMove would still be attached to `document` and would
    // still mutate appContainer (the node reference is still live even
    // though it's been removed from the DOM by unmount).
    fireEvent.mouseMove(document, { clientX: 900 });
    expect(appContainer.style.getPropertyValue("--panel-left-width")).toBe("25.00%");
  });
});
