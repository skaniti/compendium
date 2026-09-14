// TypeScript port of explorer's frontend/dash/utils/theme.py (branch F1(b),
// 2026-09-14). Every function mirrors its Python namesake operation for
// operation -- the same colorsys formulas in the same evaluation order,
// Python float `%` semantics, int() truncation, uppercase two-digit hex --
// so the doubles round identically and the output is byte-identical to the
// Python-exported goldens (lib/theme-goldens.json, the test oracle).
//
// Pipeline: palette (primary, highlight)
//        -> 5 base tokens (deriveBaseTokens)
//        -> 28 tokens (deriveTokens: adaptive-coupling shifts + galaxy stops)
// Dark-only: every palette renders as a single near-black theme.

export type Hls = [h: number, l: number, s: number];

export interface Palette {
  name: string;
  primary: string;
  highlight: string;
}

export interface PaletteLibrary {
  active: string;
  palettes: Palette[];
}

export interface Swatch {
  name: string;
  primary: string;
  highlight: string;
  band_light: string;
  band_mid: string;
  band_dark: string;
  ring: string;
}

// Same constants colorsys computes at import time.
const ONE_THIRD = 1.0 / 3.0;
const ONE_SIXTH = 1.0 / 6.0;
const TWO_THIRD = 2.0 / 3.0;

// Python's float `%`: fmod, then adjusted so the result takes the sign of
// the divisor; an exact multiple yields +0. JS `%` alone keeps the sign of
// the dividend, which would put negative hues on the wrong side of the
// circle -- and (-1e-17) % 1.0 must come out as 1.0, exactly as CPython does.
export function pyMod(a: number, b: number): number {
  const r = a % b;
  if (r === 0) return 0;
  return (r < 0) !== (b < 0) ? r + b : r;
}

export function clamp(v: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, v));
}

// Signed shortest-arc hue delta on the [0, 1) circle (theme.py _shortest_arc).
export function shortestArc(hFrom: number, hTo: number): number {
  let d = hTo - hFrom;
  if (d > 0.5) d -= 1.0;
  else if (d < -0.5) d += 1.0;
  return d;
}

// colorsys.rgb_to_hls, CPython 3.12 (gh-106498 form: 2.0 - maxc - minc).
export function rgbToHls(r: number, g: number, b: number): Hls {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sumc = maxc + minc;
  const rangec = maxc - minc;
  const l = sumc / 2.0;
  if (minc === maxc) return [0.0, l, 0.0];
  const s = l <= 0.5 ? rangec / sumc : rangec / (2.0 - maxc - minc);
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2.0 + rc - bc;
  else h = 4.0 + gc - rc;
  h = pyMod(h / 6.0, 1.0);
  return [h, l, s];
}

// colorsys._v
function v(m1: number, m2: number, hue: number): number {
  hue = pyMod(hue, 1.0);
  if (hue < ONE_SIXTH) return m1 + (m2 - m1) * hue * 6.0;
  if (hue < 0.5) return m2;
  if (hue < TWO_THIRD) return m1 + (m2 - m1) * (TWO_THIRD - hue) * 6.0;
  return m1;
}

// colorsys.hls_to_rgb
export function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0.0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1.0 + s) : l + s - l * s;
  const m1 = 2.0 * l - m2;
  return [v(m1, m2, h + ONE_THIRD), v(m1, m2, h), v(m1, m2, h - ONE_THIRD)];
}

