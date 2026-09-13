"use client";

import { useEffect, useRef } from "react";
import { useStarfield, DEFAULT_STARFIELD_VARIANT } from "./StarfieldProvider";
import { subscribeView, lastView, type GraphView } from "@/lib/graph/view-bus";

// window.StarrySky is attached as a side effect of importing
// lib/vendor/starry-sky.js (see the mount effect below) -- there's no
// bundled type for it since that file is plain vendored JS.
declare global {
  interface Window {
    StarrySky?: {
      mount(parent: Element, options?: { variant?: string; count?: number }): HTMLElement;
    };
    // Batch B dev hook (spec docs/project-plans/2026-09-13-183006-graph-
    // interaction-followups/spec.md) -- live-tunes the parallax factor
    // applied below and re-applies the last published view immediately so
    // a dev can see the effect without waiting for the next pan tick.
    __d3SetStarfieldPanFactor?: (factor: number) => void;
  }
}

// Batch B (parallax): the mount is oversized to 200%x200% (4x area -- see
// app/styles/starry-selector.css's #starry-sky-mount rule) so its edge
// never shows through the max pan the parallax offset below can reach.
// starry-sky.js's `count` option (verified: STARRY_SKY_DEFAULT_COUNT below
// matches buildTwinkle/buildPan/buildHyperspace's own opts defaults in
// lib/vendor/starry-sky.js) scales the box-shadow star field to a fixed
// PERCENT-positioned tile, so a 4x-area box at the default count would
// paint the same star COUNT spread over 4x the area -- a visible density
// drop. Passing 4x the variant's default count at mount keeps stars per
// screen-pixel unchanged.
const STARRY_SKY_DEFAULT_COUNT: Record<string, number> = { twinkle: 380, pan: 420, hyperspace: 260 };
const STARFIELD_OVERSIZE_AREA_FACTOR = 4;

// Default parallax factor (plan decision, controller 2026-09-13): the
// starfield moves at HALF the graph's own pan, measured at fit scale --
// see applyParallax's own comment for the dx/dy derivation. Live-tunable
// via window.__d3SetStarfieldPanFactor in development.
const DEFAULT_STARFIELD_PAN_FACTOR = 0.5;
let starfieldPanFactor = DEFAULT_STARFIELD_PAN_FACTOR;

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
      // Batch B: 4x the variant's own default count -- see
      // STARRY_SKY_DEFAULT_COUNT's comment for why (the mount is 4x the
      // area). A later variant switch (the effect below) only swaps the
      // `variant` attribute, not `count` -- starry-sky.js's
      // attributeChangedCallback re-renders from EVERY current attribute,
      // so the count set here stays in effect (at this variant's own 4x
      // figure, not whatever the newly-switched-to variant's default would
      // be) across later switches; an acceptable approximation for a
      // debug-visible density tweak, not worth a live re-count per switch.
      const sky = window.StarrySky.mount(mountRef.current, {
        variant: mountVariant,
        count: STARRY_SKY_DEFAULT_COUNT[mountVariant] * STARFIELD_OVERSIZE_AREA_FACTOR,
      });
      sky.style.display = current === "none" ? "none" : "";
      skyRef.current = sky;
    });
    return () => {
      cancelled = true;
    };
    // Intentionally mount-once; variant changes after mount are handled by
    // the effect below.
  }, []);

  // Batch B (starfield parallax with the pan): subscribes to the vendor's
  // pan/zoom stream (lib/graph/view-bus.ts, published by
  // components/GraphCanvas.tsx's onViewChange wiring) and pans the MOUNT
  // div directly via a `transform` style -- deliberately not React state,
  // since a drag/wheel gesture can publish many views per second and a
  // state-driven re-render per tick would be wasteful (view-bus.ts's own
  // comment). dx/dy are measured at fit scale so the offset the user sees
  // is roughly `factor` of the graph's own screen-space pan at every zoom
  // level (spec decision, controller 2026-09-13) -- `(v.x - v.fitX)` is the
  // pan since the last fit in the CURRENT zoom's screen pixels; multiplying
  // by `v.fitK / v.k` rescales that back to what it would be at fit scale,
  // so a deep zoom-in (large k) doesn't produce an outsized starfield swing
  // for the same world-space pan.
  useEffect(() => {
    // Captured once, here, rather than read as `mountRef.current` inside
    // the cleanup below -- React detaches the ref (nulling `mountRef.
    // current`) as part of unmounting this same host element, and that can
    // happen before this effect's own cleanup runs, so a `mountRef.current`
    // read at cleanup time is not reliably the still-live element. The div
    // is always present by the time an effect first runs (it's rendered in
    // the same commit), so this capture is never null in practice.
    const mount = mountRef.current;
    if (!mount) return;

    // Arrow function (not `function`), deliberately -- TS narrows `mount`
    // to non-null here (a `const` read inside an arrow closure), but not
    // across a nested `function` declaration's own boundary.
    const applyParallax = (v: GraphView): void => {
      const dx = (v.x - v.fitX) * (v.fitK / v.k) * starfieldPanFactor;
      const dy = (v.y - v.fitY) * (v.fitK / v.k) * starfieldPanFactor;
      mount.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    };

    const unsubscribe = subscribeView(applyParallax);

    if (process.env.NODE_ENV === "development") {
      window.__d3SetStarfieldPanFactor = (factor: number) => {
        starfieldPanFactor = factor;
        const v = lastView();
        if (v) applyParallax(v);
      };
    }

    return () => {
      unsubscribe();
      mount.style.transform = "";
      if (process.env.NODE_ENV === "development") {
        delete window.__d3SetStarfieldPanFactor;
      }
    };
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
