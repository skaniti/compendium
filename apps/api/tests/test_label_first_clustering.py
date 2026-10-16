"""Label-first clustering (``backend/services/label_first_clustering.py``).

Pure-logic tests for the partition builder and category superclusters, an end-to-end run
with every repository and service faked, and the flag-off proof: with
``label_first_enabled`` off, ``recluster_all`` never imports the label-first module.
"""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest

from backend.config.settings import settings
from backend.services import label_first_clustering as lf
from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS, ClusteringService


def _page(i, cid):
    return {
        "db_id": i,
        "page_content_id": cid,
        "url": f"https://alpha.example/p{i}",
        "title": f"Synthetic page {i}",
        "domain": "alpha.example",
        "summary": "s",
        "full_content": {},
    }


def _label(
    category="science_nature", subtopic="synthetic shelf", kv="keep", kind="article_reference"
):
    return {
        "category": category,
        "subtopic": subtopic,
        "knowledge_value": kv,
        "content_kind": kind,
    }


SHELVES = {
    10: {
        "id": 10,
        "stable_id": "00000000-0000-0000-0000-00000000000a",
        "name": "Synthetic sharks",
        "category": "science_nature",
    },
    11: {
        "id": 11,
        "stable_id": "00000000-0000-0000-0000-00000000000b",
        "name": "Synthetic routers",
        "category": "technology_software_dev",
    },
    12: {
        "id": 12,
        "stable_id": "00000000-0000-0000-0000-00000000000c",
        "name": "Synthetic tiny shelf",
        "category": "games_gaming",
    },
}


def _fixture():
    """7 pages: 3 on shelf 10, 3 on shelf 11, 1 on the tiny shelf 12, plus noise cases."""
    pages = [_page(i, 100 + i) for i in range(1, 12)]
    labels = {
        101: _label(),
        102: _label(),
        103: _label(category="health_medicine_psychology"),
        104: _label("technology_software_dev"),
        105: _label("technology_software_dev"),
        106: _label("technology_software_dev"),
        107: _label("games_gaming"),
        108: _label(kv="exclude"),  # excluded value
        109: _label(kind="auth_login"),  # excluded kind
        110: _label(),  # labelled, no shelf
        # 111: unlabelled
    }
    shelf_of = {101: 10, 102: 10, 103: 10, 104: 11, 105: 11, 106: 11, 107: 12, 108: 10, 109: 11}
    return pages, labels, shelf_of


def test_build_partition_groups_by_shelf_with_size_band():
    pages, labels, shelf_of = _fixture()
    part = lf.build_partition(pages, labels, shelf_of, SHELVES, 3, EXCLUDED_CONTENT_KINDS)
    assert list(part.labels) == [0, 0, 0, 1, 1, 1, -1, -1, -1, -1, -1]
    assert part.cluster_names == {0: "Synthetic sharks", 1: "Synthetic routers"}
    assert part.identity_matches[0]["stable_id"] == SHELVES[10]["stable_id"]
    assert part.identity_matches[1]["name"] == "Synthetic routers"
    assert part.cluster_category == {0: "science_nature", 1: "technology_software_dev"}
    assert part.cluster_shelf_id == {0: 10, 1: 11}
    assert part.stats == {
        "unlabelled": 1,
        "excluded_value": 1,
        "excluded_kind": 1,
        "unshelved": 1,
        "below_min_size": 1,
        "small_shelves": 1,
        "clusters": 2,
        "clustered_pages": 6,
        "noise": 5,
    }


def test_build_partition_min_size_one_keeps_tiny_shelf_and_category_tiebreak():
    pages, labels, shelf_of = _fixture()
    labels[103] = _label(category="health_medicine_psychology")
    labels[102] = _label(category="health_medicine_psychology")
    # shelf 10 now has 1 science + 2 health members -> majority health
    part = lf.build_partition(pages, labels, shelf_of, SHELVES, 1, EXCLUDED_CONTENT_KINDS)
    assert part.cluster_category[0] == "health_medicine_psychology"
    assert part.stats["clusters"] == 3
    # exact tie (1 vs 1) falls back to the shelf's own category when it is among them
    pages2 = pages[:2]
    labels2 = {101: _label(), 102: _label(category="health_medicine_psychology")}
    part2 = lf.build_partition(pages2, labels2, shelf_of, SHELVES, 1, EXCLUDED_CONTENT_KINDS)
    assert part2.cluster_category[0] == "science_nature"


