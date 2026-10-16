"""Label-first clustering: clusters = shelves, names = shelf names, superclusters = categories.

Gated by ``settings.label_first_enabled`` (default off). ``ClusteringService.recluster_all``
hands over to :func:`recluster_label_first` right after it has claimed the run; with the flag
off this module is never imported, so the nightly recluster is the unchanged HDBSCAN path.

What a label-first run does (proposal #3 steps 3–5, #4, and the size band of #6):

1. Load and filter the active pages exactly as the HDBSCAN path does
   (``_load_all_pages`` → ``_filter_clusterable_pages``), so every eligibility rule
   (boilerplate, content kind, dedup, is_learning) still applies.
2. Read each page's label (``page_labels``) and shelf (``shelf_pages``); pages labelled
   ``knowledge_value == "exclude"`` never enter a cluster. Pages that are labelled but not
   shelved yet are shelved first (``shelf_service.assign_all_unshelved``).
3. A shelf with at least ``shelf_min_cluster_size`` member pages in this run's page set is a
   cluster; its name is the shelf name (no naming LLM call), its ``stable_id`` is the shelf's
   ``stable_id`` (carried through ``_write_clusters_to_db``'s identity path, so dq overrides
   keyed on it keep working run after run). Smaller shelves and unlabelled pages are noise
   for this run; the starfield picks featured singletons among them as before.
4. Embeddings are computed/cached as today and used only for cluster edges (centroid cosine,
   top-3) and the starfield, never for membership.
5. Superclusters are the taxonomy categories: one ``super_cluster_groups`` row per category
   present (source ``"taxonomy"``), every cluster of that category attached to it. A declared
   ``topic_interests`` keyword that names a category (by taxonomy id or display label) marks
   the group as declared for its interest tier.

The partition builder (:func:`build_partition`) is pure so the offline harness can score the
same logic on an export without a database.
"""

from __future__ import annotations

import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

logger = logging.getLogger(__name__)

CATEGORY_LABELS: dict[str, str] = {
    "science_nature": "Science & Nature",
    "health_medicine_psychology": "Health & Medicine",
    "technology_software_dev": "Software & Development",
    "ai_llm_tools": "AI Tools",
    "consumer_electronics_gadgets": "Electronics & Gadgets",
    "making_3d_printing": "Making & 3D Printing",
    "crafts_hobbies": "Crafts & Hobbies",
    "games_gaming": "Games",
    "film_tv": "Film & TV",
    "music_performers": "Music",
    "people_biography": "People",
    "literature_books_comics": "Books & Comics",
    "history_politics_geography": "History & Politics",
    "philosophy_humanities_arts": "Humanities & Arts",
    "food_cooking": "Food & Cooking",
    "shopping_products": "Shopping",
    "finance_banking_admin": "Finance & Admin",
    "education_coursework": "Education",
    "work_productivity_tools": "Productivity Tools",
    "personal_apps_accounts": "Apps & Accounts",
    "search_navigation": "Search",
    "social_media_forums": "Social & Forums",
    "ai_chat_transcripts": "AI Chats",
    "news_current_events": "News",
    "travel_places_local": "Travel & Places",
    "other_unclear": "Other",
}
"""Taxonomy id -> display label for the category supercluster rows."""

SUPERCLUSTER_SOURCE = "taxonomy"


@dataclass
class Partition:
    """Output of :func:`build_partition`: everything ``_write_clusters_to_db`` needs."""

    labels: np.ndarray
    cluster_names: dict[int, str]
    identity_matches: dict[int, dict]
    cluster_category: dict[int, str]
    cluster_shelf_id: dict[int, int]
    cluster_slugs: dict[int, str] = field(default_factory=dict)
    """Cluster id -> slug, only for clusters whose name-derived slug is shared or empty."""
    stats: dict = field(default_factory=dict)


def unique_slugs(cluster_names: dict[int, str], cluster_shelf_id: dict[int, int]) -> dict[int, str]:
    """Slug overrides that keep every cluster distinct.

    The cluster writer keys clusters by ``_slugify(name)`` and merges equal slugs,
    which would fuse two shelves named alike ("Storage bins", "storage-bins") and
    drop one stable id, and gives every non-Latin name the empty slug. Every
    cluster in a colliding (or empty) slug group gets ``<slug>_<shelf id>`` (or
    ``shelf_<shelf id>``); unique, non-empty slugs are left to the writer.
    """
    from backend.services.clustering_service import _slugify

    base = {cid: _slugify(name) for cid, name in cluster_names.items()}
    counts: dict[str, int] = {}
    for slug in base.values():
        counts[slug] = counts.get(slug, 0) + 1
    out: dict[int, str] = {}
    taken = {slug for slug, n in counts.items() if n == 1 and slug}
    for cid in sorted(base):
        if base[cid] and counts[base[cid]] == 1:
            continue
        shelf = cluster_shelf_id[cid]
        slug = f"{base[cid]}_{shelf}" if base[cid] else f"shelf_{shelf}"
        while slug in taken:
            slug += "_x"
        taken.add(slug)
        out[cid] = slug
    return out


