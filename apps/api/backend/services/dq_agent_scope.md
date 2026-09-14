# dqBot — Scope Document

This document enumerates the **investigations dqBot performs** when tagging
observations as `core`. An observation must cite a scope item here to be
written as `core`; observations that cannot cite an item are either `adjacent`
(per `dq_agent_adjacency.md`) or `off_topic` (dropped).

This document is authoritative. dqBot reads it on every run. It is modified
only via a user-triggered role-review ceremony. dqBot itself
NEVER writes to or suggests edits to this file at runtime.

## S1 — Skip-gate reversal audit

**What dqBot investigates:** Patterns in `skip_reasoning` text where the
user's validation labels (`annotations.action='validate_archive'`,
`new_value='incorrect'`) disagree with the original skip-gate decision.

**Inputs:**
- `annotations` rows with `action='validate_archive'`
- Corresponding page rows: `skip_reasoning`, `domain`, `title`
- Optional: per-annotation `note` text explaining the user's reasoning

**Observable symptom (threshold for `core` flag):**
≥3 pages share a common reasoning-pattern substring AND ≥2 of those pages
are labelled `new_value='incorrect'` by the user.

Threshold is deliberately loose during the deadline-mode cleanup phase —
dqBot's exhaustive ranking + the inbox soft-cap (top 5 prompted, ranks 6+
in expander) handle the filtering. Revisit at the first user-triggered role review.

**Output shape (recommendation):**
- `action_type`: `edit_prompt`
- `headline`: one sentence quoting the overfit phrase and proposing a tighter
  alternative
- `rationale`: pattern + count of pages with the pattern + count labelled
  incorrect + aggregated user notes (pulled from `annotations.note`) if present
- `affected_entity_ids`: `["skip_gate_prompt"]`
- `self_classification`: typically `judgment` (prompt edits have knock-on
  effects on future archiving decisions)

**"Nothing found" shape:** `"Audited N validated pages across M reasoning
patterns; no pattern met the 3-page / 2-incorrect threshold."`

**Trigger:** weekly (behavioral — signals can appear any time the user labels
a batch). In deadline mode, runs on manual "Run now" only.

## S2 — Cluster coherence via skip_reasoning drift

**What dqBot investigates:** Clusters whose member pages are internally
incoherent — their summaries diverge from the cluster's assigned label.

**Inputs:**
- `clusters.label`
- Summaries of member pages
- `skip_reasoning` of topically-adjacent archived pages (for context on what
  the cluster's boundary looks like from outside)

**Observable symptom:** Fewer than 60% of member summaries share ≥2
noun-phrase anchors with the cluster label, OR the label's predicted theme
(LLM-generated from the label alone) semantically diverges from the observed
member content.

**Rival-hypothesis guard (required):** before flagging, dqBot MUST run the
rival-hypothesis check — given only the cluster label, predict expected
domain/source/content mix; if that prediction matches observation, suppress
the flag. Heterogeneity-as-intentional is the default hypothesis;
incoherence is the exception.

**Output shape:**
- `action_type`: `relabel_cluster` | `split_cluster` | `flag_for_review`
- `headline`: names the cluster + the incoherence shape
- `rationale`: lists up to 5 outlier pages with titles/domains
- `entity_id` / `affected_entity_ids`: the cluster's `stable_id` (UUID string,
  see "Tier 1" meta note below) — falls back to the stringified integer
  cluster id when `stable_id` is NULL (identity disabled / legacy row); the
  integer id + current cluster name still ride along in `evidence` for
  display
- `action_payload`: `{"stable_id": "..."}` when derivable, else
  `{"identity": "missing"}`. `proposed_label` is LLM judgment — REQUIRED
  in `action_payload` whenever `action_type` is `relabel_cluster`

**"Nothing found" shape:** `"Reviewed N clusters; M passed the label-match
threshold; none flagged after rival-hypothesis check."`

**Trigger:** recluster event (NOT weekly — cluster structure is static
between reclusters; time-triggered runs would just re-surface resolved
findings).

## S3 — Domain-silo clusters

**What dqBot investigates:** Clusters that are source-type silos rather than
topic groupings.

**Inputs:**
- Cluster membership (`page_clusters` join `pages`)
- Domain of each member

**Observable symptom:** A single domain comprises >40% of a cluster's
members, AND that same domain appears in ≥3 other clusters (i.e., the domain
isn't topic-specific; it's structurally overrepresented).

**Output shape:**
- `action_type`: `split_cluster` | `merge_with_siblings`
- `headline`: `"Cluster <id> is N% <domain> — appears to be a source silo,
  not a topic"`
- `rationale`: domain count, appearance count across other clusters,
  candidate regroupings where obvious