def test_category_groups_and_declared_keyword():
    labels = np.array([0, 0, 1, 2, -1])
    groups = lf.category_groups(
        labels, {0: "science_nature", 1: "science_nature", 2: "games_gaming"}
    )
    assert groups == {"science_nature": [0, 1], "games_gaming": [2]}
    assert (
        lf._declared_keyword("science_nature", ["Games", "science & nature"]) == "science & nature"
    )
    assert lf._declared_keyword("science_nature", ["science_nature"]) == "science_nature"
    assert lf._declared_keyword("science_nature", ["sharks"]) is None


def test_assign_category_superclusters_writes_one_group_per_category(monkeypatch):
    saved = {}

    def save_groups(user_id, run_id, groups):
        saved["groups"] = groups
        return {g["group_index"]: 500 + g["group_index"] for g in groups}

    cluster_repo = types.SimpleNamespace(
        save_super_cluster_groups=save_groups,
        update_cluster_groups=lambda uid, a: saved.setdefault("group_assignments", a),
        update_super_clusters=lambda uid, a: saved.setdefault("label_assignments", a),
    )
    auth_repo = types.SimpleNamespace(get_preferences=lambda uid: {"topic_interests": ["Games"]})
    page_repo = types.SimpleNamespace(get_visit_history=lambda uid, ids: {})
    monkeypatch.setattr("backend.db.cluster_repo", cluster_repo)
    monkeypatch.setattr("backend.db.auth_repo", auth_repo)
    monkeypatch.setattr("backend.db.page_repo", page_repo)
    monkeypatch.setitem(sys.modules, "backend.db.cluster_repo", cluster_repo)
    monkeypatch.setitem(sys.modules, "backend.db.auth_repo", auth_repo)
    monkeypatch.setitem(sys.modules, "backend.db.page_repo", page_repo)

    pages = [_page(i, 100 + i) for i in range(1, 7)]
    labels = np.array([0, 0, 1, 1, 2, -1])
    names = {0: "Synthetic sharks", 1: "Synthetic whales", 2: "Synthetic puzzles"}
    cats = {0: "science_nature", 1: "science_nature", 2: "games_gaming"}
    slug_to_db = {"synthetic_sharks": 1, "synthetic_whales": 2, "synthetic_puzzles": 3}
    out = lf.assign_category_superclusters(7, 42, labels, names, cats, pages, slug_to_db)
    assert out == {"groups": 2, "declared": 1}
    rows = {g["label"]: g for g in saved["groups"]}
    assert set(rows) == {"Science & Nature", "Games"}
    assert all(g["source"] == "taxonomy" for g in rows.values())
    assert rows["Games"]["topic"] == "Games" and rows["Games"]["topic_similarity"] == 1.0
    assert rows["Science & Nature"]["topic"] == "science_nature"
    assert (
        rows["Science & Nature"]["member_count"] == 2
        and rows["Science & Nature"]["page_count"] == 4
    )
    assert saved["group_assignments"] == {1: 501, 2: 501, 3: 500}  # groups sorted by category id
    assert saved["label_assignments"] == {1: "Science & Nature", 2: "Science & Nature", 3: "Games"}


# ── end-to-end with fakes ────────────────────────────────────────────────