def build_partition(
    pages: list[dict],
    labels_by_cid: dict[int, dict],
    shelf_of: dict[int, int],
    shelves: dict[int, dict],
    min_cluster_size: int,
    excluded_kinds: frozenset[str] | set[str] = frozenset(),
) -> Partition:
    """Group ``pages`` by shelf; shelves with >= ``min_cluster_size`` members are clusters.

    ``labels_by_cid``: page_content_id -> label dict (needs ``knowledge_value``,
    ``content_kind``, ``category``). ``shelf_of``: page_content_id -> shelf id.
    ``shelves``: shelf id -> dict with ``name``, ``stable_id``, ``category``.
    Pages without a label, labelled ``exclude``, of an excluded content kind, or on a shelf
    below the size band are noise (-1). Cluster ids are dense 0..k-1 in order of first
    appearance; the cluster's category is the majority label category of its members (the
    shelf's own category breaks ties).
    """
    n = len(pages)
    labels = np.full(n, -1, dtype=int)
    members: dict[int, list[int]] = defaultdict(list)
    stats = Counter()
    for i, page in enumerate(pages):
        cid = page.get("page_content_id")
        label = labels_by_cid.get(cid) if cid is not None else None
        if label is None:
            stats["unlabelled"] += 1
            continue
        if label.get("knowledge_value") == "exclude":
            stats["excluded_value"] += 1
            continue
        if label.get("content_kind") in excluded_kinds:
            stats["excluded_kind"] += 1
            continue
        shelf_id = shelf_of.get(cid)
        if shelf_id is None or shelf_id not in shelves:
            stats["unshelved"] += 1
            continue
        members[shelf_id].append(i)

    cluster_names: dict[int, str] = {}
    identity_matches: dict[int, dict] = {}
    cluster_category: dict[int, str] = {}
    cluster_shelf_id: dict[int, int] = {}
    next_id = 0
    for shelf_id, idxs in members.items():
        if len(idxs) < min_cluster_size:
            stats["below_min_size"] += len(idxs)
            stats["small_shelves"] += 1
            continue
        shelf = shelves[shelf_id]
        for i in idxs:
            labels[i] = next_id
        cluster_names[next_id] = shelf["name"]
        identity_matches[next_id] = {
            "stable_id": str(shelf["stable_id"]),
            "name": shelf["name"],
            "jaccard": 1.0,
        }
        cats = Counter(
            labels_by_cid[pages[i]["page_content_id"]].get("category") or shelf.get("category")
            for i in idxs
        )
        top = cats.most_common()
        best = top[0][0]
        if len(top) > 1 and top[0][1] == top[1][1] and shelf.get("category") in cats:
            best = shelf["category"]
        cluster_category[next_id] = best or "other_unclear"
        cluster_shelf_id[next_id] = shelf_id
        next_id += 1

    cluster_slugs = unique_slugs(cluster_names, cluster_shelf_id)
    stats["clusters"] = next_id
    stats["clustered_pages"] = int((labels != -1).sum())
    stats["noise"] = int((labels == -1).sum())
    return Partition(
        labels=labels,
        cluster_names=cluster_names,
        identity_matches=identity_matches,
        cluster_category=cluster_category,
        cluster_shelf_id=cluster_shelf_id,
        cluster_slugs=cluster_slugs,
        stats=dict(stats),
    )


def category_groups(
    labels: np.ndarray,
    cluster_category: dict[int, str],
) -> dict[str, list[int]]:
    """category id -> cluster ids present in the final ``labels``."""
    present = {int(c) for c in labels if c != -1}
    groups: dict[str, list[int]] = defaultdict(list)
    for cid in sorted(present):
        groups[cluster_category.get(cid, "other_unclear")].append(cid)
    return dict(groups)