// theme.py _hex_to_hls: lstrip("#"), int(.., 16) / 255.0 per channel.
export function hexToHls(hexColor: string): Hls {
  const hex = hexColor.replace(/^#+/, "");
  const r = parseInt(hex.slice(0, 2), 16) / 255.0;
  const g = parseInt(hex.slice(2, 4), 16) / 255.0;
  const b = parseInt(hex.slice(4, 6), 16) / 255.0;
  return rgbToHls(r, g, b);
}

// theme.py _hls_to_hex: int(x * 255) truncates; "{:02X}" is uppercase hex.
export function hlsToHex(h: number, l: number, s: number): string {
  const [r, g, b] = hlsToRgb(h, l, s);
  const byte = (x: number) => Math.trunc(x * 255).toString(16).toUpperCase().padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

// theme.py _derive_base_tokens: near-black bg, light text, hue-tinted surface.
export function deriveBaseTokens(primary: string, highlight: string): Record<string, string> {
  const [h, , s] = hexToHls(primary);
  return {
    primary,
    highlight,
    bg: hlsToHex(h, 0.1, clamp(s * 0.3)),
    text: hlsToHex(h, 0.85, clamp(s * 0.25)),
    surface: hlsToHex(h, 0.16, clamp(s * 0.15)),
  };
}

// theme.py _adaptive_shift: lightness shift with saturation-adaptive
// coupling -- vivid colours get less saturation change than muted ones.
export function adaptiveShift(hexColor: string, lDelta: number, sign: number, darken = false): string {
  const k = 0.5;
  const [h, l, s] = hexToHls(hexColor);
  const ld = (darken ? -sign : sign) * lDelta;
  const coupling = k * (1.0 - s * 0.6);
  const sd = coupling * ld;
  return hlsToHex(h, clamp(l + ld), clamp(s + sd));
}

// theme.py derive_galaxy_stops: n hue-swept stops centred between the
// primary and highlight hues, then the stop nearest each anchor is nudged
// toward it -- highlight first (blend 0.20), then primary (0.40), the second
// pass seeing the first pass's mutation, exactly like the Python loop.
export function deriveGalaxyStops(primary: string, highlight: string, n = 3, step = 0.15): string[] {
  const [hP, , sP] = hexToHls(primary);
  const [hH, , sH] = hexToHls(highlight);

  let short = hH - hP;
  if (short > 0.5) short -= 1.0;
  else if (short < -0.5) short += 1.0;

  const span = step * (n - 1);
  const mid = pyMod(hP + short / 2, 1.0);
  const start = mid - span / 2;

  const lBase = 0.5;
  const lAmp = 0.15;
  const sFloor = 0.2;

  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(n - 1, 1);
    const h = pyMod(start + t * span, 1.0);
    const s = Math.max(sP + t * (sH - sP), sFloor);
    const l = lBase + lAmp * Math.sin(t * Math.PI);
    stops.push(hlsToHex(h, clamp(l), clamp(s)));
  }

  const nudges: Array<[target: string, blend: number]> = [
    [highlight, 0.2],
    [primary, 0.4],
  ];
  for (const [target, blend] of nudges) {
    const [hT, lT, sT] = hexToHls(target);
    let bestI = 0;
    let bestD = 1.0;
    for (let i = 0; i < stops.length; i++) {
      const [hS] = hexToHls(stops[i]);
      const d = Math.min(Math.abs(hS - hT), 1.0 - Math.abs(hS - hT));
      if (d < bestD) {
        bestI = i;
        bestD = d;
      }
    }
    const [hS, lS, sS] = hexToHls(stops[bestI]);
    stops[bestI] = hlsToHex(
      hS + shortestArc(hS, hT) * blend,
      clamp(lS + (lT - lS) * blend),
      clamp(sS + (sT - sS) * blend),
    );
  }
  return stops;
}

// theme.py load_colors, minus the theme.json lookup: the full 28-token map
// for one palette, in the exact insertion order generate_css_text emits.
export function deriveTokens(primary: string, highlight: string): Record<string, string> {
  const c = deriveBaseTokens(primary, highlight);
  const sign = 1.0;

  // From primary (mid-tone element colours)
  c.secondary = adaptiveShift(c.primary, 0.17, sign);
  c.accent = adaptiveShift(c.primary, 0.12, sign, true);
  // Lifted accent that clears AA as foreground text on bg/surface.
  c.accent_text = adaptiveShift(c.primary, 0.24, sign, false);
  c.tag_bg = adaptiveShift(c.primary, 0.42, sign);
  c.tag_text = adaptiveShift(c.primary, 0.22, sign, true);

  // From text
  c.text_muted = adaptiveShift(c.text, 0.3, sign, true);
  c.node_label = adaptiveShift(c.text, 0.1, sign, true);
  c.link_muted = adaptiveShift(c.text, 0.48, sign, true);
  // 0.60 (not 0.74) so the border lands ~0.15 lightness above bg.
  c.border = adaptiveShift(c.text, 0.6, sign, true);
  c.surface_alt = adaptiveShift(c.text, 0.79, sign, true);

  // Highlight alias
  c.highlight_bg = c.highlight;

  // Container/panel backgrounds -- lighter (inward depth)
  c.container_bg = adaptiveShift(c.bg, 0.08, sign, false);
  c.panel_bg = adaptiveShift(c.container_bg, 0.08, sign, false);

  // Side panel body -- from bg to keep hue saturation
  c.side_panel = adaptiveShift(c.bg, 0.15, sign);

  // Caption/subtitle text readable on the side panel surface
  c.panel_caption = adaptiveShift(c.text, 0.2, sign, true);

  // Paper/ink
  c.paper = "#1A1A1A";
  c.ink = "#FFFFFF";

  // Text on coloured backgrounds -- always white
  c.on_primary = "#FFFFFF";

  // Hue-neutral translucent chrome (scroll thumbs), never palette-tinted.
  c.chrome_neutral = "rgba(255, 255, 255, 0.32)";
  c.chrome_neutral_strong = "rgba(255, 255, 255, 0.8)";

  // Galaxy gradient stops (cluster node colouring)
  deriveGalaxyStops(primary, highlight).forEach((color, i) => {
    c[`galaxy_${i}`] = color;
  });

  return c;
}

// theme.py get_palette_swatches, for one palette: three hard-stop bands from
// the primary's hue at L 0.60 / 0.40 / 0.20, with band_light and band_dark
// swapped (band_light holds the L 0.20 value) so the picker's top-to-bottom
// render order matches the original dark row; ring is the highlight.
export function deriveSwatch(name: string, primary: string, highlight: string): Swatch {
  const [h, , s] = hexToHls(primary);
  const bandLight = hlsToHex(h, 0.6, s);
  const bandMid = hlsToHex(h, 0.4, s);
  const bandDark = hlsToHex(h, 0.2, s);
  return {
    name,
    primary,
    highlight,
    band_light: bandDark,
    band_mid: bandMid,
    band_dark: bandLight,
    ring: highlight,
  };
}
