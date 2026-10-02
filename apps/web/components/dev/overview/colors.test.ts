import { it, expect } from "vitest";
import { categoryFill } from "@/components/charts/palette";
import { DEVICE_COLORS, SPEND_COLORS } from "./colors";

it("device greys are theme-derived mixes with desktop lighter than phone", () => {
  expect(DEVICE_COLORS.desktop).toBe("color-mix(in oklch, var(--text) 70%, var(--surface))");
  expect(DEVICE_COLORS.phone).toBe("color-mix(in oklch, var(--panel-caption) 65%, var(--surface))");
  expect(JSON.stringify(DEVICE_COLORS)).not.toMatch(/#/);
});
it("spend purposes use spaced category slots 0/2/4/6, all distinct", () => {
  expect(SPEND_COLORS).toEqual({ gates: categoryFill(0), clustering: categoryFill(2), chat: categoryFill(4), other: categoryFill(6) });
  expect(new Set(Object.values(SPEND_COLORS)).size).toBe(4);
});
