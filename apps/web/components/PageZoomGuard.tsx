"use client";

import { useEffect } from "react";

// Closes two browser-page-zoom leaks that d3-zoom (lib/graph/d3-graph-vendor.js)
// does not close on its own:
//
//   1. Ctrl/Cmd+wheel over the graph once its scale is already clamped at the
//      scaleExtent -- d3-zoom's own `wheeled` handler (node_modules/d3-zoom/
//      src/zoom.js:234-268) computes the clamped k, and when t.k === k with no
//      wheel gesture in flight (the `else if` at zoom.js:251; a tick within
//      150ms of a handled one takes the `if (g.wheel)` branch instead) it
//      `return`s early -- BEFORE reaching noevent(event) at zoom.js:260 (its
//      preventDefault() + stopImmediatePropagation()). Parked at the clamp, no
//      tick ever starts a gesture, so every tick takes that early return: the
//      event is left completely unhandled and bubbles up to the browser, which
//      page-zooms.
//   2. Ctrl/Cmd+wheel (including a precision-touchpad pinch, which browsers
//      deliver as a synthetic ctrlKey wheel event) over the side panels or
//      header: no d3-zoom instance is attached there at all, so there is no
//      listener of any kind to stop it.
//
// Fix: one non-passive wheel listener at the document root that calls
// preventDefault() whenever ctrlKey || metaKey is set, regardless of where in
// the app the event originated or what handled it. `{ passive: false }` is
// load-bearing, not decorative -- Chrome's scroll intervention treats wheel
// listeners registered on window/document/body as passive by default, and
// preventDefault() inside a passive listener is a silent no-op (plus a console
// warning). When d3-zoom DOES handle a Ctrl+wheel (still within its
// scaleExtent), it calls noevent(event), whose stopImmediatePropagation() halts
// the event's bubble phase right there -- it never reaches this document-level
// listener at all, so there is no double handling.
//
// Keyboard Ctrl+plus/minus zoom is untouched by design: this only listens for
// "wheel", never "keydown". Plain wheel (no modifier) is also left alone on
// purpose -- the vendor's own wheel.pan listener uses it to pan the graph, and
// elsewhere in the app plain wheel must keep scrolling panels.
//
// Mounted in AppShell (components/AppShell.tsx) beside PlainDemoBodyClass,
// for the same reason: AppShell is an async server component, so this effect
// cannot live there directly.
export default function PageZoomGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("wheel", onWheel);
    };
  }, []);

  return null;
}
