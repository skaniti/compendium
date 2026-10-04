/** Spend-by-purpose bar layout: which segments carry their figures inside, and where the rest go as callouts above the bar. Pure, so jsdom tests can pin it. */

export const BAR_GAP = 2; // px between segments, as .overview-spend-bar's gap
export const MIN_SEGMENT = 3; // px, as .overview-spend-bar > span's min-width
export const LABEL_PAD = 8; // px of fill kept clear on each side of an inside label
export const CALLOUT_GAP = 14; // px between neighbouring callouts
export const CHAR_WIDTH = 6.9; // px per glyph of the 0.72rem monospace label until the component measures the real one
export const CALLOUT_LEAD = 12; // px ahead of a callout's text: its 8px swatch and a 4px gap

export interface SpendSegmentInput { key: string; share: number; full: string; short: string }
export type SpendSegmentLayout =
  | { key: string; mode: "inside"; text: string }
  | { key: string; mode: "callout"; text: string; left: number; width: number; center: number };

/** Pixel span of each segment, as flex-grow with a min-width lays them out: segments that would fall under MIN_SEGMENT freeze there and the rest share what is left. */
export function segmentGeometry(shares: number[], barWidth: number): { start: number; width: number }[] {
  const avail = Math.max(0, barWidth - BAR_GAP * Math.max(0, shares.length - 1));
  const frozen = new Set<number>();
  let widths: number[] = [];
  for (;;) {
    const free = avail - frozen.size * MIN_SEGMENT;
    const grow = shares.reduce((a, s, i) => (frozen.has(i) ? a : a + s), 0);
    widths = shares.map((s, i) => (frozen.has(i) ? MIN_SEGMENT : grow > 0 ? (free * s) / grow : 0));
    const under = widths.flatMap((w, i) => (!frozen.has(i) && w < MIN_SEGMENT ? [i] : []));
    if (under.length === 0) break;
    under.forEach((i) => frozen.add(i));
  }
  let x = 0;
  return widths.map((width) => { const g = { start: x, width }; x += width + BAR_GAP; return g; });
}

/**
 * Inside a segment: the full label if it fits with LABEL_PAD a side, else the short one. A segment that fits neither gets a
 * callout above the bar (swatch + text, centred on its segment where there is room); callouts are placed right to left so
 * each gives way to its right-hand neighbour, and switch to the short text when the full set would run past the bar's left edge.
 */
export function layoutSpendBar(segments: SpendSegmentInput[], barWidth: number, charWidth = CHAR_WIDTH): SpendSegmentLayout[] {
  const geo = segmentGeometry(segments.map((s) => s.share), barWidth);
  const textWidth = (t: string) => t.length * charWidth;
  const fits = (t: string, w: number) => textWidth(t) + 2 * LABEL_PAD <= w;
  const inside = segments.map((s, i) => (fits(s.full, geo[i].width) ? s.full : fits(s.short, geo[i].width) ? s.short : null));
  const narrow = segments.flatMap((_, i) => (inside[i] === null ? [i] : [])).reverse();
  const place = (pick: (s: SpendSegmentInput) => string) => {
    let limit = barWidth;
    const out = new Map<number, { text: string; left: number; width: number; center: number }>();
    for (const i of narrow) {
      const text = pick(segments[i]);
      const w = CALLOUT_LEAD + textWidth(text);
      const center = geo[i].start + geo[i].width / 2;
      const right = Math.min(Math.max(center + w / 2, w), limit);
      out.set(i, { text, left: right - w, width: w, center });
      limit = right - w - CALLOUT_GAP;
    }
    return out;
  };
  let callouts = place((s) => s.full);
  if ([...callouts.values()].some((c) => c.left < 0)) callouts = place((s) => s.short);
  return segments.map((s, i) => {
    const c = callouts.get(i);
    return c ? { key: s.key, mode: "callout", text: c.text, left: Math.max(0, c.left), width: c.width, center: c.center } : { key: s.key, mode: "inside", text: inside[i] as string };
  });
}

export type Rgb = readonly [number, number, number];

/** WCAG relative luminance of an sRGB colour (0-255 channels). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A label inside a coloured fill takes whichever text token contrasts more with that fill. */
export function pickInk(fill: Rgb, dark: Rgb, light: Rgb): "dark" | "light" {
  return contrastRatio(fill, dark) >= contrastRatio(fill, light) ? "dark" : "light";
}