def _declared_keyword(category: str, topic_interests: list[str]) -> str | None:
    """The owner's declared keyword that names this category, if any."""
    wanted = {category.lower(), CATEGORY_LABELS.get(category, "").lower()}
    wanted.discard("")
    for kw in topic_interests:
        if isinstance(kw, str) and kw.strip().lower() in wanted:
            return kw
    return None


def assign_category_superclusters(
    user_id: int,
    run_id: int,
    labels: np.ndarray,
    cluster_names: dict[int, str],
    cluster_category: dict[int, str],
    pages: list[dict],
    slug_to_db_id: dict[str, int],
    slug_overrides: dict[int, str] | None = None,
) -> dict:
    """Persist one supercluster group per category and attach its clusters.

    Writes ``super_cluster_groups`` (source ``taxonomy``), ``clusters.group_id`` and the
    display label into ``clusters.super_cluster`` — the same columns the hybrid path fills,
    so the graph layout and ``/api/topics`` read it unchanged. No LLM call.
    """
    from backend.db import auth_repo, cluster_repo, page_repo
    from backend.services import supercluster_discovery as sd
    from backend.services.clustering_service import _slugify
    from backend.services.super_cluster_service import _evidence_for

    groups_by_cat = category_groups(labels, cluster_category)
    if not groups_by_cat:
        return {"groups": 0, "declared": 0}

    prefs = auth_repo.get_preferences(user_id) or {}
    topic_interests = prefs.get("topic_interests", []) or []
    clustered_page_ids = [pages[i]["db_id"] for i in range(len(pages)) if labels[i] != -1]
    history = page_repo.get_visit_history(user_id, clustered_page_ids)

    group_rows: list[dict] = []
    members_by_index: dict[int, list[int]] = {}
    for g, (category, member_cids) in enumerate(sorted(groups_by_cat.items())):
        evidence, page_count = _evidence_for(member_cids, labels, pages, history)
        keyword = _declared_keyword(category, topic_interests)
        group_rows.append(
            {
                "group_index": g,
                "label": CATEGORY_LABELS.get(category, category),
                "source": SUPERCLUSTER_SOURCE,
                "topic": keyword or category,
                "topic_similarity": 1.0 if keyword else None,
                "interest_tier": sd.interest_tier(
                    evidence, n_pages=page_count, declared=keyword is not None
                ),
                "evidence": evidence,
                "member_count": len(member_cids),
                "page_count": page_count,
                "split_proposal": None,
            }
        )
        members_by_index[g] = member_cids

    index_to_db = cluster_repo.save_super_cluster_groups(user_id, run_id, group_rows)
    group_assignments: dict[int, int | None] = {}
    label_assignments: dict[int, str | None] = {}
    for g, member_cids in members_by_index.items():
        db_group = index_to_db.get(g)
        for cid in member_cids:
            slug = (slug_overrides or {}).get(cid) or _slugify(cluster_names[cid])
            db_cluster = slug_to_db_id.get(slug)
            if db_cluster is None:
                continue
            group_assignments[db_cluster] = db_group
            label_assignments[db_cluster] = group_rows[g]["label"]
    cluster_repo.update_cluster_groups(user_id, group_assignments)
    cluster_repo.update_super_clusters(user_id, label_assignments)
    declared = sum(1 for r in group_rows if r["topic_similarity"] is not None)
    logger.info(
        "label-first superclusters: %d category groups (%d declared) for user %s run %s",
        len(group_rows),
        declared,
        user_id,
        run_id,
    )
    return {"groups": len(group_rows), "declared": declared}


