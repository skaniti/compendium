export function computeOverviewSummary(
  pages: unknown[],
  captures: unknown[],
  clusters: unknown,
  range: string | null,
  nowMs: number,
): Record<string, unknown>;
export function computeOverviewTimeline(
  pages: unknown[],
  captures: unknown[],
  range: string | null,
  tz: string,
  nowMs: number,
): { buckets: Array<{ start: string; captured: number; in_graph: number; captures: { desktop: number; phone: number }; spend: Record<string, number> }> } & Record<string, unknown>;
