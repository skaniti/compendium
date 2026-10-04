// Prompts dev view: types and pure helpers. Kept out of lib/types.ts and
// lib/api.ts (per-view commit isolation, spec R22).

export interface ModelRow {
  id: string; use: string; detail: string; model: string; source: string;
  provider: string | null; price_in: number | null; price_out: number | null; prompt: string | null;
}
export interface UnusedModel { model: string; source: string }
export interface PromptVersion {
  name: string; version: string; description: string; techniques: string[]; live: boolean; overridden: boolean;
}
export interface PromptTask { task: string; label: string; live: string | null; selector: string | null; prompts: PromptVersion[] }
export interface PromptsAdminStatus {
  overrides: { configured: boolean; readable: boolean; count: number };
  evals: { configured: boolean };
}
export interface PromptsSummary { models: ModelRow[]; unused_models: UnusedModel[]; tasks: PromptTask[]; admin: PromptsAdminStatus | null }
export interface PromptDetail {
  name: string; task: string; task_label: string; version: string; description: string; techniques: string[];
  placeholders: string[]; live: boolean; task_has_live: boolean; overridden: boolean; registry_template: string;
  /** Present for admins only (never a demo session, view-as included): the override text, or null when none. */
  override?: string | null;
}
export interface SaveOverrideResult extends PromptDetail { cleared: boolean; missing_placeholders: string[] }
export interface ResetOverrideResult extends PromptDetail { removed: boolean }

export interface EvalScore { accuracy: number | null; n: number | null }
export interface EvalDelta { vs_version: string; vs_run_id: string; selection: number | null; stress: number | null }
export interface EvalRunRow {
  run_id: string; timestamp: string | null; prompt_name: string | null; prompt_version: string | null;
  fixture_set: string | null; model: string | null; selection: EvalScore | null; stress: EvalScore | null;
  cost_usd: number | null; wall_time_s: number | null; cache_hits: number | null; cache_misses: number | null;
  delta: EvalDelta | null;
}
export interface EvalRunsResponse { configured: boolean; readable: boolean; runs: EvalRunRow[]; skipped: number }
export interface EvalPerClass {
  tp: number | null; fp: number | null; fn: number | null; precision: number | null; recall: number | null; f1: number | null;
}
export interface EvalMetrics {
  accuracy: number | null; n_fixtures: number | null; n_correct: number | null; n_wrong: number | null;
  n_errored: number | null; confusion: Record<string, Record<string, number>>; per_class: Record<string, EvalPerClass>;
  per_threat_recall: Record<string, number>; cost_weighted_scalar: number | null;
}
export type EvalMetricType = "selection" | "stress";
export type EvalFixtureStatus = "correct" | "wrong" | "error";
export interface EvalFixture {
  fixture_id: string | null; type: string | null; threat_category: string | null; expected: string | null;
  actual: string | null; status: EvalFixtureStatus; error: string | null; from_cache: boolean | null;
  cost_usd: number | null; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null;
  detail: { actual_output: unknown; expected_output: unknown; raw_response: string | null };
}
export interface EvalRunDetail {
  run_id: string; timestamp: string | null; prompt_name: string | null; prompt_version: string | null;
  fixture_set: string | null; fixture_version: string | null; model: string | null; git_sha: string | null;
  notes: string | null;
  totals: { cost_usd: number | null; wall_time_s: number | null; llm_calls: number | null; cache_hits: number | null; cache_misses: number | null };
  type_counts: Record<string, number>; metrics: Partial<Record<EvalMetricType, EvalMetrics>>;
  fixtures: EvalFixture[]; fixtures_total: number;
}

export const MAX_TEMPLATE_CHARS = 32_000;
/** A read-only prompt's relation to a live local override: "shown" (admins), "withheld" (everyone else), null (none). */
export type PromptOverrideState = "shown" | "withheld" | null;
export const OVERRIDE_WITHHELD_NOTE = "This deployment runs a local override of this prompt. Its text is visible to admins only; below is the registry text.";
export const OVERRIDE_SHOWN_NOTE = "This is the local override this deployment runs; Prompts compares it with the registry text.";
const MINUS = "−";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function formatPrice(perMillion: number | null): string {
  if (!finite(perMillion)) return "—";
  if (perMillion > 0 && perMillion < 0.005) return "<$0.01";
  return `$${perMillion.toFixed(2)}`;
}

export function formatPriceCell(row: Pick<ModelRow, "price_in" | "price_out">): string {
  if (row.price_in === null && row.price_out === null) return "—";
  return `${formatPrice(row.price_in)} · ${formatPrice(row.price_out)}`;
}

