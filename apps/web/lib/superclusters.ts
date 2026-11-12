import type { TopicSuggestion } from "./types";

// SUPERCLUSTERS widget constants + text helpers, shared by HeaderCards and
// ScPopover so the slot allowance lives in exactly one place. The backend
// does not cap topic_interests, so this is a UI-side allowance only.
// 24 (2026-11-12) is a play-area value for the suggestions work, to be dialled
// back later: change it here and the card layout (scLayout below, applied as
// CSS variables by HeaderCards) follows, back to one row at 12.
export const MAX_SUPERCLUSTERS = 24;

export interface ScLayout {
  cols: number;
  rows: number;
  tilePx: number; // tile edge, border included
  gapPx: number;
  iconPx: number; // allocated-tile icon
}

// Tile grid for an allowance inside the fixed-height (82px) header card:
// above 12 slots two rows of ceil(n/2) 23px tiles (49px tall, the most the
// card's body fits), otherwise the original single row of 33px tiles.
export function scLayout(allowance: number): ScLayout {
  if (allowance > 12) return { cols: Math.ceil(allowance / 2), rows: 2, tilePx: 23, gapPx: 3, iconPx: 17 };
  return { cols: Math.max(1, allowance), rows: 1, tilePx: 33, gapPx: 4, iconPx: 34 };
}

// Empty slots that show a suggestion as a ghost tile (the rest stay "+").
export const MAX_GHOST_TILES = 3;

// Member clusters listed in the suggestion popover before "+N more".
export const SUGGESTION_MEMBER_PREVIEW = 8;

export function clustersPagesLabel(s: Pick<TopicSuggestion, "member_count" | "page_count">): string {
  const c = s.member_count === 1 ? "1 cluster" : `${s.member_count} clusters`;
  const p = s.page_count === 1 ? "1 page" : `${s.page_count} pages`;
  return `${c} · ${p}`;
}

// "N days" under 60, else "N months" (30-day months, rounded).
export function spanLabel(spanDays: number): string {
  if (spanDays < 60) return `${spanDays} ${spanDays === 1 ? "day" : "days"}`;
  return `${Math.round(spanDays / 30)} months`;
}

// "<n> clusters · <n> pages · active in <n> weeks over <span>"; the "active
// in ..." part is left out when the evidence lacks the numbers or they are
// below 1 (a week count of 0 or a zero-day span says nothing).
export function suggestionReason(s: TopicSuggestion): string {
  const base = clustersPagesLabel(s);
  const weeks = s.evidence?.n_weeks;
  const span = s.evidence?.span_days;
  if (typeof weeks !== "number" || typeof span !== "number" || weeks < 1 || span < 1) return base;
  return `${base} · active in ${weeks} ${weeks === 1 ? "week" : "weeks"} over ${spanLabel(span)}`;
}