async def recluster_label_first(svc, user_id: int, run_id: int, t0: float) -> dict:
    """The label-first recluster; called by ``ClusteringService.recluster_all`` when the flag is on.

    ``svc`` is the ``ClusteringService`` instance; the run row ``run_id`` is already claimed.
    """
    from backend.config.settings import settings
    from backend.db import page_label_repo, recluster_repo, shelf_repo
    from backend.services import shelf_service
    from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS

    try:
        all_pages = svc._load_all_pages(user_id)
        pages, filter_stats = svc._filter_clusterable_pages(all_pages)
        logger.info(
            "label-first recluster: %d active -> %d clusterable pages for user %s",
            len(all_pages),
            len(pages),
            user_id,
        )
        content_ids = sorted({p["page_content_id"] for p in pages if p.get("page_content_id")})
        labels_by_cid = page_label_repo.get_labels(content_ids)

        # Catch up: labelled pages that never reached a shelf (ingest-time failure, backfill).
        try:
            catchup = shelf_service.assign_all_unshelved(user_id)
            if catchup:
                logger.info("label-first: shelved %d pending page(s)", len(catchup))
        except Exception:
            logger.exception("label-first: assign_all_unshelved failed (continuing)")

        shelf_of = shelf_repo.get_shelf_pages(user_id)
        shelves = {s["id"]: s for s in shelf_repo.get_shelves(user_id)}
        partition = build_partition(
            pages,
            labels_by_cid,
            shelf_of,
            shelves,
            settings.shelf_min_cluster_size,
            excluded_kinds=EXCLUDED_CONTENT_KINDS,
        )
        labels = partition.labels
        cluster_names = partition.cluster_names
        logger.info("label-first partition: %s", partition.stats)

        if not cluster_names:
            logger.warning("label-first: no shelf reaches the size band -- empty run")
            recluster_repo.complete_run(
                run_id,
                cluster_count=0,
                noise_count=len(pages),
                naming_cost=0.0,
                elapsed_seconds=round(time.perf_counter() - t0, 2),
            )
            return {
                "cluster_count": 0,
                "featured_singleton_count": 0,
                "noise_count": len(pages),
                "naming_cost": 0.0,
                "elapsed_seconds": round(time.perf_counter() - t0, 2),
                "filter_stats": filter_stats,
                "label_first": partition.stats,
            }

        embeddings = svc._compute_embeddings(pages)
        noise_count = int((labels == -1).sum())

        outlier_scores = svc._compute_outlier_scores_from_centroids(labels, embeddings)
        featured = svc._select_featured_singletons(
            labels,
            outlier_scores,
            embeddings,
            n_real_clusters=len(cluster_names),
            density_pct=settings.featured_singletons_visible_pct,
        )

        write_result = svc._write_clusters_to_db(
            user_id,
            run_id,
            labels,
            cluster_names,
            pages,
            embeddings,
            probabilities=None,
            identity_matches=partition.identity_matches,
            slug_overrides=partition.cluster_slugs,
        )
        slug_to_db_id = write_result["slug_to_db_id"]
        written_stable_ids = write_result["stable_ids"]
        cluster_ids = sorted({int(c) for c in labels if c != -1})

        svc._write_featured_singletons_to_db(user_id, run_id, featured, pages)

        sc = assign_category_superclusters(
            user_id,
            run_id,
            labels,
            cluster_names,
            partition.cluster_category,
            pages,
            slug_to_db_id,
            slug_overrides=partition.cluster_slugs,
        )

        elapsed = time.perf_counter() - t0
        recluster_repo.complete_run(
            run_id,
            cluster_count=len(cluster_ids),
            noise_count=noise_count,
            naming_cost=0.0,
            elapsed_seconds=round(elapsed, 2),
        )
        recluster_repo.cleanup_old_runs(user_id, keep_latest=3)
        logger.info(
            "label-first recluster complete: %d clusters, %d featured singletons, "
            "%d noise, %d category groups, %.1fs",
            len(cluster_ids),
            len(featured),
            noise_count,
            sc["groups"],
            elapsed,
        )

        graph_node_count = graph_edge_count = 0
        try:
            from backend.services.graph_builder import build_graph_from_db
            from backend.services.graph_service import save_graph as _save_graph

            _graph = build_graph_from_db(user_id)
            _save_graph(_graph, user_id)
            graph_node_count = len(_graph.nodes)
            graph_edge_count = len(_graph.edges)
        except Exception:
            logger.exception(
                "graph_cache rebuild failed for user %s run %s (recluster succeeded)",
                user_id,
                run_id,
            )

        try:
            from backend.db import dq_recommendations_repo

            dq_recommendations_repo.resolve_stale_cluster_recs(user_id, written_stable_ids)
        except Exception:
            logger.exception("dq stale-cluster expiry failed for user %s run %s", user_id, run_id)

        from backend.services.clustering_service import _maybe_enqueue_dq

        _maybe_enqueue_dq(user_id)

        return {
            "cluster_count": len(cluster_ids),
            "featured_singleton_count": len(featured),
            "noise_count": noise_count,
            "naming_cost": 0.0,
            "elapsed_seconds": round(elapsed, 2),
            "filter_stats": filter_stats,
            "graph_nodes": graph_node_count,
            "graph_edges": graph_edge_count,
            "label_first": {**partition.stats, "superclusters": sc},
        }
    except Exception:
        recluster_repo.fail_run(run_id)
        raise