@pytest.fixture
def fake_world(monkeypatch):
    """Fake repos/services so recluster_label_first runs without a DB or network."""
    pages, labels, shelf_of = _fixture()
    calls = {}
    page_label_repo = types.SimpleNamespace(
        get_labels=lambda cids: {c: labels[c] for c in cids if c in labels}
    )
    shelf_repo = types.SimpleNamespace(
        get_shelf_pages=lambda uid: shelf_of,
        get_shelves=lambda uid, status="active": list(SHELVES.values()),
    )
    shelf_service = types.SimpleNamespace(
        assign_all_unshelved=lambda uid: calls.setdefault("catchup", {})
    )
    recluster_repo = types.SimpleNamespace(
        complete_run=lambda run_id, **kw: calls.setdefault("complete", kw),
        fail_run=lambda run_id: calls.setdefault("failed", run_id),
        cleanup_old_runs=lambda uid, keep_latest=3: None,
        start_run_if_idle=lambda uid: 42,
    )
    dq_recs = types.SimpleNamespace(
        resolve_stale_cluster_recs=lambda uid, ids: calls.setdefault("stale", ids)
    )
    for name, mod in {
        "backend.db.page_label_repo": page_label_repo,
        "backend.db.shelf_repo": shelf_repo,
        "backend.services.shelf_service": shelf_service,
        "backend.db.recluster_repo": recluster_repo,
        "backend.db.dq_recommendations_repo": dq_recs,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)
    import backend.db as db_pkg
    import backend.services as svc_pkg

    monkeypatch.setattr(db_pkg, "page_label_repo", page_label_repo, raising=False)
    monkeypatch.setattr(db_pkg, "shelf_repo", shelf_repo, raising=False)
    monkeypatch.setattr(db_pkg, "recluster_repo", recluster_repo, raising=False)
    monkeypatch.setattr(db_pkg, "dq_recommendations_repo", dq_recs, raising=False)
    monkeypatch.setattr(svc_pkg, "shelf_service", shelf_service, raising=False)

    monkeypatch.setattr(settings, "label_first_enabled", True, raising=False)
    monkeypatch.setattr(settings, "shelf_min_cluster_size", 3, raising=False)
    monkeypatch.setattr(settings, "featured_singletons_visible_pct", 0.5)

    svc = ClusteringService(user_id=7)
    monkeypatch.setattr(svc, "_load_all_pages", lambda uid: pages)
    monkeypatch.setattr(
        svc, "_filter_clusterable_pages", lambda ps: (ps, {"total_output": len(ps)})
    )
    rng = np.random.default_rng(0)
    emb = rng.normal(size=(len(pages), 8))
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    monkeypatch.setattr(svc, "_compute_embeddings", lambda ps: emb)

    def write(
        uid,
        run_id,
        lbls,
        names,
        ps,
        e,
        probabilities=None,
        identity_matches=None,
        slug_overrides=None,
    ):
        calls["write"] = {"labels": lbls.copy(), "names": names, "identity": identity_matches}
        return {
            "slug_to_db_id": {"synthetic_sharks": 1, "synthetic_routers": 2},
            "stable_ids": [m["stable_id"] for m in identity_matches.values()],
        }

    monkeypatch.setattr(svc, "_write_clusters_to_db", write)
    monkeypatch.setattr(
        svc,
        "_write_featured_singletons_to_db",
        lambda uid, run_id, featured, ps: calls.setdefault("featured", featured),
    )
    monkeypatch.setattr(
        lf,
        "assign_category_superclusters",
        lambda *a, **k: calls.setdefault("sc", {"groups": 2, "declared": 0}),
    )
    monkeypatch.setattr(
        "backend.services.clustering_service._maybe_enqueue_dq",
        lambda uid: calls.setdefault("dq", uid),
    )
    graph = types.SimpleNamespace(nodes=[1, 2], edges=[1])
    monkeypatch.setitem(
        sys.modules,
        "backend.services.graph_builder",
        types.SimpleNamespace(build_graph_from_db=lambda uid: graph),
    )
    monkeypatch.setitem(
        sys.modules,
        "backend.services.graph_service",
        types.SimpleNamespace(save_graph=lambda g, uid: calls.setdefault("graph", g)),
    )
    return svc, calls


