import type { ClusterRow, ClusterRun, ClustersSummary, UnclusteredResponse } from "@/lib/clusters";

export const row = (id: number, size: number, over: Partial<ClusterRow> = {}): ClusterRow => ({
  id, name: `Cluster ${id}`, slug: `cluster-${id}`, size, confidence: 0.5 + (id % 4) / 10,
  name_carried: id % 2 === 0, super_cluster: id % 3 === 0 ? "orbits" : null,
  group: id % 5 === 0 ? { label: "Night sky", source: "suggested", tier: "casual" } : null, ...over,
});
export const runOf = (id: number, status: ClusterRun["status"], over: Partial<ClusterRun> = {}): ClusterRun => ({
  id, status, started_at: `2026-0${(id % 8) + 1}-1${id % 9}T08:30:00Z`, completed_at: `2026-0${(id % 8) + 1}-1${id % 9}T08:31:00Z`,
  cluster_count: status === "failed" ? null : 10 + id, noise_count: status === "failed" ? null : 4 + (id % 3),
  naming_cost: status === "failed" ? null : 0.0004, elapsed_seconds: status === "failed" ? null : 7.5, ...over,
});
export function summary(over: Partial<ClustersSummary> = {}): ClustersSummary {
  const clusters = Array.from({ length: 30 }, (_, i) => row(i + 1, 2 + ((i * 7) % 11)));
  return {
    run: { id: 40, started_at: "2026-09-01T08:00:00Z", completed_at: "2026-09-01T08:02:00Z", elapsed_seconds: 7.5, naming_cost: 0.0004, cluster_count: 30, noise_count: 12 },
    pages: { in_graph: 400, clustered: 180, clustered_in_graph: 176, not_clustered: 224, featured: 6, since_run: 3 },
    clusters,
    groups: { superclusters: 3, topics: 4, suggested: 5 },
    edges: { count: 41, min: 0.18, max: 0.86, mean: 0.47, bins: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, count: i >= 1 && i <= 8 ? i : 0 })) },
    runs: { total: 14, items: [runOf(40, "completed"), runOf(39, "failed"), runOf(38, "completed"), ...Array.from({ length: 11 }, (_, i) => runOf(37 - i, "archived"))] },
    config: {
      clustering: { embedding_model: "embed-small", text_contract: "ct1", min_cluster_size: 2, min_cluster_size_divisor: 150, effective_min_cluster_size: 2, min_samples: 2, selection_method: "eom", selection_epsilon: 0, metric: "cosine", umap_dims: 0, umap_n_neighbors: 15, edge_threshold: 0.15, max_edges_per_cluster: 3 },
      naming: { model: "namer-mini", temperature: 0.3, max_tokens: 30, sample_size: 10, prompt_name: "cluster_naming_v1", prompt: "Name this cluster of {n_pages} pages." },
    },
    ...over,
  };
}
export const unclustered = (total: number, offset = 0): UnclusteredResponse => ({
  total, limit: 50, offset,
  pages: Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, i) => ({
    id: 1000 + offset + i, title: `Loose page ${offset + i + 1}`, domain: "example.org", url: `https://example.org/loose/${offset + i + 1}`,
    featured: offset + i === 0, since_run: offset + i === 1,
  })),
});
