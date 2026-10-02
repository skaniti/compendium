// Prompts dev view fetchers (per-view commit isolation, spec R22).
import { apiFetch } from "@/lib/api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import type {
  EvalRunDetail, EvalRunsResponse, PromptDetail, PromptsSummary, ResetOverrideResult, SaveOverrideResult,
} from "@/lib/prompts";

/** The server's string `detail` when it sent one, else "<fn> failed: <status> <statusText>". */
async function failure(res: Response, fn: string): Promise<Error> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string" && body.detail) return new Error(body.detail);
  } catch {
    // not JSON
  }
  return new Error(`${fn} failed: ${res.status} ${res.statusText}`);
}

const enc = encodeURIComponent;

export async function fetchPromptsSummary(): Promise<PromptsSummary> {
  const res = await apiFetch("/api/prompts/summary");
  if (res.status === 404) throw new Error(STALE_API_MESSAGE);
  if (!res.ok) throw await failure(res, "fetchPromptsSummary");
  return res.json();
}

export async function fetchPromptDetail(name: string): Promise<PromptDetail> {
  const res = await apiFetch(`/api/prompts/templates/${enc(name)}`);
  if (!res.ok) throw await failure(res, "fetchPromptDetail");
  return res.json();
}

export async function savePromptOverride(name: string, template: string): Promise<SaveOverrideResult> {
  const res = await apiFetch(`/api/prompts/templates/${enc(name)}/override`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template }),
  });
  if (!res.ok) throw await failure(res, "savePromptOverride");
  return res.json();
}

export async function resetPromptOverride(name: string): Promise<ResetOverrideResult> {
  const res = await apiFetch(`/api/prompts/templates/${enc(name)}/override`, { method: "DELETE" });
  if (!res.ok) throw await failure(res, "resetPromptOverride");
  return res.json();
}

export async function fetchEvalRuns(): Promise<EvalRunsResponse> {
  const res = await apiFetch("/api/prompts/evals");
  if (!res.ok) throw await failure(res, "fetchEvalRuns");
  return res.json();
}

export async function fetchEvalRun(runId: string): Promise<EvalRunDetail> {
  const res = await apiFetch(`/api/prompts/evals/${enc(runId)}`);
  if (!res.ok) throw await failure(res, "fetchEvalRun");
  return res.json();
}
