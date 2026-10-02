// Prompts dev view for the demo stub. TWIN of backend/api/routers/prompts.py
// for the demo stub: fixtures are the plain-demo payloads recorded from the
// seeded TEST database (spec R24); admin context gets the honest
// not-configured state, since the demo has no override file and no eval runs.

export const ADMIN_REQUIRED = "Admin context required";
export const PROMPT_NOT_FOUND = "prompt not found";
export const RUN_NOT_FOUND = "run not found";
export const NOT_CONFIGURED = "Prompt overrides are not configured on this deployment.";

export const ADMIN_STATUS = Object.freeze({
  overrides: Object.freeze({ configured: false, readable: true, count: 0 }),
  evals: Object.freeze({ configured: false }),
});
export const EVALS_NOT_CONFIGURED = Object.freeze({ configured: false, readable: false, runs: [], skipped: 0 });

/** Summary as the caller's role sees it: plain demo `admin: null`, admin the not-configured status. */
export function summaryFor(summary, adminContext) {
  return { ...structuredClone(summary), admin: adminContext ? structuredClone(ADMIN_STATUS) : null };
}

/** Template detail by role (admin adds `override: null`); null for an unknown name. */
export function detailFor(map, name, adminContext) {
  if (!Object.hasOwn(map, name)) return null;
  const detail = structuredClone(map[name]);
  return adminContext ? { ...detail, override: null } : detail;
}

/** PUT / DELETE override: admin-only (403), known name (404), then not configured (409). */
export function overrideWrite(map, name, adminContext) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  if (!Object.hasOwn(map, name)) return { status: 404, body: { detail: PROMPT_NOT_FOUND } };
  return { status: 409, body: { detail: NOT_CONFIGURED } };
}

export function evalsList(adminContext) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  return { status: 200, body: structuredClone(EVALS_NOT_CONFIGURED) };
}

export function evalDetail(adminContext) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  return { status: 404, body: { detail: RUN_NOT_FOUND } };
}
