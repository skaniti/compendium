/** Series i of n: hue rotated around --highlight; odd series also get lighter so neighbours differ in hue and lightness. */
export function seriesFill(i: number, n: number): string {
  const dh = Math.round((i * 360) / Math.max(n, 2));
  return `oklch(from var(--highlight) ${i % 2 ? "calc(l + 0.08)" : "l"} c calc(h + ${dh}))`;
}

export const UNCATEGORIZED_FILL = "color-mix(in oklch, var(--panel-caption) 40%, var(--surface))";

/** Named category ids get rotating series fills in the given order; "uncategorized" is a fixed neutral grey and takes no slot. */
export function categoryColors(ids: string[]): Record<string, string> {
  const named = ids.filter((id) => id !== "uncategorized");
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = id === "uncategorized" ? UNCATEGORIZED_FILL : seriesFill(named.indexOf(id), named.length);
  return out;
}
