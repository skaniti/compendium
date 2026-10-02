import type {
  EvalRunsResponse, ModelRow, PromptDetail, PromptTask, PromptsAdminStatus, PromptsSummary,
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