export function formatShare(v: number | null | undefined): string {
  return finite(v) ? `${(v * 100).toFixed(1)}%` : "—";
}

export function formatAccuracy(score: EvalScore | null | undefined): string {
  if (!score || !finite(score.accuracy)) return "—";
  const pct = formatShare(score.accuracy);
  return score.n === null ? pct : `${pct} (${score.n})`;
}

export function formatDeltaPts(d: number | null | undefined): string {
  if (!finite(d)) return "—";
  const pts = d * 100;
  if (Math.abs(pts) < 0.05) return "±0.0 pts";
  return `${pts > 0 ? "+" : MINUS}${Math.abs(pts).toFixed(1)} pts`;
}

export function formatSeconds(s: number | null | undefined): string {
  if (!finite(s) || s < 0) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatEvalDateTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

export type DiffOp = "same" | "add" | "del";
export interface DiffLine { op: DiffOp; text: string }

/** Line diff (LCS); within a change, deletions come before additions. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: "same", text: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: "del", text: x[i] }); i++; }
    else { out.push({ op: "add", text: y[j] }); j++; }
  }
  while (i < n) out.push({ op: "del", text: x[i++] });
  while (j < m) out.push({ op: "add", text: y[j++] });
  return out;
}

/** The first live prompt in task order, else the first prompt, else null. */
export function initialPrompt(tasks: PromptTask[]): string | null {
  for (const t of tasks) if (t.live) return t.live;
  return tasks[0]?.prompts[0]?.name ?? null;
}

export function evalFamilies(runs: EvalRunRow[]): string[] {
  return [...new Set(runs.map((r) => r.prompt_name).filter((x): x is string => !!x))].sort();
}

export type EvalSortKey = "run" | "prompt" | "set" | "model" | "selection" | "stress" | "cost" | "time";
export type EvalSortDir = "asc" | "desc";
/** A first click sorts the text columns A to Z and the rest newest or highest first. */
export const evalSortFirstDir = (key: EvalSortKey): EvalSortDir => (key === "prompt" || key === "set" || key === "model" ? "asc" : "desc");

const versionCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function evalSortValue(r: EvalRunRow, key: EvalSortKey): string | number | null {
  const num = (v: number | null | undefined) => (finite(v) ? v : null);
  switch (key) {
    case "run": return r.timestamp || null; // the raw string, as the API orders it
    case "prompt": return r.prompt_name === null ? null : `${r.prompt_name} ${r.prompt_version ?? ""}`;
    case "set": return r.fixture_set;
    case "model": return r.model;
    case "selection": return num(r.selection?.accuracy);
    case "stress": return num(r.stress?.accuracy);
    case "cost": return num(r.cost_usd);
    case "time": return num(r.wall_time_s);
  }
}

/** Runs sorted by one column: missing values last either way, ties keep the API's newest-first order. */
export function sortEvalRuns(rows: EvalRunRow[], key: EvalSortKey, dir: EvalSortDir): EvalRunRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: evalSortValue(row, key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : versionCollator.compare(String(a.v), String(b.v));
      return sign * c || a.i - b.i;
    })
    .map((x) => x.row);
}

export function fixtureFilter(fixtures: EvalFixture[], mode: "all" | "misses"): EvalFixture[] {
  return mode === "all" ? fixtures : fixtures.filter((f) => f.status !== "correct");
}

export interface CompareRow { metric: string; a: number | null; b: number | null; delta: number | null }

/** This run (a) against another (b): accuracies, then per-threat recall over the union of threats. */
export function compareRows(a: EvalRunDetail, b: EvalRunDetail): CompareRow[] {
  const row = (metric: string, x: number | null | undefined, y: number | null | undefined): CompareRow => {
    const av = finite(x) ? x : null;
    const bv = finite(y) ? y : null;
    return { metric, a: av, b: bv, delta: av !== null && bv !== null ? av - bv : null };
  };
  const ra = a.metrics.stress?.per_threat_recall ?? {};
  const rb = b.metrics.stress?.per_threat_recall ?? {};
  const threats = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
  return [
    row("Selection accuracy", a.metrics.selection?.accuracy, b.metrics.selection?.accuracy),
    row("Stress accuracy", a.metrics.stress?.accuracy, b.metrics.stress?.accuracy),
    ...threats.map((t) => row(`Recall · ${t}`, ra[t], rb[t])),
  ].filter((r) => r.a !== null || r.b !== null);
}
