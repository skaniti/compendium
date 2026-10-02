import type { ClustersConfig } from "@/lib/clusters";
import { percent } from "@/lib/clusters";

function Row({ label, value }: { label: string; value: string }) {
  return <div className="config-row"><span className="config-label">{label}</span><span className="config-value">{value}</span></div>;
}

export default function ClusterConfigPanels({ config }: { config: ClustersConfig }) {
  const c = config.clustering, n = config.naming;
  const eff = c.effective_min_cluster_size;
  const distance = c.metric === "euclidean" ? `euclidean on UMAP-${c.umap_dims} (nn=${c.umap_n_neighbors})` : "cosine (precomputed)";
  return (
    <div className="clusters-config-row">
      <details className="dev-config-panel dev-panel">
        <summary>
          <span className="dev-config-title">Clustering · HDBSCAN</span>
          <span className="dev-chip">{c.embedding_model}</span>
          <span className="dev-chip">min size {eff ?? c.min_cluster_size}</span>
          <span className="dev-chip">{c.selection_method}</span>
          <span className="dev-chip">{c.metric}</span>
        </summary>
        <div className="config-body">
          <Row label="Embedding model" value={c.embedding_model} />
          <Row label="Text contract" value={c.text_contract} />
          <Row label="Min cluster size" value={`${c.min_cluster_size}${eff === null ? "" : ` · this run ${eff}`} (max(${c.min_cluster_size}, pages ÷ ${c.min_cluster_size_divisor}))`} />
          <Row label="Min samples" value={String(c.min_samples)} />
          <Row label="Selection" value={`${c.selection_method} (epsilon ${c.selection_epsilon})`} />
          <Row label="Distance" value={distance} />
          <Row label="Edge threshold" value={percent(c.edge_threshold)} />
          <Row label="Max edges per cluster" value={String(c.max_edges_per_cluster)} />
        </div>
      </details>
      <details className="dev-config-panel dev-panel">
        <summary>
          <span className="dev-config-title">Cluster naming · LLM</span>
          <span className="dev-chip">{n.model}</span>
          <span className="dev-chip">temp {n.temperature}</span>
          <span className="dev-chip">{n.prompt_name}</span>
        </summary>
        <div className="config-body">
          <Row label="Model" value={n.model} />
          <Row label="Temperature" value={n.temperature.toFixed(1)} />
          <Row label="Max tokens" value={String(n.max_tokens)} />
          <Row label="Sample" value={`up to ${n.sample_size} pages per cluster`} />
          <Row label="Prompt" value={n.prompt_name} />
          {n.prompt ? <pre className="config-prompt">{n.prompt}</pre> : <p className="dev-empty dev-empty-inline">Prompt template not found.</p>}
        </div>
      </details>
    </div>
  );
}
