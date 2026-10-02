"use client";
import StackedBarChart from "@/components/charts/StackedBarChart";
import { percent, sizeBins, visibleEdgeBins, type ClusterRow, type EdgeSummary } from "@/lib/clusters";
import { formatCount, plural } from "@/lib/overview";

const SIZE_COLOR = "var(--highlight)";
const SIMILARITY_COLOR = "color-mix(in oklch, var(--text) 70%, var(--surface))";

export default function ClusterDistributions({ clusters, edges, threshold, maxEdges }: { clusters: ClusterRow[]; edges: EdgeSummary; threshold: number; maxEdges: number }) {
  const sizes = sizeBins(clusters.map((c) => c.size));
  const sim = visibleEdgeBins(edges, threshold);
  return (
    <div className="clusters-dist-row">
      <section className="dev-panel">
        <div className="dev-panel-head"><h3 className="dev-section-title">Cluster sizes</h3></div>
        <p className="clusters-caption">Pages per cluster in the current run.</p>
        {sizes.length > 0 ? (
          <StackedBarChart mode="count" legend={false} height={200} yTitle="Clusters" yFormat={formatCount}
            cats={sizes.map((b) => ({ title: `${b.label} pages`, axis: b.label }))}
            series={[{ name: "Clusters", color: SIZE_COLOR, values: sizes.map((b) => b.count) }]}
            tip={(i) => [plural(sizes[i].count, "cluster")]} />
        ) : <p className="dev-empty dev-empty-inline">No clusters in this run.</p>}
      </section>
      <section className="dev-panel">
        <div className="dev-panel-head"><h3 className="dev-section-title">Similarity between clusters</h3></div>
        <p className="clusters-caption">Cosine similarity of cluster centroids. Edges are kept above {percent(threshold)}, at most {maxEdges} per cluster; the graph draws them as links.</p>
        {edges.count > 0 ? (
          <StackedBarChart mode="count" legend={false} height={200} yTitle="Edges" yFormat={formatCount}
            cats={sim.map((b) => ({ title: b.label, axis: b.label }))}
            series={[{ name: "Edges", color: SIMILARITY_COLOR, values: sim.map((b) => b.count) }]}
            tip={(i) => [plural(sim[i].count, "edge")]} />
        ) : <p className="dev-empty dev-empty-inline">No similarity edges in this run.</p>}
      </section>
    </div>
  );
}
