"use client";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { fetchClustersSummary } from "@/lib/clusters-api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import ClusterCards from "./ClusterCards";
import ClusterConfigPanels from "./ClusterConfigPanels";
import ClusterDistributions from "./ClusterDistributions";
import ClusterTable from "./ClusterTable";
import RunHistory from "./RunHistory";
import UnclusteredTable from "./UnclusteredTable";

export const CLUSTERS_SUBTITLE = "What the latest clustering run produced: how your pages were grouped, how confident and how related the clusters are, which pages stayed out, and how runs compare. Clusters are recomputed per run, so this view has no period.";
export const STALE_TEXT = "The API is older than this view; restart it to load clusters.";
export const NO_RUN_TEXT = "No clustering run yet. Clusters appear here after the first recluster.";

export default function ClustersView() {
  // A snapshot with no period: one constant key, fetched once per mount.
  const { data, error } = usePeriodFetch("clusters", fetchClustersSummary);
  return (
    <>
      <div className="dev-view-header-band">
        <h2 className="dev-view-title">Clusters</h2>
        <p className="dev-view-subtitle">{CLUSTERS_SUBTITLE}</p>
      </div>
      <div className="dev-view-body clusters-body">
        {error === STALE_API_MESSAGE ? <section className="dev-panel"><p className="dev-empty" role="alert">{STALE_TEXT}</p></section>
         : error ? <p className="dev-empty" role="alert">Couldn&apos;t load clusters ({error}).</p>
         : !data ? <p className="dev-empty">Loading…</p>
         : <>
            {data.run && data.pages
              ? <ClusterCards summary={data} />
              : <section className="dev-panel"><p className="dev-empty">{NO_RUN_TEXT}</p></section>}
            <ClusterConfigPanels config={data.config} />
            {data.runs.total > 0 && <RunHistory runs={data.runs} currentId={data.run?.id ?? null} />}
            {data.run && data.pages && <>
              <ClusterDistributions clusters={data.clusters} edges={data.edges} threshold={data.config.clustering.edge_threshold} maxEdges={data.config.clustering.max_edges_per_cluster} />
              <ClusterTable clusters={data.clusters} runId={data.run.id} />
              <UnclusteredTable pages={data.pages} />
            </>}
          </>}
      </div>
    </>
  );
}
