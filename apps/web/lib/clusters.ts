// Clusters dev view: types and pure helpers. Kept out of lib/types.ts and
// lib/api.ts on purpose (per-view commit isolation, spec R15).
import { formatRunDate, shareOf } from "@/lib/overview";
import type { PromptOverrideState } from "@/lib/prompts";

export type ClusterRunStatus = "running" | "completed" | "failed" | "archived";
export interface ClusterRun {
  id: number; status: ClusterRunStatus; started_at: string | null; completed_at: string | null;
  cluster_count: number | null; noise_count: number | null; naming_cost: number | null; elapsed_seconds: number | null;
}
export type CurrentRun = Omit<ClusterRun, "status">;
export interface ClusterPages { in_graph: number; clustered: number; clustered_in_graph: number; not_clustered: number; featured: number; since_run: number }
export interface ClusterGroup { label: string; source: string; tier: string }
export interface ClusterRow { id: number; name: string; slug: string; size: number; confidence: number | null; name_carried: boolean; super_cluster: string | null; group: ClusterGroup | null }
export interface EdgeBin { lo: number; hi: number; count: number }
export interface EdgeSummary { count: number; min: number | null; max: number | null; mean: number | null; bins: EdgeBin[] }
export interface ClustersConfig {
  clustering: {
    embedding_model: string; text_contract: string; min_cluster_size: number; min_cluster_size_divisor: number;
    effective_min_cluster_size: number | null; min_samples: number; selection_method: string; selection_epsilon: number;
    metric: "cosine" | "euclidean"; umap_dims: number; umap_n_neighbors: number; edge_threshold: number; max_edges_per_cluster: number;
  };
  naming: {
    model: string; temperature: number; max_tokens: number; sample_size: number; prompt_name: string; prompt: string | null;
    /** Absent from payloads recorded before 2026-10-04. */
    prompt_override?: PromptOverrideState;
  };
}
export interface ClustersSummary {
  run: CurrentRun | null; pages: ClusterPages | null; clusters: ClusterRow[];
  groups: { superclusters: number; topics: number; suggested: number };
  edges: EdgeSummary; runs: { total: number; items: ClusterRun[] }; config: ClustersConfig;
}
export interface ClusterMember { id: number; title: string | null; domain: string | null; url: string | null }
export interface ClusterMembers { cluster_id: number; total: number; pages: ClusterMember[] }
export interface UnclusteredPage extends ClusterMember { featured: boolean; since_run: boolean }
export interface UnclusteredResponse { total: number; limit: number; offset: number; pages: UnclusteredPage[] }
export type RunStatusLabel = "current" | "kept" | "archived" | "failed" | "running";
export type ClusterSortKey = "name" | "size" | "confidence";

/** HDBSCAN noise (the run's snapshot) over the pages clustering considered (spec R4). */
export function noiseShare(run: Pick<CurrentRun, "noise_count">, pages: Pick<ClusterPages, "clustered">): { noise: number; considered: number; share: string } {
  const noise = run.noise_count ?? 0;
  const considered = noise + pages.clustered;
  return { noise, considered, share: shareOf(noise, considered) };
}

const SIZE_BINS: [number, number][] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 7], [8, 9], [10, 14], [15, 19], [20, 29], [30, 49], [50, 99], [100, Infinity]];
const binOf = (s: number) => SIZE_BINS.findIndex(([lo, hi]) => s >= lo && s <= hi);
/** Clusters per size bin, from the smallest occupied bin to the largest; empty clusters are left out. */
export function sizeBins(sizes: number[]): { label: string; count: number }[] {
  const real = sizes.filter((s) => s >= 1);
  if (real.length === 0) return [];
  const idx = real.map(binOf);
  return SIZE_BINS.slice(Math.min(...idx), Math.max(...idx) + 1).map(([lo, hi]) => ({
    label: hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}–${hi}`,
    count: real.filter((s) => s >= lo && s <= hi).length,
  }));
}

export function visibleEdgeBins(edges: EdgeSummary, threshold: number): (EdgeBin & { label: string })[] {
  const first = Math.max(0, Math.min(Math.floor(threshold * 10 + 1e-9), edges.bins.length - 1));
  return edges.bins.slice(first).map((b) => ({ ...b, label: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%` }));
}

export function runStatusLabel(run: Pick<ClusterRun, "id" | "status">, currentId: number | null): RunStatusLabel {
  if (run.status === "completed") return run.id === currentId ? "current" : "kept";
  return run.status;
}

/** Runs that finished with counts, oldest first (the API sends newest first). */
export function finishedRuns(items: ClusterRun[]): ClusterRun[] {
  return items.filter((r) => r.cluster_count !== null && (r.status === "completed" || r.status === "archived")).reverse();
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "Sep 23, 14:05" in the viewer's zone; the year is added when it is not the current one. */
export function formatRunDateTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = formatRunDate(iso) + (d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`);
  return `${date}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function percent(v: number | null): string { return v === null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`; }

/** Only http(s) URLs become links (stored URLs are page data, not trusted markup). */
export function safeHref(url: string | null): string | null { return url && /^https?:\/\//i.test(url) ? url : null; }

const byName = (a: ClusterRow, b: ClusterRow) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
export function sortClusters(rows: ClusterRow[], key: ClusterSortKey, dir: "asc" | "desc"): ClusterRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const tie = (a: ClusterRow, b: ClusterRow) => b.size - a.size || byName(a, b);
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    if (key === "size") return sign * (a.size - b.size) || byName(a, b);
    if (a.confidence === null || b.confidence === null) {
      return a.confidence === b.confidence ? tie(a, b) : a.confidence === null ? 1 : -1;
    }
    return sign * (a.confidence - b.confidence) || tie(a, b);
  });
}
