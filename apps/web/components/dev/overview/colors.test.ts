import { it, expect } from "vitest";
import { categoryFill } from "@/components/charts/palette";
import { SPEND_COLORS } from "./colors";

it("spend purposes use spaced category slots 0/2/4/6, all distinct", () => {
  expect(SPEND_COLORS).toEqual({ gates: categoryFill(0), clustering: categoryFill(2), chat: categoryFill(4), other: categoryFill(6) });
  expect(new Set(Object.values(SPEND_COLORS)).size).toBe(4);
});
