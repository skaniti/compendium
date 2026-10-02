import StatCard from "@/components/dev/StatCard";
import { noiseShare, percent, type ClustersSummary } from "@/lib/clusters";
import { formatCount, formatRunDate, plural, shareOf } from "@/lib/overview";

export default function ClusterCards({ summary }: { summary: ClustersSummary }) {
  const { run, pages, clusters, groups, edges, config } = summary;
  if (!run || !pages) return null;
  const sizes = clusters.map((c) => c.size);
  const avg = clusters.length ? (sizes.reduce((a, n) => a + n, 0) / clusters.length).toFixed(1) : "0.0";
  const largest = sizes.length ? Math.max(...sizes) : 0;
  const noise = noiseShare(run, pages);
  return (
    <div className="clusters-cards">
      <StatCard label="Clusters" accent value={formatCount(clusters.length)} lines={[
        `avg ${avg} pages · largest ${formatCount(largest)}`,
        `run #${run.id} · ${formatRunDate(run.completed_at)}`,
        // Plain anchor: a full navigation, as the header's Graph toggle does (the loader's return fade), so not next/link.
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a key="graph" href="/" className="clusters-card-link">See them on the graph →</a>,
      ]} />
      <StatCard label="In a cluster" value={shareOf(pages.clustered_in_graph, pages.in_graph)} lines={[
        `${formatCount(pages.clustered_in_graph)} of ${formatCount(pages.in_graph)} pages in your graph`,
        <a key="loose" href="#clusters-unclustered" className="clusters-card-link">{formatCount(pages.not_clustered)} not in a cluster</a>,
      ]} />
      <StatCard label="Noise" value={noise.share} lines={[
        `${formatCount(noise.noise)} of ${formatCount(noise.considered)} pages clustering considered`,
        `${formatCount(pages.featured)} featured on the graph`,
      ]} />
      <StatCard label="Superclusters" value={formatCount(groups.superclusters)} lines={[
        `${plural(groups.topics, "topic")} · ${plural(groups.suggested, "suggested group")}`,
      ]} />
      <StatCard label="Similarity edges" value={formatCount(edges.count)} lines={[
        edges.count > 0 ? `mean ${percent(edges.mean)} · range ${percent(edges.min).replace("%", "")}–${percent(edges.max)}` : "No edges",
        `kept above ${percent(config.clustering.edge_threshold)}, at most ${config.clustering.max_edges_per_cluster} per cluster`,
      ]} />
    </div>
  );
}
