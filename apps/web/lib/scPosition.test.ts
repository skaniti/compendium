import { afterEach, describe, expect, it } from "vitest";
import { anchorRectForTile } from "./scPosition";

function rect(top: number, bottom: number, left = 0): DOMRect {
  return { top, bottom, left, right: left + 20, width: 20, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("anchorRectForTile", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pushes the anchor bottom down to the card's bottom so a first-row tile's panel clears the second row", () => {
    document.body.innerHTML = '<div class="hbar-sc-card"><div class="hbar-sc-tile"></div></div>';
    const card = document.querySelector(".hbar-sc-card") as HTMLElement;
    const tile = document.querySelector(".hbar-sc-tile") as HTMLElement;
    card.getBoundingClientRect = () => rect(10, 92);
    tile.getBoundingClientRect = () => rect(30, 53, 40);

    expect(anchorRectForTile(tile)).toEqual({ top: 30, left: 40, bottom: 92 });
  });

  it("falls back to the tile's own bottom outside a card", () => {
    document.body.innerHTML = '<div class="hbar-sc-tile"></div>';
    const tile = document.querySelector(".hbar-sc-tile") as HTMLElement;
    tile.getBoundingClientRect = () => rect(30, 53, 40);

    expect(anchorRectForTile(tile)).toEqual({ top: 30, left: 40, bottom: 53 });
  });
});
