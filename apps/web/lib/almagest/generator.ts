import "@/fonts/almagest/tools/almagest-glyphs.cjs";

export interface AlmagestTierParams { width: number; tracking: number; sidebearing: number; points: number; rot: number; min: number; star: number; contrast: number; trim: number; stroke: number; pointiness: number }
export interface AlmagestOutline { ch: string; contours: number[][][]; advance: number; xMin: number; yMin: number; xMax: number; yMax: number }
type TierTable = { min: number; star: number; contrast: number; trim: number; stroke: number; pointiness: number };
export interface AlmagestApi {
  XU: number; YU: number; UPEM: number; CAP: number;
  FROZEN: { width: number; tracking: number; sidebearing: number; points: number; rot: number };
  TIERS: { Display: TierTable; Mid: TierTable; Text: TierTable };
  tier(name: "Display" | "Mid" | "Text"): AlmagestTierParams;
  glyphOrder(): Array<{ ch: string; cps: number[]; space?: boolean }>;
  outline(ch: string, t: AlmagestTierParams): AlmagestOutline;
  pathData(o: AlmagestOutline): string;
  kernPairs(t: AlmagestTierParams): Array<[string, string, number]>;
  spaceAdvance(t: AlmagestTierParams): number;
}

export function getGenerator(): AlmagestApi {
  const g = (globalThis as { Almagest?: AlmagestApi }).Almagest;
  if (!g) throw new Error("Almagest generator not loaded (fonts/almagest/tools/almagest-glyphs.cjs)");
  return g;
}
