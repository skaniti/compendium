import { getGenerator } from "./generator";

export type TierName = "Display" | "Mid" | "Text";
export interface TierParams { min: number; star: number; contrast: number; trim: number; stroke: number; pointiness: number }
export interface FrozenParams { width: number; tracking: number; sidebearing: number; points: number; rot: number }
export interface AlmagestParams { frozen: FrozenParams; tiers: Record<TierName, TierParams> }
export interface Range { min: number; max: number; step: number }

export const TIER_NAMES: readonly TierName[] = ["Display", "Mid", "Text"];
export const DRAFT_STORAGE_KEY = "compendium_almagest_draft";

export const PARAM_RANGES: { frozen: Record<keyof FrozenParams, Range>; tier: Record<keyof TierParams, Range> } = {
  frozen: {
    width: { min: 0.8, max: 1.6, step: 0.01 },
    tracking: { min: 0, max: 400, step: 2 },
    sidebearing: { min: 0, max: 150, step: 1 },
    points: { min: 3, max: 8, step: 1 },
    rot: { min: 0, max: 90, step: 1 },
  },
  tier: {
    min: { min: 0, max: 120, step: 1 },
    star: { min: 0, max: 400, step: 2 },
    contrast: { min: 1.0, max: 3.0, step: 0.01 },
    trim: { min: 0, max: 1.5, step: 0.01 },
    stroke: { min: 4, max: 120, step: 1 },
    pointiness: { min: 0, max: 1, step: 0.01 },
  },
};

const FROZEN_KEYS = Object.keys(PARAM_RANGES.frozen) as Array<keyof FrozenParams>;
const TIER_KEYS = Object.keys(PARAM_RANGES.tier) as Array<keyof TierParams>;

export function shippedParams(): AlmagestParams {
  const g = getGenerator();
  const tiers = {} as Record<TierName, TierParams>;
  for (const t of TIER_NAMES) tiers[t] = { ...g.TIERS[t] };
  return { frozen: { ...g.FROZEN }, tiers };
}

function clampNum(v: unknown, r: Range, key: string): number {
  if (typeof v !== "number" || !isFinite(v)) throw new Error(`almagest params: ${key} must be a finite number`);
  return Math.min(r.max, Math.max(r.min, v));
}

export function validateParams(input: unknown): AlmagestParams {
  if (!input || typeof input !== "object") throw new Error("almagest params: expected an object");
  const o = input as { frozen?: unknown; tiers?: unknown };
  if (!o.frozen || typeof o.frozen !== "object" || !o.tiers || typeof o.tiers !== "object") throw new Error("almagest params: missing frozen/tiers");
  const frozenIn = o.frozen as Record<string, unknown>;
  const frozen = {} as FrozenParams;
  for (const k of FROZEN_KEYS) frozen[k] = clampNum(frozenIn[k], PARAM_RANGES.frozen[k], `frozen.${k}`);
  frozen.points = Math.round(frozen.points);
  const tiersIn = o.tiers as Record<string, Record<string, unknown>>;
  const tiers = {} as Record<TierName, TierParams>;
  for (const t of TIER_NAMES) {
    const src = tiersIn[t];
    if (!src || typeof src !== "object") throw new Error(`almagest params: missing tier ${t}`);
    const out = {} as TierParams;
    for (const k of TIER_KEYS) out[k] = clampNum(src[k], PARAM_RANGES.tier[k], `tiers.${t}.${k}`);
    tiers[t] = out;
  }
  // Breakpoint invariant: Display.min > Mid.min > Text.min = 0.
  tiers.Text.min = 0;
  if (tiers.Mid.min <= 0) tiers.Mid.min = 1;
  if (tiers.Display.min <= tiers.Mid.min) tiers.Display.min = tiers.Mid.min + 1;
  return { frozen, tiers };
}

export function paramsEqual(a: AlmagestParams, b: AlmagestParams): boolean {
  return toJSON(a) === toJSON(b);
}

export function toJSON(p: AlmagestParams): string {
  const ordered = {
    frozen: Object.fromEntries(FROZEN_KEYS.map((k) => [k, p.frozen[k]])),
    tiers: Object.fromEntries(TIER_NAMES.map((t) => [t, Object.fromEntries(TIER_KEYS.map((k) => [k, p.tiers[t][k]]))])),
  };
  return JSON.stringify(ordered, null, 2);
}

export function fromJSON(s: string): AlmagestParams {
  return validateParams(JSON.parse(s));
}
