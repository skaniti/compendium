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
      mount(
        parent: Element,
        options?: {
          variant?: string;
          count?: number;
          twinkleCount?: number;
          glintCount?: number;
          streamCount?: number;
        },
      ): HTMLElement;
    };
    // Batch B dev hook (spec: the 2026-09-13 graph-interaction-followups
    // plan (private), spec.md) -- live-tunes the parallax factor
    // applied below and re-applies the last published view immediately so
    // a dev can see the effect without waiting for the next pan tick.
    __d3SetStarfieldPanFactor?: (factor: number) => void;
  }
}

// Batch B (parallax): the mount is oversized to 200%x200% (4x area -- see
// app/styles/starry-selector.css's #starry-sky-mount rule) so its edge
// never shows through the max pan the parallax offset below can reach.
const STARFIELD_OVERSIZE_AREA_FACTOR = 4;

// Fix review I3 (2026-09-13): starry-sky.js's `count` option turns out to
// be a NO-OP for visible density -- lib/vendor/starry-sky.js's own header
// comment has the full writeup (verified: the box-shadow layers it drives
// are authored with percentage offsets, which are invalid for `box-shadow`
// and silently never apply). Kept here anyway (harmless, forward-compat if
// that vendor bug is ever fixed) but marked inert -- the layers that
// actually render are twinkle/glint/stream stars, scaled below instead.
const STARRY_SKY_DEFAULT_COUNT: Record<string, number> = { twinkle: 380, pan: 420, hyperspace: 260 };

// The layers that actually paint, per variant, and their real defaults --
// lib/vendor/starry-sky.js's buildTwinkle (twinkleCount, glintCount),
// buildPan (glintCount only -- no individually-animated twinkle stars),
// buildHyperspace (streamCount only). Only the keys a given variant's own
// builder reads are listed; setting an unlisted key on the wrong variant's
// element is a harmless no-op (that builder's destructuring just ignores
// it), so `applyDensity` below always applies all three unconditionally.
const STARRY_SKY_VARIANT_DENSITY: Record<string, Partial<Record<"twinkleCount" | "glintCount" | "streamCount", number>>> = {
  twinkle: { twinkleCount: 60, glintCount: 4 },
  pan: { glintCount: 5 },
  hyperspace: { streamCount: 70 },
};

// kebab-case attribute names lib/vendor/starry-sky.js's observedAttributes
// list expects (fix review I3) -- `Object.keys` below iterates camelCase
// option-style keys (matching StarrySky.mount()'s own options shape).
const DENSITY_ATTRIBUTE_NAME: Record<string, string> = {
  count: "count",
  twinkleCount: "twinkle-count",
  glintCount: "glint-count",
  streamCount: "stream-count",
};

/** Every density-affecting count for `variant`, already scaled by the
 *  mount's 4x oversize area so stars-per-screen-pixel stays constant no
 *  matter which layer actually renders for that variant. Shared by the
 *  mount effect (passed as `mount()` options, so the element paints with
 *  the right density on its very first `_render()`) and the variant-sync
 *  effect (applied via `setAttribute` so a LATER switch keeps the same
 *  density -- fix review I3's own "also in the variant-sync effect"
 *  requirement). */
function densityFor(variant: string): Record<string, number> {
  const perVariant = STARRY_SKY_VARIANT_DENSITY[variant] || {};
  const result: Record<string, number> = {
    count: (STARRY_SKY_DEFAULT_COUNT[variant] ?? 0) * STARFIELD_OVERSIZE_AREA_FACTOR,
  };
  for (const key of Object.keys(perVariant) as Array<keyof typeof perVariant>) {
    const base = perVariant[key];
    if (base != null) result[key] = base * STARFIELD_OVERSIZE_AREA_FACTOR;
  }
  return result;
}

function applyDensityAttributes(sky: HTMLElement, variant: string): void {
  const density = densityFor(variant);
  for (const key of Object.keys(density)) {
    sky.setAttribute(DENSITY_ATTRIBUTE_NAME[key], String(density[key]));
  }
}

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
      // Fix review I3: every density-affecting count (`count` -- inert,
      // kept for forward-compat -- plus whichever of twinkle/glint/stream
      // count this variant's own builder reads), scaled 4x for the mount's
      // 4x oversize area. Passed as mount() OPTIONS (not a later
      // setAttribute) so the element's very FIRST `_render()` already
      // paints at the right density instead of a redundant extra
      // re-render right after mount.
      const sky = window.StarrySky.mount(mountRef.current, {
        variant: mountVariant,
        ...densityFor(mountVariant),
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
  // comment).
  //
  // Fix review C1 (2026-09-13): the ORIGINAL formula here --
  // `(v.x - v.fitX) * (v.fitK / v.k)` -- moved the stars on a PURE zoom
  // (no real pan): zooming about a fixed screen point p changes `t.x` even
  // when the "camera" hasn't panned in world space (`newX = p - (p - oldX)
  // * (newK / oldK)`), and the old formula had no way to tell that apart
  // from a real pan. The fix adds a correction term anchored on `v.cx`/
  // `v.cy` (the canvas center the current fit is centered on, published by
  // the vendor -- lib/graph/view-bus.ts's own comment has the type-level
  // writeup): `dx = ((cx - fitX) * (1 - fitK/k) + (x - fitX) * (fitK/k)) *
  // factor`, same for y. Proof this is zero for a pure zoom about the
  // center, starting from the fit transform itself (x0 = fitX, k0 = fitK):
  // zooming to k gives x = cx - (cx - fitX) * (k / fitK); substituting into
  // the bracketed expression above and simplifying (`A = cx - fitX`, `r =
  // fitK / k`) collapses both terms to `A*(1-r) + A*(r-1) = 0` regardless
  // of A -- exactly the "stars stay put on a pure zoom" behavior this fix
  // restores. At `k === fitK` (no zoom change), `(1 - fitK/k) === 0`, so
  // the correction term itself vanishes and this reduces to the ORIGINAL
  // formula exactly -- a pure pan at any FIXED zoom level is unaffected by
  // this fix, only a zoom (with or without an accompanying pan) is.
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
      const zoomRatio = v.fitK / v.k;
      const dx = ((v.cx - v.fitX) * (1 - zoomRatio) + (v.x - v.fitX) * zoomRatio) * starfieldPanFactor;
      const dy = ((v.cy - v.fitY) * (1 - zoomRatio) + (v.y - v.fitY) * zoomRatio) * starfieldPanFactor;
      mount.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    };

    const unsubscribe = subscribeView(applyParallax);
    // Fix review minor: apply whatever view already exists immediately on
    // subscribe -- without this, a Starfield that mounts (or remounts)
    // AFTER the graph has already panned/zoomed stayed at the CSS default
    // (no transform) until the user's next pan/zoom tick, visibly
    // misaligned with the graph in the meantime.
    const initial = lastView();
    if (initial) applyParallax(initial);

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
      if (sky.getAttribute("variant") !== variant) {
        sky.setAttribute("variant", variant);
        // Fix review I3: re-apply density for the NEW variant so a later
        // switch keeps the same visual star density instead of freezing at
        // whatever the FIRST-mounted variant's own figures were (each
        // `setAttribute` here also triggers starry-sky.js's own
        // attributeChangedCallback -> _render(), same as the `variant`
        // attribute set just above -- a few redundant re-renders on a
        // user-driven, infrequent variant switch, not a per-frame path).
        applyDensityAttributes(sky, variant);
      }
    }
  }, [variant]);

  return <div id="starry-sky-mount" ref={mountRef} data-variant={variant} />;
}
