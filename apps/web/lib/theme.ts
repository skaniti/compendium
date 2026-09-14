import rawPalettes from "./palettes.json";
import {
  deriveGalaxyStops,
  deriveSwatch,
  deriveTokens,
  type PaletteLibrary,
  type Swatch,
} from "./theme-derive";

// Tokens are derived once, at module load, from the two hand-picked hex
// values per palette in palettes.json -- the TypeScript port of explorer's
// theme.py (branch F1(b), 2026-09-14; derivation lives in theme-derive.ts).
// theme-goldens.json, exported from that Python source, is a test-only
// oracle: theme.test.ts and theme-derive.test.ts compare every value here
// against it byte for byte. Nothing at runtime reads the goldens.

export type PaletteVariant = string;
export type { Swatch };

interface VariantEntry {
  tokens: Record<string, string>;
  galaxy_stops: string[];
}

const library = rawPalettes as PaletteLibrary;

const PALETTE_NAMES = library.palettes.map((p) => p.name);

const variants: Record<string, VariantEntry> = {};
for (const p of library.palettes) {
  variants[p.name] = {
    tokens: deriveTokens(p.primary, p.highlight),
    galaxy_stops: deriveGalaxyStops(p.primary, p.highlight),
  };
}

const swatches: Swatch[] = library.palettes.map((p) =>
  deriveSwatch(p.name, p.primary, p.highlight)
);

// The library's default palette (server-rendered variant; the theme provider
// seeds from this).
export const DEFAULT_VARIANT: string = library.active;

export function getPaletteNames(): string[] {
  return [...PALETTE_NAMES];
}

function requireVariantEntry(variant: string): VariantEntry {
  // Object.hasOwn, not `variants[variant]` truthiness: a caller-supplied key
  // like "constructor" or "__proto__" resolves through the prototype chain
  // to a real (truthy) value -- Object, Object.prototype -- so a bare
  // `!entry` check would silently treat those as valid variants instead of
  // falling back like any other unknown name.
  if (!Object.hasOwn(variants, variant)) {
    throw new Error(`Unknown palette variant: "${variant}"`);
  }
  return variants[variant];
}

export function getTokens(variant: string): Record<string, string> {
  return { ...requireVariantEntry(variant).tokens };
}

export function getGalaxyStops(variant: string): string[] {
  return [...requireVariantEntry(variant).galaxy_stops];
}

export function getSwatches(): Swatch[] {
  return swatches.map((swatch) => ({ ...swatch }));
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
