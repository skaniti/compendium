import { getGenerator, type AlmagestTierParams } from "./generator";
import { shippedParams, type AlmagestParams, type TierName } from "./params";

export interface LaidOutGlyph { ch: string; d: string; x: number }

const cache = new Map<string, { d: string; advance: number }>();
export function clearGlyphCache(): void { cache.clear(); }

function params(p?: AlmagestParams): AlmagestParams { return p ?? shippedParams(); }

export function faceForPx(paintedPx: number, p?: AlmagestParams): TierName {
  const t = params(p).tiers;
  // Vendor's almagestFace (d3-graph-vendor.js) uses `>= min - ALMAGEST_TIER_EPS`
  // with ALMAGEST_TIER_EPS = 0.01, to absorb floating-point noise from
  // `cssPx * currentZoomK`. Note 0.01 is exactly the literal gap used by this
  // module's own breakpoint test (51.99 = 52 - 0.01), so replicating the
  // vendor's eps *value* verbatim would swallow that boundary case into
  // "Display" instead of "Mid". Keep the vendor's `>=` (boundary-inclusive)
  // comparison shape, but use an eps only as large as needed to absorb actual
  // float noise, not to widen the breakpoint by a whole hundredth of a pixel.
  const eps = 1e-6;
  if (paintedPx >= t.Display.min - eps) return "Display";
  if (paintedPx >= t.Mid.min - eps) return "Mid";
  return "Text";
}

export function tierParamsFor(face: TierName, p?: AlmagestParams): AlmagestTierParams {
  const q = params(p);
  return { ...q.frozen, ...q.tiers[face] };
}

function glyph(ch: string, face: TierName, t: AlmagestTierParams, key: string): { d: string; advance: number } {
  const g = getGenerator();
  const k = face + "|" + key + "|" + ch;
  let hit = cache.get(k);
  if (!hit) {
    const o = g.outline(ch, t);
    hit = { d: g.pathData(o), advance: o.advance };
    cache.set(k, hit);
  }
  return hit;
}

const mapped = new Set<string>();
function isMapped(ch: string): boolean {
  if (mapped.size === 0) {
    for (const e of getGenerator().glyphOrder()) if (!e.space && e.ch !== ".notdef") mapped.add(e.ch);
  }
  return mapped.has(ch);
}

/** Lays out one line in font units (UPEM/em): x = pen position of each glyph;
 *  kerning from kernPairs(t); space via spaceAdvance(t); lowercase maps to caps
 *  (the generator's own convention); unmapped characters draw .notdef. */
export function layoutLine(text: string, face: TierName, p?: AlmagestParams): { glyphs: LaidOutGlyph[]; advance: number } {
  const g = getGenerator();
  const t = tierParamsFor(face, p);
  const key = JSON.stringify(t);
  const kern = new Map<string, number>();
  for (const [l, r, v] of g.kernPairs(t)) kern.set(l + r, v);
  const glyphs: LaidOutGlyph[] = [];
  let x = 0;
  let prev: string | null = null;
  for (const raw of Array.from(text)) {
    if (raw === " ") { x += g.spaceAdvance(t); prev = null; continue; }
    const up = raw.toUpperCase();
    const ch = isMapped(up) ? up : isMapped(raw) ? raw : ".notdef";
    if (prev !== null) x += kern.get(prev + ch) ?? 0;
    const gl = glyph(ch, face, t, key);
    glyphs.push({ ch, d: gl.d, x });
    x += gl.advance;
    prev = ch;
  }
  return { glyphs, advance: x };
}

export function averageAdvanceEm(p?: AlmagestParams): number {
  const g = getGenerator();
  const t = tierParamsFor("Mid", p);
  let sum = 0;
  for (let c = 65; c <= 90; c++) sum += g.outline(String.fromCharCode(c), t).advance;
  return sum / 26 / g.UPEM;
}
