import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClusterMembers, fetchClustersSummary, fetchUnclustered } from "./clusters-api";
import { STALE_API_MESSAGE } from "./overview";

const respond = (status: number, body: unknown = {}) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Err" }));
afterEach(() => vi.restoreAllMocks());

describe("clusters fetchers", () => {
  it("summary: 200 parses, 404 is the stale-API sentinel, others throw", async () => {
    respond(200, { run: null });
    await expect(fetchClustersSummary()).resolves.toEqual({ run: null });
    vi.restoreAllMocks(); respond(404);
    await expect(fetchClustersSummary()).rejects.toThrow(STALE_API_MESSAGE);
    vi.restoreAllMocks(); respond(500);
    await expect(fetchClustersSummary()).rejects.toThrow("fetchClustersSummary failed: 500");
  });
  it("members and unclustered hit the right URLs", async () => {
    const spy = respond(200, { pages: [] });
    await fetchClusterMembers(42);
    await fetchUnclustered(50, 100);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual(["/api/clusters/42/pages", "/api/clusters/unclustered?limit=50&offset=100"]);
  });
  it("members 404 throws (not the stale sentinel)", async () => {
    respond(404);
    await expect(fetchClusterMembers(7)).rejects.toThrow("fetchClusterMembers failed: 404");
  });
});
