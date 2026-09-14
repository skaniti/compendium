import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import PageZoomGuard from "./PageZoomGuard";

// Covers the two browser-page-zoom leaks PageZoomGuard closes (see that
// component's own header comment for the full mechanism):
//   1. Ctrl/Cmd+wheel bubbling from anywhere in the app (side panels, header)
//      that d3-zoom never had a listener for in the first place.
//   2. Ctrl/Cmd+wheel over the graph once d3-zoom's own scaleExtent clamp
//      makes it return early (zoom.js:251) before its noevent() preventDefault
//      (zoom.js:260) -- simulated here the same way, since jsdom has no real
//      d3-zoom instance to clamp against: a bare wheel event on a nested div.
// Plain/Shift wheel and keyboard Ctrl+=/- are asserted untouched so panel
// scroll, graph pan, and keyboard zoom don't regress.
describe("PageZoomGuard", () => {
  let testDiv: HTMLDivElement;

  beforeEach(() => {
    testDiv = document.createElement("div");
    document.body.appendChild(testDiv);
  });

  afterEach(() => {
    cleanup();
    testDiv.remove();
    // The two spy tests at the bottom spy on document.addEventListener /
    // removeEventListener; restore after each test so the LAST one's spies
    // don't outlive the file (beforeEach-only restoration leaves them).
    vi.restoreAllMocks();
  });

  it("prevents the browser default for a Ctrl+wheel that bubbles up from a nested element", () => {
    render(<PageZoomGuard />);

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    testDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents the browser default for a Meta+wheel", () => {
    render(<PageZoomGuard />);

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    testDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a plain wheel alone so panels scroll and the graph pans", () => {
    render(<PageZoomGuard />);

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    testDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a Shift+wheel alone", () => {
    render(<PageZoomGuard />);

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    testDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("does not touch keyboard zoom (Ctrl+= / Ctrl+- keydown)", () => {
    render(<PageZoomGuard />);

    const plusEvent = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(plusEvent);

    const minusEvent = new KeyboardEvent("keydown", {
      key: "-",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(minusEvent);

    expect(plusEvent.defaultPrevented).toBe(false);
    expect(minusEvent.defaultPrevented).toBe(false);
  });

  it("registers the wheel listener non-passive on document", () => {
    // This is the test that fails if someone drops the { passive: false }
    // options object -- Chrome's scroll intervention treats window/document/
    // body wheel listeners as passive by default, silently no-op'ing any
    // preventDefault() inside; jsdom doesn't emulate that intervention, so a
    // behavior-only test (the ones above) can't catch a missing options arg.
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    render(<PageZoomGuard />);

    expect(addEventListenerSpy).toHaveBeenCalledWith("wheel", expect.any(Function), {
      passive: false,
    });
  });

  it("removes the listener on unmount", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = render(<PageZoomGuard />);
    const registeredHandler = addEventListenerSpy.mock.calls.find(
      (call) => call[0] === "wheel",
    )?.[1];

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("wheel", registeredHandler);

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    testDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
