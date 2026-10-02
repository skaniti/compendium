import { categoryFill } from "@/components/charts/palette";
import type { SpendPurposeKey } from "@/lib/types";

/** Spaced category slots (0/2/4/6) so no two purposes sit on adjacent hues. One mapping for the timeline and the spend panel. */
export const SPEND_COLORS: Record<SpendPurposeKey, string> = {
  gates: categoryFill(0), clustering: categoryFill(2), chat: categoryFill(4), other: categoryFill(6),
};
/** Greys for the Captures row; every palette gives both >= 3:1 against --surface and desktop/phone >= 1.4:1 apart. */
export const DEVICE_COLORS = {
  desktop: "color-mix(in oklch, var(--text) 70%, var(--surface))",
  phone: "color-mix(in oklch, var(--panel-caption) 65%, var(--surface))",
};