- `entity_id` / `affected_entity_ids` (per-cluster path only): the cluster's
  `stable_id` (UUID string, see "Tier 1" meta note below) — falls back to
  the stringified integer cluster id when `stable_id` is NULL. The
  aggregation path below (`entity_type: "global"`) is unaffected — it isn't
  a single cluster entity, so it keeps integer cluster ids in
  `affected_entity_ids` as before.
- `action_payload` (per-cluster path only): `{"stable_id": "..."}` when
  derivable, else `{"identity": "missing"}`. No page-list fields are
  pre-filled — picking which pages to remove needs judgment the
  deterministic pass doesn't have.

**Aggregation rule (added 2026-07-17, executive triage sweep):** if more
than 5 clusters flagged in the same run share the same dominant domain,
dqBot MUST NOT file one per-cluster recommendation for each — that's
symptom spam of a single systemic pattern (recs 77/222/253 were 50
per-cluster wikipedia-silo flags in one run, all downstream of the same
root cause). Instead file **one systemic finding** with `entity_type`
`global` (not `cluster`) whose `affected_entity_ids` lists every affected
cluster id, and whose `rationale` retains the per-cluster detail (share %,
page counts) for each listed cluster so nothing is lost, just consolidated.
Clusters whose dominant domain is shared by 5 or fewer flagged clusters in
the run are unaffected and still get individual per-cluster findings.

**Recurrence-demotion rule (added 2026-07-17, executive vocab/rec sweep,
approved rec 248):** a systemic finding (the aggregation case above) that
has already been filed in ≥2 prior runs with a root-cause trail on record
is a known, tracked pattern, not fresh news — it files at severity `info`
instead of `warning`, and the observation text names how many consecutive
runs it's recurred in (e.g. "3rd consecutive systemic recurrence..."). The
mechanism: `dq_observations` enforces
`UNIQUE(user_id, entity_type, entity_id, issue_type)`, so only ONE
observation row can ever exist for a systemic entity_id like
`domain_silo:<domain>` — recurrence across runs does NOT show up as
repeated `dq_observations` rows. It shows up in the `dq_recommendations`
supersession chain hanging off that one observation instead: each
re-detection (once the prior recommendation has resolved) creates a new
`dq_recommendations` row carrying its own `run_id`, linked via
`observation_id`. The pre-detector counts `DISTINCT run_id` in that chain
(`domain_silo_clusters._prior_systemic_recurrence_count`) — the ledger
tracks recurrence, never the `issue_type` label (see the vocab-proposal
guardrail's ban on `persistent`/`systemic`/`recurrence` suffixes).

**"Nothing found" shape:** `"Reviewed N clusters; no single-domain dominance
above 40% combined with cross-cluster ubiquity ≥3."`

**Trigger:** recluster event.

## S4 — Supercluster label vs. member-cluster drift

**What dqBot investigates:** Superclusters whose LLM-generated label diverges
semantically from their assigned child clusters.

**Inputs:**
- `clusters.super_cluster` (TEXT topic keyword; this IS the supercluster label —
  there is no separate `super_clusters` table, despite earlier doc revisions
  implying one)
- Child cluster labels (`clusters.cluster_name`, grouped by shared
  `clusters.super_cluster` value)
- Sampled page summaries per child cluster

**Observable symptom:** Given the supercluster label alone, dqBot cannot
plausibly predict the observed child cluster labels — SBERT cosine distance
between parent label and the centroid of child labels exceeds a threshold.
Calibrated 2026-07-17 (executive triage sweep) from 0.4 to **0.55**: recs
82 and 160 both identified the repeated 'zoology' supercluster flag as a
false positive, traced to academic-vocabulary label distance (e.g. 'zoology' vs.
child labels like 'Ornithology', 'Marine Biology') inflating cosine distance
past 0.4 despite the grouping being topically sound. 0.55 is the calibrated
threshold going forward; re-tune again at the next user-triggered role
review if further false positives accumulate.

**Rival-hypothesis guard (required):** same mechanism as S2.

**Output shape:**
- `action_type`: `relabel_supercluster` | `reassign_child_cluster`
- `headline`: `"Supercluster '<label>' contains child '<child label>' that
  doesn't fit the theme"`
- `rationale`: named drifting children, sampled evidence
- `affected_entity_ids`: `[<supercluster_keyword_string>, <child_cluster_id>, ...]`
  (heterogeneous: the supercluster reference is the TEXT keyword from
  `clusters.super_cluster`, followed by integer ids of drifting child clusters)

**"Nothing found" shape:** `"Reviewed N superclusters; all child labels
within semantic radius of parent label."`

**Trigger:** recluster event.

## S5 — Dedup-escapees

**What dqBot investigates:** Page pairs with highly-similar summaries but
distinct URLs — candidates that slipped through the existing dedup layer.

**Inputs:**
- Page summaries + existing embeddings
- URLs

**Observable symptom:** Summary cosine-similarity >0.94 between two pages
with distinct URLs (typical patterns: canonical vs. AMP, query-string
variants, mirror domains, paginated content fragments).

**Output shape:**
- `action_type`: `dedupe`
- `headline`: `"N candidate duplicate pairs: <domain examples>"`
- `rationale`: each pair — both URLs + similarity score + which to keep
  (heuristic: lower page ID / cleaner URL)
- `affected_entity_ids`: `[[<page_a>, <page_b>], ...]`

**"Nothing found" shape:** `"Scanned N candidate pairs above similarity
threshold; all were legitimately distinct content (different angles,
paginated, etc.)."`

**Trigger:** weekly (behavioral).

## S6 — Leaf impurity

**What dqBot investigates:** Clusters ("leaves") whose members are not
mutually similar enough in the clustering-embedding space to plausibly be
one coherent topic — a "junk drawer" leaf where a small minority of pages
ride along with an otherwise coherent majority. Unlike S2, which compares
each member against the cluster's LLM-assigned label, S6 looks only at
member-to-member pairwise similarity, independent of whether the assigned
label still reads sensibly. It is deterministic — no LLM/API calls.

**Inputs:**
- Clustering-cache embeddings (`clustering_embeddings`, keyed by
  `model_key = f"{clustering_embedding_model}@{clustering_text_contract}"`)
  for each member page of each cluster in the latest completed recluster
  run. Clusters with incomplete embedding coverage under that key are
  skipped entirely — no partial scoring, no fallback compute.

**Observable symptom (threshold for `core` flag):** Minimum pairwise cosine
similarity across all member pairs ≤ 0.19, for clusters with ≥3 members
(a 2-page leaf has exactly one pairwise similarity, too noise-adjacent on
its own to be a signal).

**Provenance:** the WS2 leaf-impurity audit (prod run 142, 97 hand-labeled
leaves) found min-pairwise-cosine-similarity to be the best cheap
single-metric detector for MIXED vs PURE leaves — precision 0.80, recall
0.63, F1 0.71 at the 0.19 threshold (see
the 2026-07-14 sc-misfire-fix-design plan (private), WS2 report,
section 2). That audit also found this signal to be *independent* of the
supercluster-misfire mechanism (only 1 of 19 MIXED leaves in the audited
run actually caused a downstream SC misfire) — S6 is a standalone
leaf-hygiene signal, not a fix for SC quality, and a flagged leaf should
not be read as evidence that it is causing any supercluster problem.

**Output shape:**
- `action_type`: `split_cluster`
- `headline`: names the cluster + its minimum pairwise similarity vs. the
  0.19 threshold
- `rationale`: the most-distant member pair (titles) + the calibration
  provenance (precision/recall/F1 above)
- `entity_id` / `affected_entity_ids`: the cluster's `stable_id` (UUID
  string, see "Tier 1" meta note below) — falls back to the stringified
  integer cluster id when `stable_id` is NULL, same convention as S2/S3