@pytest.mark.asyncio
async def test_recluster_label_first_end_to_end(fake_world):
    svc, calls = fake_world
    out = await lf.recluster_label_first(svc, 7, 42, 0.0)
    assert out["cluster_count"] == 2 and out["noise_count"] == 5 and out["naming_cost"] == 0.0
    assert (
        out["label_first"]["clusters"] == 2 and out["label_first"]["superclusters"]["groups"] == 2
    )
    assert calls["write"]["names"] == {0: "Synthetic sharks", 1: "Synthetic routers"}
    assert calls["write"]["identity"][0]["stable_id"] == SHELVES[10]["stable_id"]
    assert calls["complete"]["cluster_count"] == 2 and calls["complete"]["naming_cost"] == 0.0
    assert calls["stale"] == [SHELVES[10]["stable_id"], SHELVES[11]["stable_id"]]
    assert calls["dq"] == 7 and out["graph_nodes"] == 2
    assert "catchup" in calls
    assert all(idx in (6, 7, 8, 9, 10) for idx, _ in calls["featured"]), "featured are noise pages"


@pytest.mark.asyncio
async def test_recluster_label_first_fails_run_on_error(fake_world, monkeypatch):
    svc, calls = fake_world

    def boom(*a, **k):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(svc, "_write_clusters_to_db", boom)
    with pytest.raises(RuntimeError):
        await lf.recluster_label_first(svc, 7, 42, 0.0)
    assert calls["failed"] == 42


@pytest.mark.asyncio
async def test_recluster_label_first_empty_when_no_shelf_reaches_band(fake_world, monkeypatch):
    svc, calls = fake_world
    monkeypatch.setattr(settings, "shelf_min_cluster_size", 10, raising=False)
    out = await lf.recluster_label_first(svc, 7, 42, 0.0)
    assert out["cluster_count"] == 0 and "write" not in calls
    assert calls["complete"]["cluster_count"] == 0


# ── flag-off proof ───────────────────────────────────────────────────────


class _Stop(Exception):
    pass


@pytest.mark.asyncio
async def test_recluster_all_flag_off_never_touches_label_first(monkeypatch):
    sentinel = types.ModuleType("backend.services.label_first_clustering")

    async def never(*a, **k):
        raise AssertionError("label-first path must not run with the flag off")

    sentinel.recluster_label_first = never
    monkeypatch.setitem(sys.modules, "backend.services.label_first_clustering", sentinel)
    monkeypatch.setattr(settings, "label_first_enabled", False, raising=False)
    monkeypatch.setattr(
        "backend.services.clustering_service.recluster_repo.start_run_if_idle", lambda uid: 42
    )
    monkeypatch.setattr(
        "backend.services.clustering_service.recluster_repo.fail_run", lambda rid: None
    )
    svc = ClusteringService(user_id=7)

    def stop(uid):
        raise _Stop()

    monkeypatch.setattr(svc, "_load_all_pages", stop)
    with pytest.raises(_Stop):
        await svc.recluster_all()


@pytest.mark.asyncio
async def test_recluster_all_flag_on_hands_over(monkeypatch):
    sentinel = types.ModuleType("backend.services.label_first_clustering")
    seen = {}

    async def hand_over(svc, user_id, run_id, t0):
        seen.update(user_id=user_id, run_id=run_id)
        return {"cluster_count": 0}

    sentinel.recluster_label_first = hand_over
    monkeypatch.setitem(sys.modules, "backend.services.label_first_clustering", sentinel)
    monkeypatch.setattr(settings, "label_first_enabled", True, raising=False)
    monkeypatch.setattr(
        "backend.services.clustering_service.recluster_repo.start_run_if_idle", lambda uid: 42
    )
    svc = ClusteringService(user_id=7)
    monkeypatch.setattr(svc, "_load_all_pages", lambda uid: pytest.fail("HDBSCAN path ran"))
    assert await svc.recluster_all() == {"cluster_count": 0}
    assert seen == {"user_id": 7, "run_id": 42}


