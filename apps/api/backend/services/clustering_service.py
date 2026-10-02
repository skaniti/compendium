"""Cross-capture HDBSCAN clustering with LLM-generated cluster names.

Replaces per-capture LLM clustering (old Stage 4b) with a batch process that:
1. Loads all active pages from PostgreSQL
2. Computes SBERT embeddings (cached to disk)
3. Runs HDBSCAN on the cosine distance matrix
4. Names clusters via gpt-4o-mini
5. Writes clusters, page_clusters, and cluster_edges to PostgreSQL

Key parameters are settings-driven since the clustering rethink
(the 2026-07-08 clustering-supercluster-rethink plan, private):
- Embedding model: settings.clustering_embedding_model (default
  all-MiniLM-L6-v2 = legacy SBERT; text-embedding-* = gated OpenAI path)
- Reduction: settings.clustering_umap_dims (default 0 = off)
- HDBSCAN: settings.hdbscan_{min_cluster_size,min_samples,selection_method,
  selection_epsilon} (defaults 2/2/eom/0.0 = legacy behavior; the 09_03
  notebook experiments originally chose min_cluster_size=3)
- LLM naming: gpt-4o-mini, temperature=0.3, max_tokens=30

Note: Embeddings are cached in pgvector (page_embeddings table).
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid

import numpy as np
from sklearn.cluster import HDBSCAN
from sklearn.metrics.pairwise import cosine_distances

from backend.config.settings import settings
from backend.db import cluster_repo, page_repo, recluster_repo
from backend.services.llm_service import LLMService

logger = logging.getLogger(__name__)

SBERT_MODEL_NAME = "all-MiniLM-L6-v2"
HDBSCAN_MIN_CLUSTER_SIZE = 2
"""Module-level default; the runtime path reads ``settings.hdbscan_min_cluster_size``
which defaults to this value but is tunable via the ``HDBSCAN_MIN_CLUSTER_SIZE``
env var. Kept as a constant for callers that import it directly (e.g. early
preflight checks before settings is available)."""
HDBSCAN_SELECTION_METHOD = "eom"
"""Legacy default, kept for external importers (cluster diagnostics view,
comparison scripts). The runtime path reads ``settings.hdbscan_selection_method``
(same default) since increment 2 exposed the knob."""
NAMING_MODEL = "gpt-4o-mini"
SIMILARITY_THRESHOLD = 0.15
NAMING_TEMPERATURE = 0.3
NAMING_MAX_TOKENS = 30
NAMING_SAMPLE_SIZE = 10
"""Pages per cluster shown to the naming model (``_build_naming_prompt``)."""
MAX_EDGES_PER_CLUSTER = 3
"""Similarity edges kept per cluster, strongest first."""
MIN_CLUSTER_SIZE_DIVISOR = 150
"""HDBSCAN's min cluster size scales as max(setting, n_pages // this)."""
FEATURED_SINGLETONS_DENSITY_PCT = 0.20
"""Fraction of real cluster count to surface as featured singletons (the
"starfield" of representative HDBSCAN-noise pages). At 20% with N=65 real
clusters, that's 13 featured singletons -- visible secondary signal without
drowning the primary cluster groupings. Selection is by HDBSCAN
``outlier_scores_`` (top-N most outlier-like). Tunable; bumping reduces
fragmentation feel but loses outlier-spotlight signal."""
EMBEDDING_TEXT_CONTRACT = "ctv2"
"""DEFAULT/legacy value only (sc-followups 2026-07-16) — mirrors
``Settings.clustering_text_contract``'s default for back-compat importers
(e.g. ``tests/test_clustering_embedding_upgrade.py``). The LIVE contract
used by ``_compute_embeddings_openai`` is ``settings.clustering_text_contract``,
not this constant — routing was moved to the setting so "ctv2" (300-char
head sample) vs "ctv3" (per-page LLM gist, see ``_build_embedding_text_v3``)
is switchable without a code change. Encoded into the
``clustering_embeddings.model_key`` (``<model>@<contract>``) so a recipe
change invalidates the cache without schema surgery. ctv2 = one register:
``"{title}. {summary}"`` when a summary exists, else primary text capped at
2000 words. The legacy SBERT path keeps its original recipe untouched."""
GIST_PROMPT_KEY = "gist_v1"
"""Prompt version for embedding_gists rows. Bump to regenerate all gists."""
GIST_INPUT_WORD_CAP = 500
GIST_BATCH_SIZE = 16
OPENAI_EMBED_PRICE_PER_MTOK = {
    "text-embedding-3-small": 0.02,
    "text-embedding-3-large": 0.13,
}
OPENAI_EMBED_BATCH_SIZE = 512
_BOILERPLATE_SUMMARY_RE = re.compile(r"^Page browsed outside API tool scope for \d+ seconds$")
_PROBABILITIES_MISSING_WARNED = False
"""Set on first observation that the installed sklearn's HDBSCAN lacks
``probabilities_`` (migration 038's mean_membership_probability source) --
logs once per process instead of once per recluster run."""


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _run_coro_blocking(coro):
    """Run an async coroutine to completion from sync code.

    ``_compute_embeddings_openai`` is sync, but ``recluster_all`` (async)
    calls it directly inline (no thread hop) — so this function's caller may
    already be executing inside a running event loop, in which case plain
    ``asyncio.run(coro)`` raises ("asyncio.run() cannot be called from a
    running event loop"). Mirrors the precedent in
    ``frontend/dash/callbacks/topics.py`` (``_run_assign_in_thread`` +
    ``ThreadPoolExecutor(max_workers=1)``): a freshly spawned thread has no
    event loop of its own by construction, so dispatching there always makes
    ``asyncio.run`` safe. When no loop is running in the calling thread,
    skip the thread hop and run directly.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _maybe_enqueue_dq(user_id: int) -> None:
    """Best-effort: enqueue a structural DQ run after a recluster. Gating lives
    in dq_scheduler.enqueue_recluster_dq (pref + active-run + kill switch). A
    failure here must never roll back the successful recluster."""
    try:
        from backend.services import dq_scheduler

        dq_scheduler.enqueue_recluster_dq(user_id)
    except Exception:
        logger.exception(
            "dq recluster enqueue failed for user %s (recluster itself succeeded)", user_id
        )


def apply_dq_overrides(
    labels: np.ndarray,
    cluster_names: dict[int, str],
    identity_matches: dict[int, dict],
    pages: list[dict],
    probabilities: np.ndarray | None,
    overrides: list[dict],
) -> dict:
    """Apply durable dq_overrides (dqBot Tier 1, spec S6) to this run's
    in-memory cluster state, before it's written to DB.

    Pure Python over already-computed HDBSCAN output -- no DB access here
    (the caller in :meth:`ClusteringService.recluster_all` fetches
    ``overrides`` via ``dq_overrides_repo.list_active`` and calls
    ``dq_overrides_repo.mark_applied`` afterward). ``labels`` is mutated in
    place (matching ``_write_clusters_to_db``'s own in-place-merge
    convention) and also returned for clarity at call sites.

    Args:
        labels: HDBSCAN labels, one per ``pages[i]`` (>=0 cluster id, or -1
            for noise). Mutated in place by exclude/evict/merge overrides.
        cluster_names: {hdbscan_cid: name}. Mutated in place by pin_label
            (direct rename) and merge_clusters (absorbed cids popped).
        identity_matches: {hdbscan_cid: {"stable_id", "name", "jaccard"}}
            from ``_match_clusters_to_previous`` -- the only source of
            truth for stable_id -> this-run's-cid resolution. Overrides
            whose subject stable_id isn't a key here are dormant.
        pages: page dicts aligned index-for-index with ``labels``; only
            ``page_content_id`` is read.
        probabilities: per-point HDBSCAN membership confidence aligned with
            ``labels``, or None (sklearn install without ``probabilities_``)
            -- never_cocluster's tie-break falls back to page_content_id
            when this is None.
        overrides: active dq_overrides rows (``dq_overrides_repo.list_active``
            shape: id, override_type, subject, payload, ...).

    Returns:
        {"applied_override_ids": [...], "labels": labels,
         "cluster_names": cluster_names, "stats": {...}}. ``stats`` has one
        {"applied": n, "dormant": n} entry per override_type plus a
        top-level "dormant" total. An override matching nothing (unmatched
        stable_id/content_id, or a malformed subject/payload) bumps
        dormant and is never added to applied_override_ids -- never an
        error, per spec's "unmatched -> dormant this run" contract.

    Per-type behavior (spec S6):
        pin_label {subject.stable_id, payload.label}: force
            cluster_names[cid] for the matched cluster.
        exclude_from_cluster {subject.stable_id, payload.page_content_ids}:
            drop the named pages from the matched cluster's membership
            (labels[i] = -1) -- they fall to noise/unclustered.
        never_cocluster {subject.page_content_id_a, .page_content_id_b}:
            if both currently share a real cluster, evict the one with the
            lower probabilities[i] (probabilities None or a tie -> evict
            the higher page_content_id).
        merge_clusters {subject.stable_ids}: with >=2 matched cids, union
            every other matched cluster's members onto the
            highest-Jaccard match (the survivor keeps its cluster_names
            entry -- including any pin_label already applied to it, since
            pin_label writes by cid via identity_matches and is unaffected
            by this merge); absorbed cids are dropped from cluster_names.
    """
    stats: dict = {
        "pin_label": {"applied": 0, "dormant": 0},
        "exclude_from_cluster": {"applied": 0, "dormant": 0},
        "never_cocluster": {"applied": 0, "dormant": 0},
        "merge_clusters": {"applied": 0, "dormant": 0},
        "dormant": 0,
    }
    applied_override_ids: list = []

    def _result() -> dict:
        return {
            "applied_override_ids": applied_override_ids,
            "labels": labels,
            "cluster_names": cluster_names,
            "stats": stats,
        }

    if not overrides:
        return _result()

    # stable_id -> this-run's hdbscan cid. One-to-one by construction
    # (_match_clusters_to_previous takes each previous-run cluster at most
    # once), so a plain dict inversion is safe.
    stable_to_cid: dict[str, int] = {
        m["stable_id"]: cid for cid, m in identity_matches.items()
    }
    # page_content_id -> first page index. The clusterable set is already
    # content-deduped upstream (_filter_clusterable_pages Filter C), so
    # "first" is effectively "only".
    content_id_to_idx: dict = {}
    for i, p in enumerate(pages):
        cid = p.get("page_content_id")
        if cid is not None and cid not in content_id_to_idx:
            content_id_to_idx[cid] = i

    def _dormant(override_type: str) -> None:
        stats[override_type]["dormant"] += 1
        stats["dormant"] += 1

    def _applied(override_type: str, override_id) -> None:
        stats[override_type]["applied"] += 1
        applied_override_ids.append(override_id)

    for ov in overrides:
        ov_type = ov.get("override_type")
        if ov_type not in ("pin_label", "exclude_from_cluster", "never_cocluster", "merge_clusters"):
            continue  # unrecognized type -- ignore defensively, never crash the pass
        ov_id = ov.get("id")
        subject = ov.get("subject") or {}
        payload = ov.get("payload") or {}

        try:
            if ov_type == "pin_label":
                cid = stable_to_cid.get(subject.get("stable_id"))
                if cid is None:
                    _dormant(ov_type)
                    continue
                cluster_names[cid] = payload["label"]
                _applied(ov_type, ov_id)

            elif ov_type == "exclude_from_cluster":
                cid = stable_to_cid.get(subject.get("stable_id"))
                if cid is None:
                    _dormant(ov_type)
                    continue
                exclude_ids = set(payload.get("page_content_ids") or [])
                for i, p in enumerate(pages):
                    if int(labels[i]) == cid and p.get("page_content_id") in exclude_ids:
                        labels[i] = -1
                _applied(ov_type, ov_id)

            elif ov_type == "never_cocluster":
                content_id_a = subject.get("page_content_id_a")
                content_id_b = subject.get("page_content_id_b")
                idx_a = content_id_to_idx.get(content_id_a)
                idx_b = content_id_to_idx.get(content_id_b)
                if idx_a is None or idx_b is None:
                    _dormant(ov_type)
                    continue
                label_a = int(labels[idx_a])
                label_b = int(labels[idx_b])
                if label_a == -1 or label_a != label_b:
                    # not currently co-clustered -- nothing to evict
                    _dormant(ov_type)
                    continue
                prob_a = float(probabilities[idx_a]) if probabilities is not None else None
                prob_b = float(probabilities[idx_b]) if probabilities is not None else None
                if prob_a is not None and prob_b is not None and prob_a != prob_b:
                    evict_idx = idx_a if prob_a < prob_b else idx_b
                else:
                    # probabilities unavailable or tied -- evict the higher
                    # page_content_id (deterministic fallback per spec)
                    evict_idx = idx_a if content_id_a > content_id_b else idx_b
                labels[evict_idx] = -1
                _applied(ov_type, ov_id)

            elif ov_type == "merge_clusters":
                stable_ids = subject.get("stable_ids") or []
                matched: list[tuple[float, int]] = []
                for sid in stable_ids:
                    cid = stable_to_cid.get(sid)
                    if cid is not None:
                        matched.append((identity_matches[cid]["jaccard"], cid))
                if len(matched) < 2:
                    # Durability rider (Task 5): stable_id matching alone
                    # can't survive a merge -- the absorbed cid's identity
                    # doesn't carry into the next generation, so a
                    # re-approved merge override would go dormant forever
                    # after one application. When subject.member_content_ids
                    # is present (captured at approve time by
                    # dq_apply._apply_merge_clusters), a cluster whose
                    # *current* membership overlaps >=50% with that content
                    # set counts as matched too. Old-format subjects (no
                    # member_content_ids) skip straight to dormant, unchanged.
                    if subject.get("member_content_ids"):
                        subject_set = set(subject["member_content_ids"])
                        overlap_by_cid: dict[int, int] = {}
                        size_by_cid: dict[int, int] = {}
                        for i, p in enumerate(pages):
                            cid = int(labels[i])
                            if cid == -1:
                                continue
                            size_by_cid[cid] = size_by_cid.get(cid, 0) + 1
                            if p.get("page_content_id") in subject_set:
                                overlap_by_cid[cid] = overlap_by_cid.get(cid, 0) + 1
                        content_matched = [
                            (n, cid) for cid, n in overlap_by_cid.items()
                            if n / size_by_cid[cid] >= 0.5
                        ]
                        if len(content_matched) >= 2:
                            # Largest overlap count first -- that cluster
                            # survives and keeps its cluster_names entry;
                            # ties broken by lowest cid.
                            content_matched.sort(key=lambda t: (-t[0], t[1]))
                            survivor_cid = content_matched[0][1]
                            for _, cid in content_matched[1:]:
                                labels[labels == cid] = survivor_cid
                                cluster_names.pop(cid, None)
                            _applied(ov_type, ov_id)
                            continue
                    _dormant(ov_type)
                    continue
                # Highest Jaccard first -- that match's cid survives and
                # keeps its cluster_names entry (name, or a pin already
                # applied to it via identity_matches, unaffected below).
                matched.sort(key=lambda t: -t[0])
                survivor_cid = matched[0][1]
                for _, cid in matched[1:]:
                    labels[labels == cid] = survivor_cid
                    cluster_names.pop(cid, None)
                _applied(ov_type, ov_id)
        except Exception:
            logger.exception(
                "dq override id=%s type=%s failed to apply -- treating as "
                "dormant this run (recluster itself unaffected)",
                ov_id,
                ov_type,
            )
            _dormant(ov_type)

    return _result()


class ClusteringService:
    """Cross-session batch clustering via HDBSCAN + LLM naming."""

    def __init__(self, user_id: int | None = None):
        self._sbert_model = None
        self._llm = LLMService()
        self._user_id = user_id

    def _get_user_id(self) -> int:
        if self._user_id is not None:
            return self._user_id
        from backend.api.main import get_default_user_id

        self._user_id = get_default_user_id()
        return self._user_id

    def _get_sbert_model(self):
        if self._sbert_model is None:
            from backend.services.sbert_loader import get_sbert_model

            self._sbert_model = get_sbert_model()
        return self._sbert_model

    # ── Public API ──────────────────────────────────────────────────────

    async def recluster_all(self, batch_mode: bool = False) -> dict:
        """Run full cross-session reclustering with DB-backed lifecycle.

        Args:
            batch_mode: When True, cluster naming and supercluster assignment
                use the OpenAI Batch API (50% discount, ≤24h SLA) instead of
                the realtime chat-completions API. Intended for the nightly
                scheduler path (see ``backend/services/scheduler.py``); the
                dev Recluster button stays on the realtime path by default
                so the user isn't blocked waiting for a batch to finish.

        Returns:
            Dict with cluster_count, noise_count, naming_cost, elapsed_seconds.
        """
        user_id = self._get_user_id()

        # Guard: skip if a recluster is already in flight for this user.
        run_id = recluster_repo.start_run_if_idle(user_id)
        if run_id is None:
            logger.info(
                "recluster_all: a recluster is already in flight for user %s — skipping",
                user_id,
            )
            return {
                "skipped": "already_running",
                "cluster_count": 0,
                "noise_count": 0,
                "naming_cost": 0.0,
                "elapsed_seconds": 0.0,
            }

        t0 = time.perf_counter()

        # Step 1: Load all active pages from DB
        all_pages = self._load_all_pages(user_id)
        logger.info(f"Loaded {len(all_pages)} active pages for user {user_id}")

        # Step 1b: Pre-clustering quality filter
        pages, filter_stats = self._filter_clusterable_pages(all_pages)
        if len(pages) < HDBSCAN_MIN_CLUSTER_SIZE:
            logger.warning(
                f"Only {len(pages)} clusterable pages after filtering "
                f"(from {len(all_pages)} total) — too few to cluster"
            )
            recluster_repo.complete_run(
                run_id,
                cluster_count=0,
                noise_count=len(all_pages),
                naming_cost=0.0,
                elapsed_seconds=round(time.perf_counter() - t0, 2),
            )
            return {
                "cluster_count": 0,
                "noise_count": len(all_pages),
                "naming_cost": 0.0,
                "elapsed_seconds": 0.0,
                "filter_stats": filter_stats,
            }

        try:
            # Step 2: Compute embeddings (with disk cache)
            embeddings = self._compute_embeddings(pages)

            # Step 3: Run HDBSCAN. labels[i] = cluster_id (>=0) or -1 (noise).
            # outlier_scores[i] in [0, 1] -- higher = more outlier-like.
            # probabilities[i] in [0, 1] -- per-point membership confidence;
            # None when the installed sklearn doesn't expose it (guarded
            # through to _write_clusters_to_db, which stores NULL).
            labels, outlier_scores, probabilities = self._run_hdbscan(embeddings)
            cluster_ids = sorted(set(labels[labels != -1]))
            noise_count = int((labels == -1).sum())
            logger.info(
                f"HDBSCAN: {len(cluster_ids)} clusters, {noise_count} noise pages"
            )

            # Step 3b: Select top-N HDBSCAN-noise pages as featured singletons
            # (the "starfield"). Stored separately in featured_singletons --
            # they are NOT clusters and do NOT get LLM-named. Selection runs
            # outlier-rank + farthest-point sample via embeddings for spatial
            # diversity (avoids the middle-left clumping seen on user 152
            # pre-2026-04-27 with the prior top-K-by-outlier selection).
            density_pct = settings.featured_singletons_visible_pct
            featured = self._select_featured_singletons(
                labels,
                outlier_scores,
                embeddings,
                n_real_clusters=len(cluster_ids),
                density_pct=density_pct,
            )
            logger.info(
                f"Featured singletons: {len(featured)} of {noise_count} noise pages "
                f"(target {density_pct:.0%} of "
                f"{len(cluster_ids)} real clusters)"
            )

            # Step 3c (batch B 4a, gated): match this run's clusters to the
            # previous completed run by member page_content_id Jaccard.
            # Matched clusters carry their stable_id + name forward and are
            # EXCLUDED from LLM naming — churn for stable clusters drops to
            # zero and naming spend covers only genuinely new clusters.
            identity_matches: dict[int, dict] = {}
            if settings.cluster_identity_enabled:
                identity_matches = self._match_clusters_to_previous(
                    user_id, cluster_ids, labels, pages
                )
                logger.info(
                    f"Cluster identity: {len(identity_matches)}/{len(cluster_ids)} "
                    f"clusters matched to previous run (names carried, "
                    f"jaccard >= {settings.cluster_identity_jaccard})"
                )
            ids_to_name = [c for c in cluster_ids if c not in identity_matches]

            # Step 4: Name clusters via LLM (sync path by default; Batch API
            # when the caller opts into batch_mode — e.g. the nightly scheduler).
            # Featured singletons are excluded -- they use page titles, not
            # LLM-synthesized names.
            if batch_mode:
                cluster_names, naming_cost = await self._name_clusters_batch(
                    ids_to_name, labels, pages
                )
            else:
                cluster_names, naming_cost = await self._name_clusters(
                    ids_to_name, labels, pages
                )
            for cid, match in identity_matches.items():
                cluster_names[cid] = match["name"]

            # Step 4b (dqBot Tier 1, spec S6): apply durable dq_overrides
            # (pin_label / exclude_from_cluster / never_cocluster /
            # merge_clusters) to labels/cluster_names before they're
            # written to DB. Overrides target stable_ids, so this is a
            # deliberate no-op (logged, not silent) when identity is off --
            # every override would be dormant anyway. DQ_OVERRIDES_DISABLED
            # is a kill switch for the whole pass (spec risk mitigation):
            # a bug here must never be able to corrupt clustering output
            # beyond a quick env flip away from reverting to pre-Tier-1
            # behavior. The overrides fetch is guarded like
            # ``_maybe_enqueue_dq`` -- a DB hiccup here must not break
            # reclustering.
            applied_override_ids: list[int] = []
            if os.environ.get("DQ_OVERRIDES_DISABLED") == "1":
                logger.info(
                    "dq_overrides pass skipped for user %s (DQ_OVERRIDES_DISABLED=1)",
                    user_id,
                )
            elif not settings.cluster_identity_enabled:
                logger.warning(
                    "dq_overrides pass skipped for user %s: cluster_identity_enabled "
                    "is False -- overrides target stable_ids, which don't exist "
                    "this run, so every override would be dormant",
                    user_id,
                )
            else:
                try:
                    from backend.db import dq_overrides_repo

                    overrides = dq_overrides_repo.list_active(user_id)
                except Exception:
                    logger.exception(
                        "dq_overrides fetch failed for user %s -- proceeding "
                        "without overrides this run (recluster itself unaffected)",
                        user_id,
                    )
                    overrides = []
                if overrides:
                    override_result = apply_dq_overrides(
                        labels,
                        cluster_names,
                        identity_matches,
                        pages,
                        probabilities,
                        overrides,
                    )
                    labels = override_result["labels"]
                    cluster_names = override_result["cluster_names"]
                    applied_override_ids = override_result["applied_override_ids"]
                    logger.info(
                        "dq_overrides applied for user %s: %d/%d applied, stats=%s",
                        user_id,
                        len(applied_override_ids),
                        len(overrides),
                        override_result["stats"],
                    )

            # Step 5: Write real clusters to DB. Pages with label=-1 (noise)
            # get no page_clusters row -- correct (they are unclustered).
            write_result = self._write_clusters_to_db(
                user_id,
                run_id,
                labels,
                cluster_names,
                pages,
                embeddings,
                probabilities=probabilities,
                identity_matches=identity_matches,
            )
            slug_to_db_id = write_result["slug_to_db_id"]
            written_stable_ids = write_result["stable_ids"]

            # Bump last_applied_run/last_applied_at/apply_count for every
            # override actually applied above, now that the write succeeded.
            # Guarded -- an applied override's clustering effect is already
            # durable in ``clusters``/``page_clusters``; a bookkeeping
            # failure here must not roll any of that back.
            if applied_override_ids:
                try:
                    from backend.db import dq_overrides_repo

                    dq_overrides_repo.mark_applied(applied_override_ids, run_id)
                except Exception:
                    logger.exception(
                        "dq_overrides mark_applied failed for user %s run %s "
                        "(overrides were still applied to this run's clusters; "
                        "only the apply_count/last_applied bookkeeping failed)",
                        user_id,
                        run_id,
                    )

            # _write_clusters_to_db merges slug-identical clusters (mutating
            # ``labels`` in place), so recompute cluster_ids from the final
            # labels — otherwise cluster_count overstates by the number of
            # merges (run 142 recorded 98 vs 97 real rows).
            cluster_ids = sorted(set(int(c) for c in labels[labels != -1]))

            # Step 5a: Persist featured singletons separately
            self._write_featured_singletons_to_db(
                user_id, run_id, featured, pages
            )

            # Step 5b: Supercluster grouping. Hybrid mode (batch B 4b)
            # discovers groups from centroid geometry and runs even with zero
            # typed keywords; legacy keywords mode is unchanged (LLM
            # classification into topic_interests, skipped when none typed).
            if settings.supercluster_mode == "hybrid":
                from backend.services.super_cluster_service import (
                    assign_super_clusters_hybrid,
                )

                await assign_super_clusters_hybrid(
                    user_id,
                    run_id,
                    labels,
                    cluster_names,
                    pages,
                    embeddings,
                    slug_to_db_id,
                )
            else:
                from backend.db import auth_repo

                prefs = auth_repo.get_preferences(user_id)
                topic_interests = prefs.get("topic_interests", [])
                if topic_interests:
                    from backend.services.super_cluster_service import (
                        assign_super_clusters,
                    )

                    await assign_super_clusters(
                        user_id,
                        topic_interests,
                        recluster_run_id=run_id,
                        batch_mode=batch_mode,
                    )

            elapsed = time.perf_counter() - t0

            # Complete the run
            recluster_repo.complete_run(
                run_id,
                cluster_count=len(cluster_ids),
                noise_count=noise_count,
                naming_cost=naming_cost,
                elapsed_seconds=round(elapsed, 2),
            )

            # Record cost event for Trends view
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="cluster_naming",
                    model=NAMING_MODEL,
                    cost_usd=naming_cost,
                    metadata={"cluster_count": len(cluster_ids), "run_id": run_id},
                )
            except Exception:
                logger.debug("trends cost event insert failed", exc_info=True)

            # Cleanup old runs (keep latest 3)
            recluster_repo.cleanup_old_runs(user_id, keep_latest=3)

            logger.info(
                f"Reclustering complete: {len(cluster_ids)} clusters, "
                f"{len(featured)} featured singletons, "
                f"{noise_count - len(featured)} unclustered noise, "
                f"${naming_cost:.4f} cost, {elapsed:.1f}s"
            )

            # Rebuild + persist graph_cache as the final step. Every recluster
            # path -- HTTP /api/recluster, the trigger_recluster.py CLI, the
            # nightly_maintenance scheduler -- now lands consistent fresh state
            # in graph_cache automatically. Prior to 2026-04-27 only the HTTP
            # endpoint did this; CLI + scheduler callers left graph_cache stale.
            # Failure here is logged but does NOT roll back the recluster
            # (graph_cache can be rebuilt manually later; clusters are already
            # written and shouldn't be re-spent on LLM naming).
            graph_node_count = 0
            graph_edge_count = 0
            try:
                from backend.services.graph_builder import build_graph_from_db
                from backend.services.graph_service import save_graph as _save_graph

                _graph = build_graph_from_db(user_id)
                _save_graph(_graph, user_id)
                graph_node_count = len(_graph.nodes)
                graph_edge_count = len(_graph.edges)
                logger.info(
                    f"graph_cache rebuilt: {graph_node_count} nodes, "
                    f"{graph_edge_count} edges"
                )
            except Exception:
                logger.exception(
                    "graph_cache rebuild failed for user %s run %s "
                    "(recluster itself succeeded; graph_cache may be stale)",
                    user_id,
                    run_id,
                )

            # dqBot Tier 1 (spec S3): auto-expire pending cluster-entity recs
            # whose target dissolved in this recluster -- stable_id didn't
            # carry into the new generation (``written_stable_ids``, the
            # full minted+carried set from this run's write). An empty set
            # is itself a no-op inside resolve_stale_cluster_recs (guards
            # against mass-dismissing the queue when identity carry-forward
            # was off/broken this run rather than every cluster genuinely
            # dissolving). Guarded like ``_maybe_enqueue_dq`` below -- a
            # failure here must never roll back the successful recluster.
            try:
                from backend.db import dq_recommendations_repo

                dismissed = dq_recommendations_repo.resolve_stale_cluster_recs(
                    user_id, written_stable_ids
                )
                if dismissed:
                    logger.info(
                        "dq stale-cluster expiry: dismissed %d pending rec(s) "
                        "for user %s (target dissolved in run %s)",
                        dismissed,
                        user_id,
                        run_id,
                    )
            except Exception:
                logger.exception(
                    "dq stale-cluster expiry failed for user %s run %s "
                    "(recluster itself succeeded)",
                    user_id,
                    run_id,
                )

            # Layer 6.3: enqueue a structural DQ run for opted-in users now
            # that cluster structure is fresh. Gating (pref + active-run +
            # kill switch) lives in dq_scheduler.enqueue_recluster_dq.
            _maybe_enqueue_dq(user_id)

            return {
                "cluster_count": len(cluster_ids),
                "featured_singleton_count": len(featured),
                "noise_count": noise_count,
                "naming_cost": naming_cost,
                "elapsed_seconds": round(elapsed, 2),
                "filter_stats": filter_stats,
                "graph_nodes": graph_node_count,
                "graph_edges": graph_edge_count,
            }

        except Exception:
            recluster_repo.fail_run(run_id)
            raise

    # ── Data loading ────────────────────────────────────────────────────

    def _load_all_pages(self, user_id: int) -> list[dict]:
        """Load all active pages from PostgreSQL with joined content.

        Returns list of dicts with: id, url, title, domain, content_summary,
        fetched_content, capture_text_id.
        """
        rows = page_repo.get_active_pages(user_id)

        pages: list[dict] = []
        for r in rows:
            if not r.get("url") or not r.get("title"):
                continue

            # Build full_content dict from page_content join
            full_content = {}
            if r.get("fetched_content"):
                fc = r["fetched_content"]
                if isinstance(fc, str):
                    fc = json.loads(fc)
                full_content = fc

            pages.append(
                {
                    "db_id": r["id"],
                    "url": r["url"],
                    "title": r["title"],
                    "domain": r.get("domain", ""),
                    "summary": r.get("content_summary") or r.get("content_level_summary") or "",
                    "full_content": full_content,
                    "capture_text_id": r.get("capture_text_id", ""),
                    "page_content_id": r.get("page_content_id"),
                    "tool_selected": r.get("tool_selected"),
                    "is_learning": r.get("is_learning"),
                }
            )

        return pages

    # ── Pre-clustering quality filter ──────────────────────────────────

    def _filter_clusterable_pages(
        self,
        pages: list[dict],
    ) -> tuple[list[dict], dict]:
        """Remove low-quality pages before clustering.

        Applies three sequential filters:
        A. Boilerplate exclusion — pages whose summary is the ingest
           pipeline's "Page browsed outside API tool scope" placeholder.
        B. URL-path-only exclusion — pages where ``_build_sbert_text``
           falls back to URL path tokens (no fetched content, no summary).
        C. Cross-capture URL dedup — collapses duplicate visits to the
           same canonical URL (same ``page_content_id``).

        Returns ``(filtered_pages, stats_dict)``.
        """
        total_input = len(pages)

        # Filter A: boilerplate summary
        after_boilerplate = []
        excluded_boilerplate = 0
        for page in pages:
            summary = page.get("summary", "")
            if summary and _BOILERPLATE_SUMMARY_RE.match(summary):
                excluded_boilerplate += 1
            else:
                after_boilerplate.append(page)

        # Filter B: URL-path-only fallback
        after_fallback = []
        excluded_url_fallback = 0
        for page in after_boilerplate:
            _text, source = self._build_sbert_text(page)
            if source == "url_path_fallback":
                excluded_url_fallback += 1
            else:
                after_fallback.append(page)

        # Filter C: cross-capture dedup by page_content_id
        seen_content_ids: set[int] = set()
        after_dedup = []
        excluded_duplicate = 0
        for page in after_fallback:
            cid = page.get("page_content_id")
            if cid is None:
                # No canonical content row — keep (rare edge case)
                after_dedup.append(page)
            elif cid not in seen_content_ids:
                seen_content_ids.add(cid)
                after_dedup.append(page)
            else:
                excluded_duplicate += 1

        # Filter D: title+domain dedup (catches pagination — same thread
        # title across /page/2, /page/3, etc.)
        seen_title_domain: set[tuple[str, str]] = set()
        after_title_dedup = []
        excluded_title_dedup = 0
        for page in after_dedup:
            key = (page.get("title", ""), page.get("domain", ""))
            if key in seen_title_domain:
                excluded_title_dedup += 1
            else:
                seen_title_domain.add(key)
                after_title_dedup.append(page)

        # Filter E: learning classification gate (Plan 07)
        # is_learning == FALSE → exclude
        # is_learning IS NULL → include (benefit of the doubt)
        # is_learning == TRUE → include
        after_learning = []
        excluded_not_learning = 0
        for page in after_title_dedup:
            if page.get("is_learning") is False:
                excluded_not_learning += 1
            else:
                after_learning.append(page)

        stats = {
            "total_input": total_input,
            "excluded_boilerplate": excluded_boilerplate,
            "excluded_url_fallback": excluded_url_fallback,
            "excluded_duplicate": excluded_duplicate,
            "excluded_title_dedup": excluded_title_dedup,
            "excluded_not_learning": excluded_not_learning,
            "total_output": len(after_learning),
        }
        logger.info(
            f"Pre-clustering filter: {total_input} → {len(after_learning)} pages "
            f"(boilerplate={excluded_boilerplate}, "
            f"url_fallback={excluded_url_fallback}, "
            f"duplicate={excluded_duplicate}, "
            f"title_dedup={excluded_title_dedup}, "
            f"not_learning={excluded_not_learning})"
        )
        return after_learning, stats

    # ── Embeddings ──────────────────────────────────────────────────────

    def _build_sbert_text(self, page: dict) -> tuple[str, str]:
        """Build text for SBERT encoding from the richest available source.

        Returns ``(text, source)`` where *source* identifies which code
        path produced the text (e.g. the fetcher class name,
        ``"page_summary_fallback"``, or ``"url_path_fallback"``).

        Routes through the fetcher-owned text contract
        (``content_fetcher.get_primary_text_from_dict``) so every domain
        uses the same primary-text definition that Stage 0 / summary
        building / RAG chunking see.

        Truncation: ~500 words. SBERT ``all-MiniLM-L6-v2`` has a 256-token
        input limit; longer text is silently discarded by the model. 500
        words is a safe over-cap that captures the informative opening.
        """
        from backend.services.content_fetcher import get_primary_text_from_dict

        title = page["title"]
        max_words = 500

        fc = page.get("full_content") or {}
        tool_selected = page.get("tool_selected")
        text, source = get_primary_text_from_dict(
            tool_selected,
            fc,
            for_clustering=True,
        )

        if text:
            words = text.split()
            truncated = " ".join(words[:max_words]) if len(words) > max_words else text
            logger.debug(f"sbert_text source={source} tool={tool_selected} url={page['url']}")
            # If the primary text already includes the title (which
            # get_primary_text does by convention), don't double-prefix.
            return (truncated, source)

        # Fall back to the page-level content_summary (written by Stage 0)
        summary = page.get("summary", "")
        if summary:
            logger.debug(f"sbert_text source=page_summary_fallback url={page['url']}")
            return (f"{title}. {summary[:800]}", "page_summary_fallback")

        # Last resort: URL path tokens. Emits a warning because this
        # means clustering is operating on essentially no content for
        # this row — worth investigating individually.
        from urllib.parse import urlparse

        path_tokens = urlparse(page["url"]).path.strip("/").replace("-", " ").replace("_", " ")
        logger.warning(
            f"sbert_text source=url_path_fallback tool={tool_selected} "
            f"url={page['url']} — no fetched_content and no content_summary"
        )
        return (f"{title} {path_tokens}", "url_path_fallback")

    def _build_embedding_text_v2(self, page: dict) -> tuple[str, str]:
        """Text recipe ctv2 for the candidate embedding path — ONE register.

        Preference order is deliberately inverted from ``_build_sbert_text``:
        ``content_summary`` comes FIRST, so the overwhelming majority of
        pages embed in the same textual register instead of a mixture of raw
        fetcher output and summaries (findings F3). CORRECTION (2026-07-16):
        ``content_summary`` is NOT an LLM summary — it is the capture-time
        first ~300 CHARS of the extracted primary text (see
        ``backend/api/main.py`` ``process_capture``: ``primary_text[:300]``),
        so this register is effectively title + head-sample. Measured on the
        mirror 2026-07-16: 100% of pages have a content_summary and ~90% of
        clusterable pages sit at the 300-char cap, which means the
        2000-word fallback below is dead code in practice and most pages
        embed on title + first ~50 words while the full extracted text
        (~10-30x more) sits unused in ``fetched_content``. Improving this is
        the ctv3 follow-up (see the private sc-followups spec).
        Pages without a summary would fall back to primary text capped at
        2000 words — text-embedding-3-small accepts 8k tokens, so that path
        truncates nothing (F2's claim holds only there). The URL-token
        fallback only exists for completeness; Filter B removes those pages
        before clustering.

        Returns ``(text, source)`` with a ``ctv2:`` source prefix so audit
        rows are distinguishable from legacy-recipe rows.
        """
        title = page["title"]
        summary = page.get("summary", "")
        if summary:
            return (f"{title}. {summary}", "ctv2:title_summary")

        from backend.services.content_fetcher import get_primary_text_from_dict

        text, source = get_primary_text_from_dict(
            page.get("tool_selected"),
            page.get("full_content") or {},
            for_clustering=True,
        )
        if text:
            words = text.split()
            if len(words) > 2000:
                text = " ".join(words[:2000])
            return (text, f"ctv2:{source}")

        from urllib.parse import urlparse

        path_tokens = urlparse(page["url"]).path.strip("/").replace("-", " ").replace("_", " ")
        return (f"{title} {path_tokens}", "ctv2:url_path_fallback")

    def _build_embedding_text_v3(
        self, page: dict, gists: dict[int, str]
    ) -> tuple[str, str]:
        """Text recipe ctv3 — title + LLM gist (sc-followups 2026-07-16).

        The gist is a 2-3 sentence topical summary of the page's subject
        matter (gpt-4o-mini, cached per (page, GIST_PROMPT_KEY) in
        embedding_gists), replacing ctv2's 300-char head sample. Pages
        without a gist (generation failed / not yet backfilled) fall back
        to title + primary text capped at 2000 words — still strictly more
        signal than the head sample. URL-token last resort mirrors v2.
        """
        title = page["title"]
        pcid = page.get("page_content_id")
        gist = gists.get(pcid) if pcid is not None else None
        if gist:
            return (f"{title}. {gist}", "ctv3:gist")

        from backend.services.content_fetcher import get_primary_text_from_dict

        text, source = get_primary_text_from_dict(
            page.get("tool_selected"),
            page.get("full_content") or {},
            for_clustering=True,
        )
        if text:
            words = text.split()
            if len(words) > 2000:
                text = " ".join(words[:2000])
            if not text.startswith(title):
                text = f"{title}. {text}"
            return (text, f"ctv3:primary_text_fallback:{source}")

        from urllib.parse import urlparse

        path_tokens = urlparse(page["url"]).path.strip("/").replace("-", " ").replace("_", " ")
        return (f"{title} {path_tokens}", "ctv3:url_path_fallback")

    async def _generate_embedding_gists(
        self, pages: list[dict]
    ) -> tuple[dict[int, str], float]:
        """Batched gpt-4o-mini gists for pages missing one (ctv3).

        Input per page: title + primary text capped at GIST_INPUT_WORD_CAP
        words. Batches of GIST_BATCH_SIZE pages per call, JSON mode,
        temperature 0 + seed for stability. FAIL-OPEN per batch: a failed
        call/parse skips those pages (they embed via the v3 fallback
        register this run and retry next recluster). Returns
        ({page_content_id: gist}, total_cost_usd); caller persists via
        embedding_repo.upsert_embedding_gists + cost event
        event_type='embedding_gist'.
        """
        import json as _json

        from backend.services.content_fetcher import get_primary_text_from_dict
        from backend.services.llm_service import LLMService
        from backend.services.super_cluster_service import (
            ASSIGNMENT_MODEL,
            ASSIGNMENT_SEED,
        )

        result: dict[int, str] = {}
        total_cost = 0.0
        llm = LLMService()

        def _entry(page: dict) -> dict | None:
            pcid = page.get("page_content_id")
            if pcid is None:
                return None
            text, _src = get_primary_text_from_dict(
                page.get("tool_selected"),
                page.get("full_content") or {},
                for_clustering=True,
            )
            words = (text or "").split()
            excerpt = " ".join(words[:GIST_INPUT_WORD_CAP])
            return {"id": pcid, "title": page["title"], "text": excerpt}

        entries = [e for e in (_entry(p) for p in pages) if e is not None]
        for i in range(0, len(entries), GIST_BATCH_SIZE):
            chunk = entries[i : i + GIST_BATCH_SIZE]
            prompt = (
                "For each PAGE below, write a 2-3 sentence gist of its "
                "subject matter, for topical clustering. Describe WHAT the "
                "page is about with concrete nouns; do not describe the "
                "page itself ('this page...', 'an article about...').\n\n"
                f"PAGES (JSON):\n{_json.dumps(chunk, ensure_ascii=False)}\n\n"
                "Return JSON ONLY in this exact shape:\n"
                '{"gists": [{"id": <id>, "gist": "<2-3 sentences>"}, ...]}'
            )
            try:
                response = await llm.complete(
                    prompt=prompt,
                    model=ASSIGNMENT_MODEL,
                    temperature=0.0,
                    max_tokens=4000,
                    seed=ASSIGNMENT_SEED,
                    response_format="json_object",
                )
            except Exception as e:
                logger.error(f"gist batch {i // GIST_BATCH_SIZE} failed (fail-open): {e}")
                continue
            total_cost += response.cost_usd
            try:
                ids_in_chunk = {c["id"] for c in chunk}
                for g in _json.loads(response.content).get("gists", []):
                    gid, gist = g.get("id"), (g.get("gist") or "").strip()
                    if gid in ids_in_chunk and gist:
                        result[gid] = gist
            except (ValueError, KeyError, TypeError) as e:
                logger.error(f"gist batch parse failed (fail-open): {e}")
        return result, total_cost

    _TITLE_SEPARATOR_RE = re.compile(r"\s[-–—|]\s")
    """Matches a separator character (hyphen, en dash, em dash, pipe) with a
    real space on BOTH sides — deliberately excludes bare/spaceless hyphens
    (``state-of-the-art``, ``widget-catalog``) so ctv2s's title-suffix
    stripping (below) can never touch a mid-title hyphen."""

    _SITE_TOKEN_SKIP_LABELS = {
        "www", "en", "m", "help", "docs", "connect", "app", "api",
        "com", "org", "net", "dev", "io", "ai", "gov", "edu", "co",
    }
    """Subdomain-prefix / TLD labels ignored when deriving a domain's core
    site-name stem (``_derive_site_token``). Shared with
    ``_TITLE_SUFFIX_FILLER_WORDS`` below — the same noise words that don't
    count as a domain's identity also don't count as real title content
    when they show up next to the site token in a stripped suffix."""

    _TITLE_SUFFIX_FILLER_WORDS = _SITE_TOKEN_SKIP_LABELS | {
        "the", "official", "site", "home", "wiki", "tutorial",
    }
    """Words allowed alongside the site token in a title's trailing segment
    for ``_strip_title_suffix`` to treat it as a pure format-cue suffix
    (2026-08-14 tightening — see that method's docstring for the bug this
    fixes)."""

    @classmethod
    def _derive_site_token(cls, domain: str) -> str:
        """Best-effort site-name stem from a domain, for ctv2s suffix/token
        matching — ``"en.wikipedia.org"`` -> ``"wikipedia"``,
        ``"www.printables.com"`` -> ``"printables"``, ``"svelte.dev"`` ->
        ``"svelte"``. Drops common subdomain prefixes and TLDs; falls back
        to the first label when nothing survives filtering.
        """
        if not domain:
            return ""
        labels = domain.lower().split(".")
        core = [label for label in labels if label not in cls._SITE_TOKEN_SKIP_LABELS]
        return core[0] if core else labels[0]

    @classmethod
    def _strip_title_suffix(cls, title: str, domain: str) -> str:
        """Strip a trailing ' - Site' / ' | Site' style suffix from *title*
        — ONLY when the trailing segment (after the LAST spaced separator)
        IS the page's OWN domain name, optionally plus small filler words
        (``_TITLE_SUFFIX_FILLER_WORDS`` — "the", "official", "site", plus
        the subdomain/TLD noise words ``_derive_site_token`` already
        ignores, e.g. "com"/"org" so ``"... | Printables.com"`` still
        strips). Titles with no spaced separator (e.g.
        ``"widget-catalog"``, hyphen with no surrounding spaces) never
        reach the domain check at all — see ``_TITLE_SEPARATOR_RE``.

        Tightened 2026-08-14 (clustering-quality backlog review): the
        previous check stripped whenever the trailing segment merely
        CONTAINED the site token as one word among others, which ate real
        content — ``"Spool Holder - Printables Contest Winner"`` lost
        "Contest Winner" because "printables" happened to appear in the
        trailing segment. Now the trailing segment's entire word-set must
        be the site token plus only filler words for the strip to fire; a
        substantive word anywhere in the trailing segment (e.g. "Contest",
        "Winner") blocks the strip and the title is returned unchanged.
        """
        token = cls._derive_site_token(domain)
        if not token:
            return title
        matches = list(cls._TITLE_SEPARATOR_RE.finditer(title))
        if not matches:
            return title
        last = matches[-1]
        head, trailing = title[: last.start()], title[last.end():].strip()
        trailing_words = re.findall(r"[a-z0-9]+", trailing.lower())
        if not trailing_words or token not in trailing_words:
            return title
        remaining = [w for w in trailing_words if w != token]
        if all(w in cls._TITLE_SUFFIX_FILLER_WORDS for w in remaining):
            return head.rstrip()
        return title

    @staticmethod
    def _strip_domain_tokens(text: str, domain: str) -> str:
        """Remove bare occurrences of the literal domain string (e.g.
        ``"printables.com"``, ``"www.printables.com"``) from *text* —
        breadcrumb/footer format cues, not prose. Word-bounded and
        case-insensitive; a plain mention of a site's NAME without the
        domain suffix attached (``"Printables"`` on its own) is left alone,
        so genuine content about a site is never mangled.
        """
        if not domain:
            return text
        variants = {domain}
        variants.add(domain[4:] if domain.startswith("www.") else f"www.{domain}")
        for variant in sorted(variants, key=len, reverse=True):
            text = re.sub(
                r"(?<![\w.])" + re.escape(variant) + r"(?![\w.])",
                "",
                text,
                flags=re.IGNORECASE,
            )
        return re.sub(r"[ \t]{2,}", " ", text).strip()

    def _v2b_text(self, page: dict, title: str, prefix: str) -> tuple[str, str]:
        """Shared body-assembly for ctv2b/ctv2s: *title* + ~1200-char
        fetcher primary-text sample, falling back to ctv2's remaining chain
        (content_summary, then URL path tokens) when primary text is
        unavailable. *title* lets ctv2s pass its (possibly suffix-stripped)
        title through the same assembly ctv2b uses untouched.
        """
        from backend.services.content_fetcher import get_primary_text_from_dict

        text, source = get_primary_text_from_dict(
            page.get("tool_selected"),
            page.get("full_content") or {},
            for_clustering=True,
        )
        if text:
            return (f"{title}. {text[:1200]}", f"{prefix}:{source}")

        summary = page.get("summary", "")
        if summary:
            return (f"{title}. {summary}", f"{prefix}:summary_fallback")

        from urllib.parse import urlparse

        path_tokens = urlparse(page["url"]).path.strip("/").replace("-", " ").replace("_", " ")
        return (f"{title} {path_tokens}", f"{prefix}:url_path_fallback")

    def _build_embedding_text_v2b(self, page: dict) -> tuple[str, str]:
        """Text recipe ctv2b — "body": title + ~1200-char fetcher
        primary-text sample, replacing ctv2's 300-char content_summary head
        (clustering-quality backlog, 2026-08-14). ctv2's summary register
        caps at 300 chars for ~90% of clusterable pages (see
        ``_build_embedding_text_v2``'s docstring), so most pages there embed
        on title + ~50 words; ctv2b instead samples the fetcher's PRIMARY
        text directly (``content_fetcher.get_primary_text_from_dict``,
        ``for_clustering=True`` — ~4x ctv2's effective window) and falls
        back to ctv2's remaining chain (content_summary, then URL path
        tokens) when primary text is unavailable.

        Returns ``(text, source)`` with a ``ctv2b:`` source prefix.
        """
        return self._v2b_text(page, page["title"], "ctv2b")

    def _build_embedding_text_v2s(self, page: dict) -> tuple[str, str]:
        """Text recipe ctv2s — ctv2b plus source-format-cue stripping.

        Strips a trailing title site-suffix (``" - Wikipedia"``,
        ``" | Printables.com"`` style — only when the trailing segment IS
        the page's OWN domain name plus optional filler words, never merely
        CONTAINS it; see ``_strip_title_suffix``) and removes bare
        occurrences of the literal domain string from the assembled text
        (breadcrumb/footer format cues; see ``_strip_domain_tokens``).
        Deliberately conservative: never touches mid-title hyphens or plain
        prose mentions of a site's name.

        Returns ``(text, source)`` with a ``ctv2s:`` source prefix.
        """
        domain = page.get("domain") or ""
        title = self._strip_title_suffix(page["title"], domain)
        text, source = self._v2b_text(page, title, "ctv2s")
        text = self._strip_domain_tokens(text, domain)
        return (text, source)

    def _compute_embeddings_openai(
        self, pages: list[dict], model_name: str
    ) -> np.ndarray:
        """Candidate embedding path: OpenAI API + ctv2 recipe + versioned cache.

        Mirrors the legacy ``_compute_embeddings`` contract (row i of the
        returned matrix corresponds to ``pages[i]``, rows L2-normalized) but
        reads/writes the dimension-flexible ``clustering_embeddings`` table
        keyed by ``<model>@<contract>``, and records a ``clustering_embedding``
        cost event per run (Q1 decision: API embedding joins cost monitoring).
        """
        from backend.db import embedding_repo

        contract = settings.clustering_text_contract
        model_key = f"{model_name}@{contract}"
        content_ids = [p.get("page_content_id") for p in pages]
        valid_content_ids = [cid for cid in content_ids if cid is not None]
        cached = embedding_repo.get_clustering_embeddings(valid_content_ids, model_key)

        encode_indices: list[int] = [
            i
            for i, page in enumerate(pages)
            if not (content_ids[i] is not None and content_ids[i] in cached)
        ]

        # ctv3 only: resolve cached gists for the pages we're about to embed,
        # generating+persisting any that are missing (fail-open — a page
        # without a gist embeds via _build_embedding_text_v3's fallback
        # register this run and gets a fresh gist attempt next recluster).
        gists: dict[int, str] = {}
        if contract == "ctv3" and encode_indices:
            to_gist = [pages[i] for i in encode_indices]
            pcids = [
                p["page_content_id"]
                for p in to_gist
                if p.get("page_content_id") is not None
            ]
            gists = embedding_repo.get_embedding_gists(pcids, GIST_PROMPT_KEY)
            missing = [
                p
                for p in to_gist
                if p.get("page_content_id") is not None
                and p["page_content_id"] not in gists
            ]
            if missing:
                new_gists, gist_cost = _run_coro_blocking(
                    self._generate_embedding_gists(missing)
                )
                if new_gists:
                    embedding_repo.upsert_embedding_gists(
                        sorted(new_gists.items()), GIST_PROMPT_KEY
                    )
                    gists.update(new_gists)
                try:
                    from backend.db import trends_repo

                    trends_repo.insert_cost_event(
                        user_id=self._get_user_id(),
                        event_type="embedding_gist",
                        model=NAMING_MODEL,
                        cost_usd=gist_cost,
                        metadata={
                            "pages": len(missing),
                            "gists_generated": len(new_gists),
                            "prompt_key": GIST_PROMPT_KEY,
                        },
                    )
                except Exception:
                    logger.debug("embedding gist cost event insert failed", exc_info=True)

        texts_to_encode: list[str] = []
        text_sources: list[str] = []
        for i in encode_indices:
            page = pages[i]
            if contract == "ctv3":
                text, source = self._build_embedding_text_v3(page, gists)
            elif contract == "ctv2b":
                text, source = self._build_embedding_text_v2b(page)
            elif contract == "ctv2s":
                text, source = self._build_embedding_text_v2s(page)
            else:
                text, source = self._build_embedding_text_v2(page)
            texts_to_encode.append(text)
            text_sources.append(source)

        new_vectors: list[list[float]] = []
        if texts_to_encode:
            logger.info(
                f"Embedding {len(texts_to_encode)} new pages via {model_name} "
                f"(of {len(pages)} total; cache key {model_key})"
            )
            from openai import OpenAI

            client = OpenAI(api_key=settings.openai_api_key)
            total_tokens = 0
            for start in range(0, len(texts_to_encode), OPENAI_EMBED_BATCH_SIZE):
                chunk = texts_to_encode[start : start + OPENAI_EMBED_BATCH_SIZE]
                resp = client.embeddings.create(model=model_name, input=chunk)
                for item in sorted(resp.data, key=lambda d: d.index):
                    new_vectors.append(item.embedding)
                total_tokens += resp.usage.total_tokens
                logger.info(
                    f"  embedded {min(start + OPENAI_EMBED_BATCH_SIZE, len(texts_to_encode))}"
                    f"/{len(texts_to_encode)}"
                )

            cost_usd = total_tokens / 1_000_000 * OPENAI_EMBED_PRICE_PER_MTOK.get(
                model_name, 0.02
            )
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=self._get_user_id(),
                    event_type="clustering_embedding",
                    model=model_name,
                    input_tokens=total_tokens,
                    cost_usd=cost_usd,
                    metadata={"pages": len(texts_to_encode), "model_key": model_key},
                )
            except Exception:
                logger.debug("clustering embedding cost event insert failed", exc_info=True)

            bulk_rows = []
            audit_rows = []
            for j, idx in enumerate(encode_indices):
                cid = content_ids[idx]
                if cid is not None:
                    bulk_rows.append((cid, new_vectors[j]))
                    cached[cid] = new_vectors[j]
                    audit_rows.append((texts_to_encode[j], text_sources[j], cid))
            if bulk_rows:
                embedding_repo.save_clustering_embeddings_bulk(bulk_rows, model_key)
                logger.info(
                    f"Saved {len(bulk_rows)} embeddings to clustering_embeddings "
                    f"({model_key}), ${cost_usd:.4f}"
                )
            if audit_rows:
                self._save_sbert_text_audit(audit_rows)

        # Assemble matrix; dimension inferred from the vectors (model-dependent)
        dim = None
        if cached:
            dim = len(next(iter(cached.values())))
        elif new_vectors:
            dim = len(new_vectors[0])
        if dim is None:
            return np.empty((0, 0))
        result = np.zeros((len(pages), dim))
        for i in range(len(pages)):
            cid = content_ids[i]
            if cid is not None and cid in cached:
                result[i] = cached[cid]
        for j, idx in enumerate(encode_indices):
            result[idx] = new_vectors[j]
        # OpenAI embeddings arrive ~unit-norm; enforce exact L2 normalization
        # so downstream cosine math matches the legacy path's guarantees.
        norms = np.linalg.norm(result, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return result / norms

    def _compute_embeddings(self, pages: list[dict]) -> np.ndarray:
        """Compute clustering embeddings with pgvector-backed caching.

        Routes on ``settings.clustering_embedding_model``: the default SBERT
        model keeps the legacy path below byte-identical (page_embeddings
        cache); a ``text-embedding-*`` value routes to
        :meth:`_compute_embeddings_openai` (gated candidate path).

        Legacy path: reads existing embeddings from page_embeddings table
        (keyed by page_content_id). Only pages without cached embeddings are
        encoded. New embeddings are written back to pgvector.
        """
        if settings.clustering_embedding_model.startswith("text-embedding-"):
            return self._compute_embeddings_openai(
                pages, settings.clustering_embedding_model
            )

        from backend.db import embedding_repo

        # Batch-fetch cached embeddings for pages that have a page_content_id
        content_ids = [p.get("page_content_id") for p in pages]
        valid_content_ids = [cid for cid in content_ids if cid is not None]
        cached = embedding_repo.get_embeddings_for_content_ids(valid_content_ids)

        # Determine which pages need encoding
        texts_to_encode: list[str] = []
        text_sources: list[str] = []
        encode_indices: list[int] = []

        for i, page in enumerate(pages):
            cid = content_ids[i]
            if cid is not None and cid in cached:
                continue  # Already in pgvector
            text, source = self._build_sbert_text(page)
            texts_to_encode.append(text)
            text_sources.append(source)
            encode_indices.append(i)

        # Encode new pages
        if texts_to_encode:
            logger.info(f"Encoding {len(texts_to_encode)} new pages (of {len(pages)} total)")
            model = self._get_sbert_model()
            new_embeddings = model.encode(texts_to_encode, show_progress_bar=False, batch_size=64)
            new_embeddings = new_embeddings / np.linalg.norm(new_embeddings, axis=1, keepdims=True)

            # Save new embeddings to pgvector
            bulk_rows = []
            for j, idx in enumerate(encode_indices):
                cid = content_ids[idx]
                if cid is not None:
                    emb_list = new_embeddings[j].tolist()
                    bulk_rows.append((cid, emb_list))
                    cached[cid] = emb_list

            if bulk_rows:
                embedding_repo.save_embeddings_bulk(bulk_rows)
                logger.info(f"Saved {len(bulk_rows)} embeddings to pgvector")

            # Write sbert_text audit columns to page_content for newly-encoded pages
            audit_rows = []
            for j, idx in enumerate(encode_indices):
                cid = content_ids[idx]
                if cid is not None:
                    audit_rows.append((texts_to_encode[j], text_sources[j], cid))
            if audit_rows:
                self._save_sbert_text_audit(audit_rows)
        else:
            logger.info(f"All {len(pages)} pages found in pgvector cache")
            new_embeddings = np.empty((0, 384))

        # Build output matrix: cached embeddings + newly encoded ones
        result = np.zeros((len(pages), 384))
        for i, page in enumerate(pages):
            cid = content_ids[i]
            if cid is not None and cid in cached:
                result[i] = cached[cid]
        for j, idx in enumerate(encode_indices):
            result[idx] = new_embeddings[j]

        return result

    @staticmethod
    def _save_sbert_text_audit(rows: list[tuple[str, str, int]]) -> None:
        """Bulk-write sbert_text + sbert_text_source to page_content.

        Each row is ``(sbert_text, sbert_text_source, page_content_id)``.
        """
        from backend.db.connection import get_conn

        with get_conn() as conn:
            with conn.cursor() as cur:
                for text, source, cid in rows:
                    cur.execute(
                        "UPDATE page_content "
                        "SET sbert_text = %s, sbert_text_source = %s "
                        "WHERE id = %s",
                        (text, source, cid),
                    )
            conn.commit()
        logger.info(f"Wrote sbert_text audit columns for {len(rows)} pages")

    # ── HDBSCAN ─────────────────────────────────────────────────────────

    def _run_hdbscan(
        self, embeddings: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
        """Run HDBSCAN on cosine distance matrix.

        Returns (labels, outlier_scores, probabilities).

        Scales min_cluster_size with data volume to avoid micro-cluster
        fragmentation as the page count grows. ``outlier_scores`` is per-point
        and used downstream by ``_select_featured_singletons`` to pick the
        most-outlier-like noise pages for the starfield. ``probabilities``
        is per-point soft-clustering membership strength in [0, 1] (sklearn's
        ``hdb.probabilities_``, present in both the precomputed-cosine and
        UMAP-reduced branches as of sklearn 1.9 -- verified 2026-07-13);
        ``_write_clusters_to_db`` averages it per cluster into
        ``mean_membership_probability`` (migration 038). None when the
        installed sklearn doesn't expose the attribute -- callers must
        guard, not assume.

        sklearn's HDBSCAN (1.8+) doesn't expose ``outlier_scores_`` -- that
        attribute lives on the standalone ``hdbscan`` package. We fall back
        to a cosine-distance-to-nearest-cluster-centroid signal: noise points
        far from any cluster centroid score high (uniquely outlier-like),
        noise points near a cluster centroid score low (almost-clustered).
        Same downstream semantics: higher = more outlier-like.
        """
        n_pages = len(embeddings)
        # Read tunable floor from settings; runtime scales up with corpus
        # size via n_pages // MIN_CLUSTER_SIZE_DIVISOR (so very large compendiums get tighter
        # clusters automatically). Override via HDBSCAN_MIN_CLUSTER_SIZE env
        # var. See backend/config/settings.py::Settings.hdbscan_min_cluster_size
        # for the gate-permissiveness x cluster-size coupling rationale.
        min_size = max(settings.hdbscan_min_cluster_size, n_pages // MIN_CLUSTER_SIZE_DIVISOR)
        umap_dims = settings.clustering_umap_dims
        logger.info(
            f"HDBSCAN: min_cluster_size={min_size} (settings floor "
            f"{settings.hdbscan_min_cluster_size} vs scaled {n_pages // MIN_CLUSTER_SIZE_DIVISOR}), "
            f"min_samples={settings.hdbscan_min_samples}, "
            f"selection={settings.hdbscan_selection_method}, "
            f"epsilon={settings.hdbscan_selection_epsilon}, "
            f"umap_dims={umap_dims or 'off'} for {n_pages} pages"
        )

        # Increment-2 branch (finding F5): with reduction on, cluster the
        # UMAP-reduced vectors with euclidean metric (BERTopic-style);
        # otherwise legacy precomputed cosine in the full embedding space.
        if umap_dims > 0:
            fit_input = self._reduce_embeddings(embeddings, umap_dims)
            metric = "euclidean"
        else:
            fit_input = cosine_distances(embeddings)
            metric = "precomputed"

        hdb = HDBSCAN(
            metric=metric,
            min_cluster_size=min_size,
            min_samples=settings.hdbscan_min_samples,
            cluster_selection_method=settings.hdbscan_selection_method,
            cluster_selection_epsilon=settings.hdbscan_selection_epsilon,
        )
        hdb.fit(fit_input)
        labels = hdb.labels_

        # Try the standalone hdbscan package's signal first; fall back to
        # centroid-distance computation when only sklearn is present.
        # ALWAYS computed against the original full-dim embeddings, not the
        # reduced space -- featured-singleton (starfield) semantics stay
        # stable and comparable across reduction configs.
        outlier_scores = getattr(hdb, "outlier_scores_", None)
        if outlier_scores is None:
            outlier_scores = self._compute_outlier_scores_from_centroids(
                labels, embeddings
            )

        # Per-point membership confidence for mean_membership_probability
        # (migration 038). Present on sklearn 1.9's HDBSCAN in both branches
        # above (verified 2026-07-13); guard anyway since sklearn version is
        # not pinned exactly and older/future releases could drop it --
        # NULL downstream, never a hard failure.
        probabilities = getattr(hdb, "probabilities_", None)
        if probabilities is None:
            global _PROBABILITIES_MISSING_WARNED
            if not _PROBABILITIES_MISSING_WARNED:
                logger.warning(
                    "HDBSCAN.probabilities_ not present on this sklearn "
                    "install -- mean_membership_probability will be NULL "
                    "for all clusters this run (and until sklearn is "
                    "upgraded)."
                )
                _PROBABILITIES_MISSING_WARNED = True

        return labels, outlier_scores, probabilities

    @staticmethod
    def _reduce_embeddings(embeddings: np.ndarray, n_components: int) -> np.ndarray:
        """UMAP-reduce embeddings ahead of HDBSCAN (increment 2, finding F5).

        cosine metric matches the embedding space's semantics; ``min_dist=0``
        packs points tightly (the clustering-oriented UMAP setting, vs the
        visualization-oriented defaults); ``random_state=42`` pins the
        otherwise-stochastic layout so identical inputs give identical
        partitions run-to-run -- this forces single-threaded UMAP, fine at
        compendium scale. ``n_neighbors`` is clamped below n_samples per
        UMAP's requirement.
        """
        import umap

        n_neighbors = min(
            settings.clustering_umap_n_neighbors, max(2, len(embeddings) - 1)
        )
        reducer = umap.UMAP(
            n_components=n_components,
            n_neighbors=n_neighbors,
            min_dist=0.0,
            metric="cosine",
            random_state=42,
        )
        return reducer.fit_transform(embeddings)

    @staticmethod
    def _compute_outlier_scores_from_centroids(
        labels: np.ndarray, embeddings: np.ndarray
    ) -> np.ndarray:
        """Per-point outlier signal: cosine distance to nearest cluster centroid.

        For every point (clustered or noise), compute distance to the centroid
        of every real HDBSCAN cluster, take the min. Higher = more outlier-like.
        Pure function so the comparison script can reuse it.

        Edge case: if there are no real clusters (every point is noise),
        return zeros -- there's no centroid to measure distance to, and the
        downstream picker handles a zero-score input by deterministic order.
        """
        cluster_ids = np.unique(labels[labels != -1])
        if len(cluster_ids) == 0:
            return np.zeros(len(labels), dtype=np.float64)

        centroids = np.stack(
            [embeddings[labels == cid].mean(axis=0) for cid in cluster_ids]
        )
        # cosine distance from every point to every centroid; min over centroids
        dists = cosine_distances(embeddings, centroids)
        return dists.min(axis=1).astype(np.float64)

    @staticmethod
    def _select_featured_singletons(
        labels: np.ndarray,
        outlier_scores: np.ndarray,
        embeddings: np.ndarray,
        n_real_clusters: int,
        density_pct: float = FEATURED_SINGLETONS_DENSITY_PCT,
    ) -> list[tuple[int, float]]:
        """Pick K HDBSCAN-noise points for the labeled starfield via
        outlier-rank + farthest-point sample.

        Replaces the prior top-K-by-outlier_score selection, which permitted
        clumping when multiple high-outlier points were embedding-space
        neighbors (the "middle-left clump" seen on user 152 pre-2026-04-27).

        Algorithm:
            1. Filter noise points (label == -1) with finite outlier_scores.
            2. Sort descending by outlier_score; take top-2K candidates as the
               outlier-likeness floor.
            3. Greedy farthest-point sample K from those 2K: seed with the
               highest outlier; at each step, pick the candidate maximizing
               minimum cosine distance to already-picked points.

        Result: K labeled singletons that are both outlier-like AND spatially
        distributed. Cost: O(K^2) per recluster, K = ~6-30, negligible.

        The remaining noise points (those not picked here) still appear on the
        graph as faux 1-page clusters via ``graph_builder``, but without
        page-title labels -- see ``settings.featured_singletons_visible_pct``.
        """
        target_n = max(0, round(n_real_clusters * density_pct))
        if target_n == 0:
            return []
        noise_indices = np.where(labels == -1)[0]
        if len(noise_indices) == 0:
            return []
        scored = [
            (int(i), float(outlier_scores[i]))
            for i in noise_indices
            if not np.isnan(outlier_scores[i])
        ]
        if not scored:
            return []
        scored.sort(key=lambda x: -x[1])

        # Top-2K candidates establish the outlier-likeness floor. If we have
        # fewer noise points than target_n, return what we have (FPS becomes
        # vacuous on a single-element pool).
        candidate_pool = scored[: 2 * target_n]
        if len(candidate_pool) <= target_n:
            return candidate_pool[:target_n]

        candidate_indices = np.array([i for i, _ in candidate_pool])
        candidate_embeddings = embeddings[candidate_indices]
        candidate_scores = np.array([s for _, s in candidate_pool])

        # Seed FPS with the top-outlier candidate; iteratively pick the
        # candidate maximizing minimum cosine distance to already-picked.
        picked_local: list[int] = [0]
        min_dist = cosine_distances(
            candidate_embeddings, candidate_embeddings[[0]]
        ).flatten()
        while len(picked_local) < target_n:
            masked = min_dist.copy()
            masked[picked_local] = -np.inf
            next_local = int(np.argmax(masked))
            picked_local.append(next_local)
            new_dists = cosine_distances(
                candidate_embeddings, candidate_embeddings[[next_local]]
            ).flatten()
            min_dist = np.minimum(min_dist, new_dists)

        return [
            (int(candidate_indices[k]), float(candidate_scores[k]))
            for k in picked_local
        ]

    # ── LLM naming ──────────────────────────────────────────────────────

    @staticmethod
    def _build_naming_prompt(
        cid: int,
        labels: np.ndarray,
        pages: list[dict],
    ) -> str:
        """Construct the cluster-naming prompt for cluster ``cid``.

        Extracted as a static helper so the realtime (:meth:`_name_one_cluster`)
        and Batch-API (:meth:`_name_clusters_batch`) paths produce byte-identical
        prompts — important for cache-hit comparability and for the batch-mode
        quality claim in the M14 report.

        Renders from the versioned prompt registry
        (``backend.prompts.templates``, entries ``cluster_naming_v1a`` /
        ``cluster_naming_v1b``) -- moved out of an inline f-string by the
        clustering-quality backlog (2026-08-14). Version selected by
        ``settings.cluster_naming_prompt_version`` (default v1a, byte-
        identical to the pre-migration prompt). Uses ``get_prompt_raw()``,
        not ``get_prompt()`` -- see that helper's docstring for why
        (byte-identical parity requires skipping the sanitize-and-wrap
        step).
        """
        mask = labels == cid
        cluster_pages = [pages[i] for i in range(len(pages)) if mask[i]]

        sample = cluster_pages[:NAMING_SAMPLE_SIZE]
        page_lines = []
        for p in sample:
            title = (p["title"] or "(no title)")[:100]
            domain = p.get("domain", "")
            excerpt = ""
            if p.get("summary"):
                excerpt = ": " + p["summary"][:150].replace("\n", " ")
            page_lines.append(f"- {title} [{domain}]{excerpt}")

        context = "\n".join(page_lines)
        n_pages = int(mask.sum())

        from backend.prompts.templates import get_prompt_raw

        return get_prompt_raw(
            f"cluster_naming_{settings.cluster_naming_prompt_version}",
            n_pages=n_pages,
            context=context,
        )

    async def _name_one_cluster(
        self,
        cid: int,
        labels: np.ndarray,
        pages: list[dict],
    ) -> tuple[int, str, float]:
        """Name a single cluster via LLM. Raises on failure (no fallback)."""
        prompt = self._build_naming_prompt(cid, labels, pages)
        response = await self._llm.complete(
            prompt=prompt,
            model=NAMING_MODEL,
            temperature=NAMING_TEMPERATURE,
            max_tokens=NAMING_MAX_TOKENS,
        )
        name = response.content.strip().strip("\"'")
        return cid, name, response.cost_usd

    async def _name_clusters(
        self,
        cluster_ids: list[int],
        labels: np.ndarray,
        pages: list[dict],
    ) -> tuple[dict[int, str], float]:
        """Name each cluster via gpt-4o-mini.

        Pre-flight checks the first cluster to surface config/auth errors
        early. Remaining clusters are named with a concurrency limit.
        """
        if not cluster_ids:
            return {}, 0.0

        logger.info(f"Naming {len(cluster_ids)} clusters via {NAMING_MODEL}...")

        # Pre-flight: try the first cluster to catch auth/config errors early.
        # Pre-flight failure means the LLM service is down / misconfigured /
        # rate-limited -- in that state we should NOT proceed to writing
        # ``Cluster N`` fallback names for all 50+ clusters, because those
        # rows persist in the archive (cleanup_old_runs uses archive
        # semantics) and bleed into downstream queries that join through
        # page_clusters / clusters (e.g. session-diary tag pills). Raise
        # to surface the failure to ``recluster_all``'s outer try/except,
        # which calls ``recluster_repo.fail_run`` and rolls back the run
        # so no garbage cluster_name rows are persisted.
        first_cid = cluster_ids[0]
        try:
            _, first_name, first_cost = await self._name_one_cluster(
                first_cid,
                labels,
                pages,
            )
        except Exception as e:
            logger.error(
                "Cluster naming pre-flight failed: %s -- aborting recluster "
                "(no garbage Cluster-N rows will be written)",
                e,
            )
            raise

        # First succeeded — name the rest with concurrency limit
        sem = asyncio.Semaphore(10)

        async def _name_limited(cid: int) -> tuple[int, str, float]:
            async with sem:
                return await self._name_one_cluster(cid, labels, pages)

        tasks = [_name_limited(cid) for cid in cluster_ids[1:]]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        cluster_names: dict[int, str] = {first_cid: first_name}
        total_cost = first_cost
        fail_count = 0
        for result in results:
            if isinstance(result, BaseException):
                fail_count += 1
                continue
            cid, name, cost = result  # type: ignore[misc]
            cluster_names[cid] = name
            total_cost += cost

        # Fill in fallbacks for any that failed
        for cid in cluster_ids:
            if cid not in cluster_names:
                cluster_names[cid] = f"Cluster {cid}"

        if fail_count:
            logger.warning(f"{fail_count}/{len(cluster_ids)} naming calls failed")

        logger.info(f"Named {len(cluster_names)} clusters (${total_cost:.4f})")
        return cluster_names, total_cost

    async def _name_clusters_batch(
        self,
        cluster_ids: list[int],
        labels: np.ndarray,
        pages: list[dict],
    ) -> tuple[dict[int, str], float]:
        """Name all clusters via the OpenAI Batch API (50% cost discount, ≤24h SLA).

        Builds one chat-completion request per cluster — identical prompt to the
        realtime path — submits as a single Batch API job, waits for completion,
        and parses the results. Intended for the deferred-maintenance path
        invoked by the nightly scheduler (see ``backend/services/scheduler.py``).
        Any per-request failure falls back to the ``Cluster N`` placeholder,
        matching the realtime path's behavior.
        """
        if not cluster_ids:
            return {}, 0.0

        logger.info(
            f"Naming {len(cluster_ids)} clusters via Batch API ({NAMING_MODEL})..."
        )

        # Build batch requests. Keep custom_id stable so we can map results
        # back to the integer cluster ids.
        requests: list[dict] = []
        for cid in cluster_ids:
            prompt = self._build_naming_prompt(cid, labels, pages)
            requests.append(
                {
                    "custom_id": f"cluster_{cid}",
                    "body": {
                        "model": NAMING_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": NAMING_TEMPERATURE,
                        "max_tokens": NAMING_MAX_TOKENS,
                    },
                }
            )

        batch_id = await self._llm.submit_batch(requests)
        logger.info(f"Submitted batch {batch_id} with {len(requests)} cluster-naming requests")

        results = await self._llm.await_batch(
            batch_id,
            poll_interval=10.0,
            timeout=3600.0,
            model_for_pricing=NAMING_MODEL,
        )

        cluster_names: dict[int, str] = {}
        total_cost = 0.0
        fail_count = 0
        for cid in cluster_ids:
            entry = results.get(f"cluster_{cid}")
            if not entry or entry.get("status_code") != 200:
                fail_count += 1
                cluster_names[cid] = f"Cluster {cid}"
                continue
            cluster_names[cid] = entry["content"].strip().strip("\"'")
            total_cost += float(entry["cost_usd"])

        if fail_count:
            logger.warning(
                f"{fail_count}/{len(cluster_ids)} batch naming entries missing/failed — "
                "using fallback names for those"
            )

        logger.info(
            f"Batch-named {len(cluster_names)} clusters (${total_cost:.4f} at batch pricing)"
        )
        return cluster_names, total_cost

    # ── Cluster identity persistence (batch B 4a) ────────────────────────

    def _match_clusters_to_previous(
        self,
        user_id: int,
        cluster_ids: list[int],
        labels: np.ndarray,
        pages: list[dict],
    ) -> dict[int, dict]:
        """Greedy Jaccard match of this run's clusters to the previous run.

        Compares member ``page_content_id`` sets (content ids survive
        re-captures; the clusterable set is already content-deduped) against
        the latest completed run. Pairs are taken highest-Jaccard-first,
        one-to-one, above ``settings.cluster_identity_jaccard``.

        Returns {hdbscan_cid: {"stable_id", "name", "jaccard"}} for matched
        clusters. Previous-run clusters with NULL stable_id (rows predating
        migration 036 or written with identity off) get one minted here, so
        identity bootstraps from any existing run.
        """
        prev = cluster_repo.get_previous_run_membership(user_id)
        if not prev:
            return {}

        new_sets: dict[int, set] = {}
        for cid in cluster_ids:
            idxs = np.where(labels == cid)[0]
            members = {
                pages[i]["page_content_id"]
                for i in idxs
                if pages[i].get("page_content_id") is not None
            }
            if members:
                new_sets[int(cid)] = members

        pairs: list[tuple[float, int, dict]] = []
        for cid, members in new_sets.items():
            for p in prev:
                if not p["content_ids"]:
                    continue
                inter = len(members & p["content_ids"])
                if not inter:
                    continue
                jac = inter / len(members | p["content_ids"])
                if jac >= settings.cluster_identity_jaccard:
                    pairs.append((jac, cid, p))

        pairs.sort(key=lambda t: (-t[0], t[1]))
        taken_new: set[int] = set()
        taken_prev: set[int] = set()
        matches: dict[int, dict] = {}
        for jac, cid, p in pairs:
            if cid in taken_new or p["id"] in taken_prev:
                continue
            taken_new.add(cid)
            taken_prev.add(p["id"])
            matches[cid] = {
                "stable_id": p["stable_id"] or str(uuid.uuid4()),
                "name": p["cluster_name"],
                "jaccard": round(jac, 3),
            }
        return matches

    # ── Write clusters to DB ─────────────────────────────────────────────

    def _write_clusters_to_db(
        self,
        user_id: int,
        run_id: int,
        labels: np.ndarray,
        cluster_names: dict[int, str],
        pages: list[dict],
        embeddings: np.ndarray,
        probabilities: np.ndarray | None = None,
        identity_matches: dict[int, dict] | None = None,
    ) -> dict:
        """Write clusters, page_clusters, and cluster_edges to PostgreSQL.

        When ``identity_matches`` is provided (cluster_identity_enabled),
        matched clusters keep their carried stable_id (name_carried=TRUE) and
        unmatched ones mint a fresh stable_id; with identity off both columns
        stay NULL/FALSE (legacy rows unchanged).

        ``probabilities`` (migration 038, per-point HDBSCAN membership
        confidence, aligned index-for-index with ``labels``) is averaged per
        cluster -- excluding noise points, which have no cluster to average
        into -- into ``mean_membership_probability``. None (sklearn lacks
        ``probabilities_``, see ``_run_hdbscan``) writes NULL for every
        cluster this run, same as historical pre-migration rows.

        Returns ``{"slug_to_db_id": {cluster_slug: DB id}, "stable_ids":
        [...]}``. ``slug_to_db_id`` is what the hybrid supercluster path
        needs to point clusters at their discovered groups (unchanged
        contract, just relocated into this dict -- dqBot Tier 1 needed a
        second value out of this call and a positional tuple return read
        worse at both call sites than a small dict). ``stable_ids`` is
        every stable_id actually written this run (minted + carried,
        post slug-merge dedup) -- the accurate source for spec S3's
        post-recluster expiry pass; empty when identity is off (every
        cluster's stable_id is None then). NOTE: mutates ``labels`` in
        place when slug-identical clusters merge.
        """
        cluster_ids = sorted(set(labels[labels != -1]))
        identity_on = settings.cluster_identity_enabled

        # Save clusters (deduplicate slugs — LLM may produce names that
        # slugify identically, e.g. different casing). First pass resolves
        # merges (mutates labels); mean_membership_probability is computed
        # in a second pass over the now-final labels, so a cluster that
        # absorbs a later slug-duplicate's members has those members'
        # probabilities counted too (same reason the edge computation below
        # recomputes cluster_ids after this loop instead of reusing it).
        seen_slugs: dict[str, int] = {}
        cluster_dicts = []
        for cid in cluster_ids:
            slug = _slugify(cluster_names[cid])
            if slug in seen_slugs:
                # Merge: reassign this cluster's label to the first occurrence
                labels[labels == cid] = seen_slugs[slug]
                continue
            seen_slugs[slug] = cid
            match = (identity_matches or {}).get(int(cid))
            cluster_dicts.append(
                {
                    "cluster_slug": slug,
                    "cluster_name": cluster_names[cid],
                    "stable_id": (
                        match["stable_id"] if match
                        else (str(uuid.uuid4()) if identity_on else None)
                    ),
                    "name_carried": bool(match),
                    "_cid": int(cid),  # dropped before save_clusters below
                }
            )

        if probabilities is not None:
            for c in cluster_dicts:
                member_mask = labels == c["_cid"]
                c["mean_membership_probability"] = (
                    round(float(probabilities[member_mask].mean()), 4)
                    if member_mask.any()
                    else None
                )
        else:
            for c in cluster_dicts:
                c["mean_membership_probability"] = None
        for c in cluster_dicts:
            del c["_cid"]

        slug_to_db_id = cluster_repo.save_clusters(user_id, run_id, cluster_dicts)

        # Save page-to-cluster associations
        page_cluster_pairs: list[tuple[int, int]] = []
        for i, page in enumerate(pages):
            label = int(labels[i])
            if label == -1:
                continue
            slug = _slugify(cluster_names[label])
            db_cluster_id = slug_to_db_id.get(slug)
            if db_cluster_id:
                page_cluster_pairs.append((page["db_id"], db_cluster_id))
        cluster_repo.save_page_clusters(page_cluster_pairs)

        # Compute and save inter-cluster similarity edges
        # Recompute cluster_ids after slug dedup may have merged some
        cluster_ids = sorted(set(labels[labels != -1]))
        if len(cluster_ids) >= 2:
            centroids = {}
            for cid in cluster_ids:
                mask = labels == cid
                if mask.any():
                    centroids[cid] = embeddings[mask].mean(axis=0)

            valid_ids = [cid for cid in cluster_ids if cid in centroids]
            edge_dicts: list[dict] = []
            for i, cid_a in enumerate(valid_ids):
                for cid_b in valid_ids[i + 1 :]:
                    sim = 1 - cosine_distances([centroids[cid_a]], [centroids[cid_b]])[0][0]
                    source_slug = _slugify(cluster_names[cid_a])
                    target_slug = _slugify(cluster_names[cid_b])
                    source_db_id = slug_to_db_id.get(source_slug)
                    target_db_id = slug_to_db_id.get(target_slug)
                    if source_db_id and target_db_id and sim >= SIMILARITY_THRESHOLD:
                        edge_dicts.append(
                            {
                                "source_cluster_id": source_db_id,
                                "target_cluster_id": target_db_id,
                                "weight": round(float(max(sim, 0)), 3),
                            }
                        )

            # Cap edges: keep top-3 most similar neighbors per cluster
            from collections import defaultdict

            edge_count: dict[int, int] = defaultdict(int)
            edge_dicts.sort(key=lambda e: e["weight"], reverse=True)
            filtered = []
            for e in edge_dicts:
                src, tgt = e["source_cluster_id"], e["target_cluster_id"]
                if (
                    edge_count[src] < MAX_EDGES_PER_CLUSTER
                    and edge_count[tgt] < MAX_EDGES_PER_CLUSTER
                ):
                    filtered.append(e)
                    edge_count[src] += 1
                    edge_count[tgt] += 1
            edge_dicts = filtered

            cluster_repo.save_edges(run_id, edge_dicts)
            logger.info(f"Saved {len(edge_dicts)} cluster edges to DB")

        logger.info(
            f"Saved {len(cluster_dicts)} clusters, "
            f"{len(page_cluster_pairs)} page-to-cluster associations to DB"
        )
        # Every stable_id actually persisted this run (minted + carried),
        # post slug-merge dedup -- cluster_dicts is one entry per written
        # cluster row by construction (the merge loop above `continue`s
        # past slug duplicates before appending). Empty when identity is
        # off (every "stable_id" is None then).
        stable_ids_written = [c["stable_id"] for c in cluster_dicts if c.get("stable_id")]
        return {"slug_to_db_id": slug_to_db_id, "stable_ids": stable_ids_written}

    # ── Featured singletons (starfield outliers) ─────────────────────────

    def _write_featured_singletons_to_db(
        self,
        user_id: int,
        run_id: int,
        featured: list[tuple[int, float]],
        pages: list[dict],
    ) -> None:
        """Persist top-N HDBSCAN-noise pages as featured singletons.

        These bypass the clusters table entirely -- they live in the
        ``featured_singletons`` table with their HDBSCAN outlier_score so the
        graph layer can render them as starfield outliers (page-title labels,
        lighter LOD) distinct from real clusters. Selection is by
        ``_select_featured_singletons``; persistence here is a thin pass-
        through to ``featured_repo.insert_featured_singletons``.
        """
        if not featured:
            return
        from backend.db.featured_repo import insert_featured_singletons

        rows = [
            {
                "user_id": user_id,
                "page_id": pages[idx]["db_id"],
                "recluster_run": run_id,
                "outlier_score": score,
            }
            for idx, score in featured
        ]
        n_inserted = insert_featured_singletons(rows)
        logger.info(
            f"Saved {n_inserted} featured singletons to DB "
            f"(out of {len(featured)} selected)"
        )
