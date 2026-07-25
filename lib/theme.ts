import rawGoldens from "./theme-goldens.json";

// Pure JSON lookup over the goldens exported from the Python source of truth
// (see theme-goldens.json). No math/derivation here -- branch F1(a).

export type PaletteVariant = string;

export interface Swatch {
  name: string;
  primary: string;
  highlight: string;
  band_light: string;
  band_mid: string;
  band_dark: string;
  ring: string;
}

interface VariantEntry {
  tokens: Record<string, string>;
  galaxy_stops: string[];
  css_text: string;
}

interface Goldens {
  active: string;
  variants: Record<string, VariantEntry>;
  swatches: Swatch[];
}

// Widen the JSON module's inferred literal types (exact keys/values) to plain
// string-indexed shapes so callers can look up by an arbitrary string.
const goldens = rawGoldens as Goldens;

const PALETTE_NAMES = Object.keys(goldens.variants);

// The goldens' server-rendered default variant (theme provider task needs this).
export const DEFAULT_VARIANT: string = goldens.active;

export function getPaletteNames(): string[] {
  return [...PALETTE_NAMES];
}

function requireVariantEntry(variant: string): VariantEntry {
  // Object.hasOwn, not `goldens.variants[variant]` truthiness: a
  // caller-supplied key like "constructor" or "__proto__" resolves through
  // the prototype chain to a real (truthy) value -- Object, Object.prototype
  // -- so a bare `!entry` check would silently treat those as valid variants
  // instead of falling back like any other unknown name.
  if (!Object.hasOwn(goldens.variants, variant)) {
    throw new Error(`Unknown palette variant: "${variant}"`);
  }
  return goldens.variants[variant];
}

export function getTokens(variant: string): Record<string, string> {
  return { ...requireVariantEntry(variant).tokens };
}

export function getGalaxyStops(variant: string): string[] {
  return [...requireVariantEntry(variant).galaxy_stops];
}

export function getSwatches(): Swatch[] {
  return goldens.swatches.map((swatch) => ({ ...swatch }));
}

// Mirrors the Python `_resolve_palette`: strips a legacy trailing " Dark"
// alias, then falls back to DEFAULT_VARIANT for anything that still isn't a
// known palette name (e.g. a retired "Yellow" persisted in old prefs). Unlike
// getTokens/getGalaxyStops, this never throws -- it's the explicit step
// callers use to sanitize untrusted persisted variant names.
export function normalizeVariant(name: string): string {
  const DARK_SUFFIX = " Dark";
  const stripped = name.endsWith(DARK_SUFFIX)
    ? name.slice(0, -DARK_SUFFIX.length)
    : name;
  return PALETTE_NAMES.includes(stripped) ? stripped : DEFAULT_VARIANT;
}

// Same :root{--k:v} shape as theme.py's generate_css_text: one
// "    --key-with-hyphens: value;" line per token (insertion order,
// underscores -> hyphens), wrapped in ":root { ... }" with no trailing
// newline after the closing brace.
export function generateCssText(tokens: Record<string, string>): string {
  const lines = Object.entries(tokens)
    .map(([key, value]) => `    --${key.replace(/_/g, "-")}: ${value};`)
    .join("\n");
  return `:root {\n${lines}\n}`;
}
