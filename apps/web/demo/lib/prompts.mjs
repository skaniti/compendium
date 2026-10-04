// Prompts dev view for the demo stub. TWIN of backend/api/routers/prompts.py
// for the demo stub: fixtures are the plain-demo payloads recorded from the
// seeded TEST database (spec R24); an admin gets the honest not-configured
// state, since the demo has no override file and no eval runs. An admin viewing
// as demo gets exactly the plain-demo payloads (2026-10-04).

export const ADMIN_REQUIRED = "Admin context required";
export const PROMPT_NOT_FOUND = "prompt not found";
export const RUN_NOT_FOUND = "run not found";
export const NOT_CONFIGURED = "Prompt overrides are not configured on this deployment.";
export const VIEWING_AS_DEMO = "Disabled in demo view";

export const ADMIN_STATUS = Object.freeze({
  overrides: Object.freeze({ configured: false, readable: true, count: 0 }),
  evals: Object.freeze({ configured: false }),
});
export const EVALS_NOT_CONFIGURED = Object.freeze({ configured: false, readable: false, runs: [], skipped: 0 });

/** Summary as the caller sees it: any demo identity (view-as included) `admin: null`, an admin the not-configured status. */
export function summaryFor(summary, admin) {
  return { ...structuredClone(summary), admin: admin ? structuredClone(ADMIN_STATUS) : null };
}

/** Template detail by role (admin adds `override: null`); null for an unknown name. */
export function detailFor(map, name, admin) {
  if (!Object.hasOwn(map, name)) return null;
  const detail = structuredClone(map[name]);
  return admin ? { ...detail, override: null } : detail;
}

/**
 * PUT / DELETE override: admin context (403), not while viewing as demo (403, every
 * demo identity is refused, 2026-10-04), known name (404), then not configured (409).
 */
export function overrideWrite(map, name, adminContext, viewingAsDemo = false) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  if (viewingAsDemo) return { status: 403, body: { detail: VIEWING_AS_DEMO } };
  if (!Object.hasOwn(map, name)) return { status: 404, body: { detail: PROMPT_NOT_FOUND } };
  return { status: 409, body: { detail: NOT_CONFIGURED } };
}

export function evalsList(adminContext, viewingAsDemo = false) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  if (viewingAsDemo) return { status: 403, body: { detail: VIEWING_AS_DEMO } };
  return { status: 200, body: structuredClone(EVALS_NOT_CONFIGURED) };
}

export function evalDetail(adminContext, viewingAsDemo = false) {
  if (!adminContext) return { status: 403, body: { detail: ADMIN_REQUIRED } };
  if (viewingAsDemo) return { status: 403, body: { detail: VIEWING_AS_DEMO } };
  return { status: 404, body: { detail: RUN_NOT_FOUND } };
}