- `action_payload`: `{"stable_id": "..."}` when derivable, else
  `{"identity": "missing"}`. No page-list fields are pre-filled — S6 flags
  the leaf as impure without judging which specific member(s) don't belong.

**"Nothing found" shape:** `"Reviewed N clusters with complete embedding
coverage; none had minimum pairwise similarity at or below 0.19."`

**Trigger:** recluster event (structural, like S2/S3/S4 — cluster
membership is static between reclusters).

---

## Meta notes (not investigation-specific)

### Rival-hypothesis pattern

The rival-hypothesis check (predict the expected source/domain mix from
the label alone; suppress if the prediction matches observation) now runs
as the **Tier-2 adjudication band** — a batched `gpt-4o-mini` pass over
member-evidence (full title/domain lists, not 5-outlier prose) that judges
S2 and S4 candidates BEFORE Opus ever sees them (see
the 2026-07-19 dqbot-tier2-role-split plan (private), spec.md,
"Full pass phase 2 — adjudication"). S2 and S4 pre-detectors themselves no
longer run the guard — they emit raw threshold candidates, unfiltered;
adjudication is the sole rival-hypothesis gate ahead of Opus's synthesis
pass. S3 does not need it (threshold-based detection on structural
attributes is robust on its own). S1, S5, and S6 don't need it either
(they operate on labelled / measured data, not inferred judgments).

### Threshold tuning

Thresholds listed above (3 pages / 2 incorrect / 60% / 40% / ≥3 / 0.94) are
still starter values. During the first few runs, track per-investigation
false-positive rate (rejected recommendations by investigation); re-tune
at the first user-triggered role review.

S4's threshold is the exception: it went through that re-tune during the
2026-07-17 executive triage sweep (0.4 → 0.55, see §S4) after two rejected
'zoology' flags. Treat 0.55 as the current calibrated value, not a starter.

