// Clusters dev view for the demo stub. The backend's responses are recorded
// from the seeded TEST database and replayed (spec R17); only paging and the
// date shift happen here. TWIN of backend/api/routers/clusters.py validation.
import { shiftIsoDateTime } from "./dates.mjs";

const INT = /^-?\d+$/;

export function shiftClustersFixtures(raw, deltaDays) {
  const shiftRun = (r) => r && { ...r, started_at: shiftIsoDateTime(r.started_at, deltaDays), completed_at: shiftIsoDateTime(r.completed_at, deltaDays) };
  return { ...raw, run: shiftRun(raw.run), runs: { ...raw.runs, items: raw.runs.items.map(shiftRun) } };
}

/** `/api/clusters/unclustered`: limit 1-200 (default 50), offset >= 0, else 422. */
export function pageUnclustered(all, params) {
  const rawLimit = params.get("limit") ?? "50", rawOffset = params.get("offset") ?? "0";
  if (!INT.test(rawLimit) || !INT.test(rawOffset)) return { status: 422, body: { detail: "invalid paging" } };
  const limit = Number(rawLimit), offset = Number(rawOffset);
  if (limit < 1 || limit > 200 || offset < 0) return { status: 422, body: { detail: "invalid paging" } };
  return { status: 200, body: { total: all.total, limit, offset, pages: all.pages.slice(offset, offset + limit) } };
}

export function membersFor(map, id) {
  return Object.hasOwn(map, String(id)) ? map[String(id)] : null;
}
