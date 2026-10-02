import type {
  EvalRunDetail, EvalRunRow, EvalRunsResponse, ModelRow, PromptDetail, PromptTask, PromptsAdminStatus, PromptsSummary,
} from "@/lib/prompts";

export function modelRow(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "stage-a", use: "Stage A", detail: "Does the first thing.", model: "model-x", source: "settings.model_x",
    provider: "provider-p", price_in: 0.15, price_out: 0.6, prompt: "alpha_task_v2", ...over,
  };
}

export function task(over: Partial<PromptTask> = {}): PromptTask {
  return {
    task: "alpha_task", label: "Alpha task", live: "alpha_task_v2", selector: "ALPHA_VERSION",
    prompts: [
      { name: "alpha_task_v1", version: "v1", description: "First alpha.", techniques: ["zero-shot"], live: false, overridden: true },
      { name: "alpha_task_v2", version: "v2", description: "Second alpha.", techniques: ["few-shot"], live: true, overridden: false },
    ],
    ...over,
  };
}

export function adminStatus(over: Partial<PromptsAdminStatus> = {}): PromptsAdminStatus {
  return { overrides: { configured: true, readable: true, count: 1 }, evals: { configured: false }, ...over };
}

export function summary(over: Partial<PromptsSummary> = {}): PromptsSummary {
  return {
    models: [modelRow(), modelRow({ id: "stage-b", use: "Stage B", model: "model-y", source: "settings.model_y", provider: null, price_in: null, price_out: null, prompt: null })],
    unused_models: [],
    tasks: [
      task(),
      task({
        task: "beta_task", label: "Beta task", live: null, selector: null,
        prompts: [{ name: "beta_task_v1", version: "v1", description: "Only beta.", techniques: [], live: false, overridden: false }],
      }),
    ],
    admin: null,
    ...over,
  };
}

export function detail(over: Partial<PromptDetail> = {}): PromptDetail {
  return {
    name: "alpha_task_v2", task: "alpha_task", task_label: "Alpha task", version: "v2", description: "Second alpha.",
    techniques: ["few-shot"], placeholders: ["title"], live: true, task_has_live: true, overridden: false,
    registry_template: "Registry text for {title}", ...over,
  };
}

export function evalRuns(over: Partial<EvalRunsResponse> = {}): EvalRunsResponse {
  return { runs: [], configured: false, readable: true, skipped: 0, ...over };
}

export function evalRow(over: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    run_id: "run-001", timestamp: "2026-03-05T10:00:00", prompt_name: "alpha_gate", prompt_version: "v2",
    fixture_set: "set-a", model: "model-x", selection: { accuracy: 0.92, n: 50 }, stress: null,
    cost_usd: null, wall_time_s: 42, cache_hits: 3, cache_misses: 7,
    delta: { vs_version: "v1.0", vs_run_id: "run-000", selection: 0.02, stress: null }, ...over,
  };
}

export function evalDetail(over: Partial<EvalRunDetail> = {}): EvalRunDetail {
  return {
    run_id: "run-001", timestamp: "2026-03-05T10:00:00", prompt_name: "alpha_gate", prompt_version: "v2",
    fixture_set: "set-a", fixture_version: "1.1", model: "model-x", git_sha: "abcdef1234567", notes: null,
    totals: { cost_usd: 1.5, wall_time_s: 42, llm_calls: 20, cache_hits: 3, cache_misses: 7 },
    type_counts: { selection: 4, stress: 2 },
    metrics: {
      selection: {
        accuracy: 0.75, n_fixtures: 4, n_correct: 3, n_wrong: 1, n_errored: 0,
        confusion: { keep: { keep: 2, drop: 1 }, drop: { drop: 1 } },
        per_class: {
          keep: { tp: 2, fp: 0, fn: 1, precision: 1, recall: 0.75, f1: 0.8 },
          drop: { tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1, f1: 0.6667 },
        },
        per_threat_recall: {}, cost_weighted_scalar: 0.81,
      },
      stress: {
        accuracy: 0.5, n_fixtures: 2, n_correct: 1, n_wrong: 1, n_errored: 0,
        confusion: { block: { block: 1 }, allow: { block: 1 } },
        per_class: { block: { tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5, f1: null } },
        per_threat_recall: { zeta: 0.4, alpha: 0.9 }, cost_weighted_scalar: null,
      },
    },
    fixtures: [
      { fixture_id: "fx-001", type: "selection", threat_category: null, expected: "keep", actual: "keep", status: "correct", error: null, from_cache: false, cost_usd: 0.1, latency_ms: 10, input_tokens: 1, output_tokens: 1, detail: { actual_output: "keep", expected_output: "keep", raw_response: null } },
      { fixture_id: "fx-002", type: "stress", threat_category: "zeta", expected: "block", actual: "allow", status: "wrong", error: null, from_cache: false, cost_usd: 0.1, latency_ms: 10, input_tokens: 1, output_tokens: 1, detail: { actual_output: "allow", expected_output: "block", raw_response: null } },
      { fixture_id: "fx-003", type: "selection", threat_category: null, expected: "keep", actual: null, status: "error", error: "boom", from_cache: null, cost_usd: null, latency_ms: null, input_tokens: null, output_tokens: null, detail: { actual_output: null, expected_output: "keep", raw_response: null } },
    ],
    fixtures_total: 3, ...over,
  };
}
