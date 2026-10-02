/** Series i of n: hue rotated around --highlight; odd series also get lighter so neighbours differ in hue and lightness. */
export function seriesFill(i: number, n: number): string {
  const dh = Math.round((i * 360) / Math.max(n, 2));
  return `oklch(from var(--highlight) ${i % 2 ? "calc(l + 0.08)" : "l"} c calc(h + ${dh}))`;
}

/** Hue offsets from --highlight stay inside [60, 300] degrees, so no category reads as the cyan reserved for what reaches the graph. */
export const CATEGORY_HUE_MIN = 60, CATEGORY_HUE_MAX = 300, CATEGORY_HUE_SLOTS = 7;
/** Two lightness tiers (with slightly lower chroma in the second) reuse the same hue slots, so any two ids differ clearly in hue or lightness. */
export const CATEGORY_TIERS = [{ l: "+ 0.06", c: "c" }, { l: "- 0.14", c: "calc(c * 0.85)" }] as const;
/** Named category i: ids 0-6 take the 7 even hue slots in tier 0, ids 7-13 the same slots in tier 1 (wrapping beyond 14). */
export function categoryFill(i: number): string {
  const slot = i % CATEGORY_HUE_SLOTS, tier = CATEGORY_TIERS[Math.floor(i / CATEGORY_HUE_SLOTS) % CATEGORY_TIERS.length];
  const dh = Math.round(CATEGORY_HUE_MIN + (slot * (CATEGORY_HUE_MAX - CATEGORY_HUE_MIN)) / (CATEGORY_HUE_SLOTS - 1));
  return `oklch(from var(--highlight) calc(l ${tier.l}) ${tier.c} calc(h + ${dh}))`;
}

export const UNCATEGORIZED_FILL = "color-mix(in oklch, var(--panel-caption) 40%, var(--surface))";

/** Named category ids get two-tier hue/lightness fills (clear of --highlight) by index in the given order; "uncategorized" is a fixed neutral grey and takes no slot. */
export function categoryColors(ids: string[]): Record<string, string> {
  const named = ids.filter((id) => id !== "uncategorized");
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = id === "uncategorized" ? UNCATEGORIZED_FILL : categoryFill(named.indexOf(id));
  return out;
}
