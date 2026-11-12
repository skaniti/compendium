// Derives demo/fixtures/suggestions.json (the GET /api/topics/suggestions body
// the demo stub serves) from the BUILT graph fixture's own suggested groups, so
// the ids, member clusters and counts always agree with the graph the demo
// shows. Only the display label and the recurrence evidence are authored here:
// the capture has no model-written broad names, and every number below is
// synthetic. Called by build-fixtures.mjs; also runnable on its own:
//   node demo/tools/suggestions-fixture.mjs   (rewrites demo/fixtures/suggestions.json only)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The real offer rule's cluster floor: a group needs at least 2 clusters (the
// owner ruled one-cluster groups are never offered). The stub is exempt from
// the real 15-page floor ONLY, because the small demo data cannot meet it.
const MIN_CLUSTERS = 2;

// Real backend tiers, best first (backend/services/supercluster_discovery.py TIER_ORDER).
const TIER_ORDER = ['declared', 'recurrent', 'casual', 'binge'];

// graph group id -> authored display label + synthetic evidence. Evidence follows
// the tier the graph fixture assigns (binge = at most 2 days; casual = a few
// sightings), so label, tier and evidence tell one story. Only groups with at
// least MIN_CLUSTERS clusters are offered, so the entries for the one-cluster
// groups (123, 117, 116) are never used.
const AUTHORED = {
  125: { label: 'Arts and Ideas', evidence: { n_days: 2, n_weeks: 1, n_visits: 41, span_days: 1, dwell_median: 38.0, dwell_p90: 150.0, re_url_count: 4 } },
  124: { label: 'Food and Drink', evidence: { n_days: 2, n_weeks: 1, n_visits: 13, span_days: 1, dwell_median: 52.0, dwell_p90: 210.0, re_url_count: 2 } },
  126: { label: 'Geology', evidence: { n_days: 1, n_weeks: 1, n_visits: 10, span_days: 1, dwell_median: 61.0, dwell_p90: 240.0, re_url_count: 1 } },
  123: { label: 'Technology History', evidence: { n_days: 2, n_weeks: 2, n_visits: 4, span_days: 12, dwell_median: 44.0, dwell_p90: 90.0, re_url_count: 0 } },
  117: { label: 'History', evidence: { n_days: 3, n_weeks: 2, n_visits: 5, span_days: 9, dwell_median: 36.0, dwell_p90: 80.0, re_url_count: 1 } },
  116: { label: 'Languages', evidence: { n_days: 2, n_weeks: 2, n_visits: 4, span_days: 15, dwell_median: 29.0, dwell_p90: 70.0, re_url_count: 0 } },
};

// graph: the parsed graph.json; clustersSummary: the parsed clusters/summary.json
// (supplies each cluster's numeric id, as the backend's cluster_ids are). Returns {suggestions, splits} in the endpoint's
// shape and order (tier, then pages). Applies the real cluster floor
// (MIN_CLUSTERS); exempt from the real 15-page floor only (see above).
export function deriveSuggestions(graph, clustersSummary) {
  const numericId = new Map(clustersSummary.clusters.map((c) => [c.slug, c.id]));
  const suggestions = graph.groups
    .filter((g) => g.source === 'suggested' && graph.clusters.filter((c) => c.group_id === g.id).length >= MIN_CLUSTERS)
    .map((g) => {
      const authored = AUTHORED[g.id];
      if (!authored) throw new Error(`suggestions-fixture: no authored label for suggested graph group ${g.id} (${g.label})`);
      const members = graph.clusters.filter((c) => c.group_id === g.id);
      return {
        id: g.id,
        label: authored.label,
        source: 'suggested',
        topic: null,
        topic_similarity: null,
        interest_tier: g.tier,
        evidence: authored.evidence,
        member_count: members.length,
        page_count: members.reduce((n, c) => n + c.page_ids.length, 0),
        cluster_ids: members.map((c) => numericId.get(c.id)),
        cluster_names: members.map((c) => c.name),
        split_proposal: null,
        cluster_slugs: members.map((c) => c.id),
      };
    });
  const rank = (t) => (TIER_ORDER.includes(t) ? TIER_ORDER.indexOf(t) : 99);
  suggestions.sort((a, b) => rank(a.interest_tier) - rank(b.interest_tier) || b.page_count - a.page_count);
  return { suggestions, splits: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  const readJson = (f) => JSON.parse(readFileSync(path.join(fixturesDir, f), 'utf8'));
  writeFileSync(path.join(fixturesDir, 'suggestions.json'), JSON.stringify(deriveSuggestions(readJson('graph.json'), readJson('clusters/summary.json')), null, 2) + '\n');
  console.log('[suggestions-fixture] wrote suggestions.json');
}
