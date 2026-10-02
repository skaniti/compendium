import { apiFetch } from "@/lib/api";
import type { ClusterMembers, ClustersSummary, UnclusteredResponse } from "@/lib/clusters";
import { STALE_API_MESSAGE } from "@/lib/overview";

export async function fetchClustersSummary(): Promise<ClustersSummary> {
  const res = await apiFetch("/api/clusters/summary");
  if (res.status === 404) throw new Error(STALE_API_MESSAGE);
  if (!res.ok) throw new Error(`fetchClustersSummary failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchClusterMembers(id: number): Promise<ClusterMembers> {
  const res = await apiFetch(`/api/clusters/${id}/pages`);
  if (!res.ok) throw new Error(`fetchClusterMembers failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchUnclustered(limit: number, offset: number): Promise<UnclusteredResponse> {
  const res = await apiFetch(`/api/clusters/unclustered?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`fetchUnclustered failed: ${res.status} ${res.statusText}`);
  return res.json();
}
