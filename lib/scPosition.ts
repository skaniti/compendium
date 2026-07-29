// Shared anchored-position math for the SUPERCLUSTERS popover + hover
// tooltip (Task 8-C3). Ports the position formula shared by
// compendium-explorer's assets/sc_popover_position.js (positionPopover) and
// assets/sc_tooltip_hover.js (positionTooltip) -- both anchor a
// position:fixed panel to the bottom-left of the matching tile, clamping the
// right edge so the panel never overflows the viewport; the tooltip
// additionally clamps the LEFT edge (`clampLeftMin`), the popover does not
// (parity: see each file's own positioning function).
//
// Both source files select the anchor tile via a `data-sc-tile-slot="N"`
// query rather than a component ref -- the popover/tooltip components live
// in a different DOM subtree after being portaled into #sc-popovers-portal,
// so there is no React ref path from "the open slot's popover" to "that
// slot's tile" the way there would be for siblings. tileForSlot below mirrors
// that exact selection model instead of inventing a ref-threading scheme.

export const SC_ANCHOR_GAP_PX = 8; // vertical gap between tile bottom and panel top
export const SC_ANCHOR_VIEWPORT_PAD_PX = 8; // keep this much clear from the viewport edge(s)
export const SC_ANCHOR_FALLBACK_WIDTH = 240; // used when the panel's own measured width is 0

// Subset of DOMRect actually needed -- lets tests pass a plain object instead
// of a real (jsdom-unsupported) DOMRect.
export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
}

export function computeAnchoredPosition(
  tileRect: AnchorRect,
  ownWidth: number,
  opts: { clampLeftMin?: boolean } = {}
): { top: number; left: number } {
  // Fall back to 240 when measurement is 0 -- the panel's CSS gives it a
  // 220-280px range but getBoundingClientRect() returns 0 width until after
  // it's actually painted (display:block), matching both source files'
  // `popRect.width || 240` / `tipRect.width || 240` fallback.
  const width = ownWidth || SC_ANCHOR_FALLBACK_WIDTH;
  const top = Math.round(tileRect.bottom + SC_ANCHOR_GAP_PX);
  let left = Math.round(tileRect.left);

  const maxLeft = window.innerWidth - width - SC_ANCHOR_VIEWPORT_PAD_PX;
  if (left > maxLeft) left = Math.max(SC_ANCHOR_VIEWPORT_PAD_PX, maxLeft);
  if (opts.clampLeftMin && left < SC_ANCHOR_VIEWPORT_PAD_PX) left = SC_ANCHOR_VIEWPORT_PAD_PX;

  return { top, left };
}

export function tileForSlot(slot: number): Element | null {
  return document.querySelector(`[data-sc-tile-slot="${slot}"]`);
}

// SSR-safe: these components are all "use client" but Next still performs a
// server render pass before hydration, where `document` doesn't exist.
export function getPortalElement(): Element | null {
  return typeof document === "undefined" ? null : document.getElementById("sc-popovers-portal");
}

export function getHeaderGraphControls(): Element | null {
  return typeof document === "undefined" ? null : document.getElementById("header-graph-controls");
}
