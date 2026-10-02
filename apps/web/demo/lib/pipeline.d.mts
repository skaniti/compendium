export function computeSummary(
  allRows: unknown[],
  range: string | null,
  nowMs: number,
  configs: { rule_filter_config: unknown; skip_gate_config: unknown },
): { rule_filter_config: { counts: Record<string, number>; lists_visible: boolean; [list: string]: unknown } } & Record<string, unknown>;