### Tier 1 (2026-07-17) — stable-id entity referencing

Cluster ids are per-recluster-run integers — they die every recluster.
`clusters.stable_id` (migration 036, a UUID carried forward across reclusters
by Jaccard match on membership when cluster identity is enabled) is the
durable handle. S2 and the S3 per-cluster path (not its >5-clusters
aggregation case, which stays `entity_type: "global"` and isn't a single
cluster entity) reference `stable_id` in `entity_id` / `affected_entity_ids`,
falling back to the stringified integer cluster id — flagged
`{"identity": "missing"}` in `action_payload` — when `stable_id` is NULL
(identity disabled, or a legacy/pre-036 row). The integer cluster id and
current display name still ride along in `evidence` for readability. See
the 2026-07-17 dqbot-tier1-overrides plan (private), spec.md
(sections S1, S4).

---

## SQL Receipt Templates (per investigator)

Every finding's `sql_query` is executed at write time as `dq_bot_readonly`
(SELECT-only on the dq tables, 5s `statement_timeout`). The result is
captured on the observation row and surfaced in the Receipt pane next to
the card. If the query returns 0 rows when you predicted otherwise, your
claim is contradicted before the user sees it -- so the SELECT must
actually return the rows behind the claim.

Use these patterns as starting points; substitute the entity id from the
finding being investigated, and adapt columns/joins to what you need to
show. Stay within the readonly allowlist:
`pages, clusters, page_clusters, annotations, captures, dq_observations,
dq_recommendations, dq_runs, dq_run_events, dq_vocab_issue_types`.
Note: `supercluster` is a TEXT column on `clusters`, not a separate table.

### S1 — Reversal pattern (archive then unarchive within window)

```sql
SELECT a1.entity_id,
       a1.created_at AS archived_at,
       a2.created_at AS unarchived_at,
       a2.created_at - a1.created_at AS dt
FROM annotations a1
JOIN annotations a2
  ON a1.entity_id = a2.entity_id
 AND a1.entity_type = a2.entity_type
 AND a1.action = 'archive'
 AND a2.action = 'unarchive'
 AND a2.created_at > a1.created_at
 AND a2.created_at - a1.created_at < INTERVAL '7 days'
WHERE a1.entity_type = 'cluster' AND a1.entity_id = '<cluster_id>'
LIMIT 100;
```

### S2 — Cluster coherence drift (centroid + drift evidence)

```sql
SELECT c.id, c.stable_id, pc.cluster_id, p.id AS page_id, p.title, p.created_at
FROM clusters c
JOIN page_clusters pc ON pc.cluster_id = c.id
JOIN pages p ON p.id = pc.page_id
WHERE pc.cluster_id = <cluster_id>
ORDER BY p.created_at DESC
LIMIT 100;
```

### S3 — Domain silo (cluster contents heavily concentrated on one domain)

```sql
SELECT c.stable_id,
       regexp_replace(p.url, '^https?://([^/]+).*$', '\1') AS domain,
       COUNT(*) AS page_count
FROM clusters c
JOIN page_clusters pc ON pc.cluster_id = c.id
JOIN pages p ON p.id = pc.page_id
WHERE pc.cluster_id = <cluster_id>
GROUP BY 1, 2
ORDER BY page_count DESC
LIMIT 100;
```

### S4 — Supercluster drift (children migrating across superclusters over time)

```sql
SELECT super_cluster, id AS cluster_id, cluster_name, created_at
FROM clusters
WHERE user_id = <user_id> AND super_cluster = '<super_cluster>'
ORDER BY created_at DESC
LIMIT 100;
```

### S5 — Dedup escapees (likely-duplicate pages in same cluster)

```sql
SELECT p1.id AS p1_id, p2.id AS p2_id,
       p1.title AS p1_title, p2.title AS p2_title,
       p1.url AS p1_url, p2.url AS p2_url
FROM page_clusters pc1
JOIN page_clusters pc2 ON pc1.cluster_id = pc2.cluster_id AND pc1.page_id < pc2.page_id
JOIN pages p1 ON p1.id = pc1.page_id
JOIN pages p2 ON p2.id = pc2.page_id
WHERE pc1.cluster_id = <cluster_id>
  AND lower(p1.title) = lower(p2.title)
LIMIT 100;
```

### S6 — Leaf impurity (cluster member list, for pairwise-similarity spot check)

```sql
SELECT c.id, c.stable_id, pc.cluster_id, p.id AS page_id, p.title, p.created_at
FROM clusters c
JOIN page_clusters pc ON pc.cluster_id = c.id
JOIN pages p ON p.id = pc.page_id
WHERE pc.cluster_id = <cluster_id>
ORDER BY p.created_at DESC
LIMIT 100;
```
