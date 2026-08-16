"use client";

import { useEffect, useRef } from "react";
import { useStarfield, DEFAULT_STARFIELD_VARIANT } from "./StarfieldProvider";

// window.StarrySky is attached as a side effect of importing
// lib/vendor/starry-sky.js (see the mount effect below) -- there's no
// bundled type for it since that file is plain vendored JS.
declare global {
  interface Window {
    StarrySky?: {
      mount(parent: Element, options?: { variant?: string }): HTMLElement;
    };
  }
}

// Client wrapper replacing starry_selector.js's Dash-specific mounting glue
// (DOM polling for window.StarrySky + #starry-sky-mount, localStorage read
// of active-starfield) with idiomatic React: the mount effect only runs
// once the mount div ref already exists, and the live variant comes from
// StarfieldProvider's context instead of localStorage.
//
// Renders behind GraphCanvas in the center panel -- the ported CSS
// (.panel-center #starry-sky-mount, app/styles/starry-selector.css)
// already pins this to position:absolute/z-index:0 inside .panel-center,
// same as Dash's layering (starry-sky z:0, below #d3-graph-container z:1).
export default function Starfield() {
  const { variant } = useStarfield();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const skyRef = useRef<HTMLElement | null>(null);
  // Mirrors ThemeProvider's variantRef pattern: the async import().then()
  // callback below may resolve well after this render, after the user (or
  // context) has already moved on to a different variant -- read the
  // latest value via the ref, not the `variant` closed over at mount time.
  const variantRef = useRef(variant);
  // eslint-disable-next-line react-hooks/refs -- always-current ref updated every render by design (see comment above)
  variantRef.current = variant;

  // Mount <starry-sky> exactly once.
  useEffect(() => {
    let cancelled = false;
    void import("@/lib/vendor/starry-sky.js").then(() => {
      if (cancelled || !mountRef.current || skyRef.current || !window.StarrySky) return;
      const current = variantRef.current;
      // "none" mounts with the twinkle fallback (so the element -- and its
      // attribute-swap wiring -- exists for later switches) but starts
      // hidden. Mirrors starry_selector.js's mountStarrySky().
      const mountVariant = current === "none" ? DEFAULT_STARFIELD_VARIANT : current;
      const sky = window.StarrySky.mount(mountRef.current, { variant: mountVariant });
      sky.style.display = current === "none" ? "none" : "";
      skyRef.current = sky;
    });
    return () => {
      cancelled = true;
    };
    // Intentionally mount-once; variant changes after mount are handled by
    // the effect below.
  }, []);

  // Sync variant changes onto the already-mounted element. Mirrors the
  // "active-starfield Store -> DOM sync" clientside callback in app.py:
  // "none" hides without touching the attribute; anything else unhides and
  // swaps the attribute (only if it actually changed).
  useEffect(() => {
    const sky = skyRef.current;
    if (!sky) return;
    if (variant === "none") {
      sky.style.display = "none";
    } else {
      sky.style.display = "";
      if (sky.getAttribute("variant") !== variant) sky.setAttribute("variant", variant);
    }
  }, [variant]);

  return <div id="starry-sky-mount" ref={mountRef} data-variant={variant} />;
}