def test_no_new_api_routes_with_flag_off_or_on(monkeypatch):
    """Phase B adds no endpoints; the route table is the same whatever the flag says."""
    from backend.api.main import app

    routes = sorted(getattr(r, "path", "") for r in app.routes)
    monkeypatch.setattr(settings, "label_first_enabled", True, raising=False)
    assert sorted(getattr(r, "path", "") for r in app.routes) == routes
    assert not any("shelf" in p or "label" in p for p in routes)


# ── slug collisions ──────────────────────────────────────────────────────


def test_unique_slugs_separates_equal_and_empty_slugs():
    names = {
        0: "Storage bins",
        1: "storage-bins",
        2: "Whales",
        3: "\u9ce5\u985e",
        4: "\u9b5a\u985e",
    }
    shelf = {0: 10, 1: 11, 2: 12, 3: 13, 4: 14}
    out = lf.unique_slugs(names, shelf)
    assert out == {0: "storage_bins_10", 1: "storage_bins_11", 3: "shelf_13", 4: "shelf_14"}
    assert 2 not in out  # unique, non-empty: left to the writer
    assert len(set(out.values())) == len(out)


def test_unique_slugs_never_collides_with_a_plain_slug():
    names = {0: "Bins", 1: "bins", 2: "Bins 1"}  # "bins_1" would equal cluster 2's own slug
    out = lf.unique_slugs(names, {0: 1, 1: 2, 2: 3})
    plain = {2: "bins_1"}
    assert len({*out.values(), *plain.values()}) == 3


def test_unique_slugs_empty_when_no_collision():
    assert lf.unique_slugs({0: "A", 1: "B"}, {0: 1, 1: 2}) == {}


def test_build_partition_keeps_name_alike_shelves_as_separate_clusters():
    shelves = {
        1: {"name": "Storage bins", "stable_id": "sid-1", "category": "home"},
        2: {"name": "storage-bins", "stable_id": "sid-2", "category": "home"},
    }
    pages, labels, shelf_of = [], {}, {}
    for n in range(6):
        cid = 100 + n
        pages.append(_page(n, cid))
        labels[cid] = {"knowledge_value": "keep", "content_kind": None, "category": "home"}
        shelf_of[cid] = 1 if n < 3 else 2
    part = lf.build_partition(pages, labels, shelf_of, shelves, 3)
    assert part.stats["clusters"] == 2
    assert {m["stable_id"] for m in part.identity_matches.values()} == {"sid-1", "sid-2"}
    assert len(set(part.cluster_slugs.values())) == 2


def test_writer_keeps_distinct_clusters_with_slug_overrides(monkeypatch):
    """_write_clusters_to_db: equal names merge without overrides, stay apart with them."""
    from backend.services import clustering_service as cs

    def run(overrides):
        saved = {}
        monkeypatch.setattr(
            cs.cluster_repo,
            "save_clusters",
            lambda uid, rid, dicts: (
                saved.setdefault("c", dicts)
                and {d["cluster_slug"]: i + 1 for i, d in enumerate(dicts)}
            ),
        )
        monkeypatch.setattr(
            cs.cluster_repo, "save_page_clusters", lambda pairs: saved.setdefault("p", pairs)
        )
        monkeypatch.setattr(cs.cluster_repo, "save_edges", lambda *a, **k: None, raising=False)
        pages = [_page(i, 100 + i) for i in range(4)]
        labels = np.array([0, 0, 1, 1])
        emb = np.eye(4)
        svc = ClusteringService(user_id=7)
        svc._write_clusters_to_db(
            7, 42, labels, {0: "Same name", 1: "same-name"}, pages, emb, slug_overrides=overrides
        )
        return saved, labels

    merged, labels = run(None)
    assert len(merged["c"]) == 1 and set(labels.tolist()) == {0}
    saved, labels = run({0: "same_name_10", 1: "same_name_11"})
    assert [d["cluster_slug"] for d in saved["c"]] == ["same_name_10", "same_name_11"]
    assert set(labels.tolist()) == {0, 1}
    assert sorted(db for _, db in saved["p"]) == [1, 1, 2, 2]
