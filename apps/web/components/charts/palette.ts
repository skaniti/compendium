/** Series i of n: hue rotated around --highlight; odd series also get lighter so neighbours differ in hue and lightness. */
export function seriesFill(i: number, n: number): string {
  const dh = Math.round((i * 360) / Math.max(n, 2));
  return `oklch(from var(--highlight) ${i % 2 ? "calc(l + 0.08)" : "l"} c calc(h + ${dh}))`;
}

const GOLDEN = 0.6180339887;
/** Hue offsets from --highlight stay inside [60, 300] degrees, so no category reads as the cyan reserved for what reaches the graph. */
export const CATEGORY_HUE_MIN = 60, CATEGORY_HUE_SPAN = 240;
/** Named category i: golden-angle steps over the allowed arc spread consecutive ids widely; odd ids are lighter so neighbours differ. */
export function categoryFill(i: number): string {
  const dh = Math.round(CATEGORY_HUE_MIN + ((i * GOLDEN) % 1) * CATEGORY_HUE_SPAN);
  return `oklch(from var(--highlight) ${i % 2 ? "calc(l + 0.08)" : "l"} c calc(h + ${dh}))`;
}

export const UNCATEGORIZED_FILL = "color-mix(in oklch, var(--panel-caption) 40%, var(--surface))";

/** Named category ids get golden-angle hue fills (clear of --highlight) by index in the given order; "uncategorized" is a fixed neutral grey and takes no slot. */
export function categoryColors(ids: string[]): Record<string, string> {
  const named = ids.filter((id) => id !== "uncategorized");
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = id === "uncategorized" ? UNCATEGORIZED_FILL : categoryFill(named.indexOf(id));
  return out;
}
