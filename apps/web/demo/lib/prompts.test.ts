import { describe, it, expect } from "vitest";
import {
  ADMIN_REQUIRED, ADMIN_STATUS, EVALS_NOT_CONFIGURED, NOT_CONFIGURED, PROMPT_NOT_FOUND, RUN_NOT_FOUND, VIEWING_AS_DEMO,
  detailFor, evalDetail, evalsList, overrideWrite, summaryFor,
} from "./prompts.mjs";

const summary = { models: [], unused_models: [], tasks: [], admin: null };
const map = { alpha_v1: { name: "alpha_v1", overridden: false, registry_template: "T" } };

describe("prompts stub", () => {
  it("summary by role, input untouched", () => {
    expect(summaryFor(summary, false).admin).toBeNull();
    expect(summaryFor(summary, true).admin).toEqual(ADMIN_STATUS);
    expect(ADMIN_STATUS).toEqual({ overrides: { configured: false, readable: true, count: 0 }, evals: { configured: false } });
    expect(summary.admin).toBeNull();
  });
  it("detail by role", () => {
    expect(detailFor(map, "alpha_v1", false)).toEqual(map.alpha_v1);
    expect(detailFor(map, "alpha_v1", true)).toEqual({ ...map.alpha_v1, override: null });
    expect(detailFor(map, "nope_v1", true)).toBeNull();
    expect(detailFor(map, "toString", true)).toBeNull();
    expect("override" in map.alpha_v1).toBe(false);
  });
  it("writes: 403 plain demo, 403 viewing as demo, 404 unknown, 409 not configured", () => {
    expect(overrideWrite(map, "alpha_v1", false)).toEqual({ status: 403, body: { detail: ADMIN_REQUIRED } });
    expect(overrideWrite(map, "alpha_v1", true, true)).toEqual({ status: 403, body: { detail: VIEWING_AS_DEMO } });
    expect(overrideWrite(map, "nope_v1", true, true)).toEqual({ status: 403, body: { detail: VIEWING_AS_DEMO } });
    expect(overrideWrite(map, "nope_v1", true)).toEqual({ status: 404, body: { detail: PROMPT_NOT_FOUND } });
    expect(overrideWrite(map, "alpha_v1", true)).toEqual({ status: 409, body: { detail: NOT_CONFIGURED } });
  });
  it("evals", () => {
    expect(evalsList(false)).toEqual({ status: 403, body: { detail: ADMIN_REQUIRED } });
    expect(evalsList(true, true)).toEqual({ status: 403, body: { detail: VIEWING_AS_DEMO } });
    expect(evalDetail(true, true)).toEqual({ status: 403, body: { detail: VIEWING_AS_DEMO } });
    expect(evalsList(true)).toEqual({ status: 200, body: EVALS_NOT_CONFIGURED });
    expect(evalDetail(false).status).toBe(403);
    expect(evalDetail(true)).toEqual({ status: 404, body: { detail: RUN_NOT_FOUND } });
    expect(EVALS_NOT_CONFIGURED).toEqual({ configured: false, readable: false, runs: [], skipped: 0 });
  });
});
