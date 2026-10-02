import { afterEach, describe, expect, it, vi } from "vitest";
import { STALE_API_MESSAGE } from "./overview";
import {
  fetchEvalRun, fetchEvalRuns, fetchPromptDetail, fetchPromptsSummary, resetPromptOverride, savePromptOverride,
} from "./prompts-api";

function mockFetch(status: number, body: unknown, statusText = "") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText }));
}
afterEach(() => vi.restoreAllMocks());

describe("prompts api", () => {
  it("summary: ok, stale on 404, detail or fallback message otherwise", async () => {
    let spy = mockFetch(200, { models: [] });
    expect(await fetchPromptsSummary()).toEqual({ models: [] });
    expect(String(spy.mock.calls[0][0])).toBe("/api/prompts/summary");
    vi.restoreAllMocks();
    mockFetch(404, { detail: "Not Found" });
    await expect(fetchPromptsSummary()).rejects.toThrow(STALE_API_MESSAGE);
    vi.restoreAllMocks();
    mockFetch(500, "<html>", "Server Error");
    await expect(fetchPromptsSummary()).rejects.toThrow("fetchPromptsSummary failed: 500 Server Error");
    vi.restoreAllMocks();
    spy = mockFetch(503, { detail: "busy" });
    await expect(fetchPromptsSummary()).rejects.toThrow("busy");
  });
  it("detail encodes the name and does not map 404 to stale", async () => {
    const spy = mockFetch(404, { detail: "prompt not found" });
    await expect(fetchPromptDetail("a b")).rejects.toThrow("prompt not found");
    expect(String(spy.mock.calls[0][0])).toBe("/api/prompts/templates/a%20b");
  });
  it("save PUTs JSON and surfaces the server's message", async () => {
    let spy = mockFetch(200, { name: "x", cleared: false });
    await savePromptOverride("x_v1", "T {a}");
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("/api/prompts/templates/x_v1/override");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ template: "T {a}" });
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    vi.restoreAllMocks();
    spy = mockFetch(422, { detail: "The template is empty." });
    await expect(savePromptOverride("x_v1", "")).rejects.toThrow("The template is empty.");
    vi.restoreAllMocks();
    mockFetch(422, { detail: [{ msg: "field required" }] }, "Unprocessable Entity");
    await expect(savePromptOverride("x_v1", "")).rejects.toThrow("savePromptOverride failed: 422 Unprocessable Entity");
  });
  it("reset DELETEs", async () => {
    const spy = mockFetch(200, { removed: true });
    await resetPromptOverride("x_v1");
    expect(spy.mock.calls[0][1]?.method).toBe("DELETE");
  });
  it("evals", async () => {
    let spy = mockFetch(200, { configured: false, readable: false, runs: [], skipped: 0 });
    await fetchEvalRuns();
    expect(String(spy.mock.calls[0][0])).toBe("/api/prompts/evals");
    vi.restoreAllMocks();
    spy = mockFetch(200, { run_id: "r/1" });
    await fetchEvalRun("r/1");
    expect(String(spy.mock.calls[0][0])).toBe("/api/prompts/evals/r%2F1");
  });
});
