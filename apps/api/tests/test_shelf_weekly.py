"""weekly_maintenance: merge/split on the in-memory store with mocked asks (no DB, no network)."""

from types import SimpleNamespace

import numpy as np
import pytest

from backend.services import shelf_service as ss
from backend.services.shelf_service import MemoryShelfStore, ShelfConfig


@pytest.fixture(autouse=True)
def flag_on(monkeypatch):
    monkeypatch.setattr(ss, "settings", SimpleNamespace(label_first_enabled=True))


def unit(deg):
    a = np.deg2rad(deg)
    return np.array([np.cos(a), np.sin(a)])


def seed(store, name, deg, members, cat="home"):
    shelf = store.create_shelf(name, cat, unit(deg), len(members))
    for cid, sub in members:
        store.upsert_shelf_page(shelf["id"], cid, sub, "create", 1.0)
        store.set_shelf_string(sub, shelf["id"])
    return shelf


def run(store, **kw):
    kw.setdefault("config", ShelfConfig(merge_distance=0.15, soft_cap=4))
    kw.setdefault("store", store)
    kw.setdefault("ask_merge", lambda a, b: True)
    kw.setdefault("ask_split_name", lambda s, subs: None)
    kw.setdefault("embed", None)
    kw.setdefault("page_vectors", lambda ids: {})
    return ss.weekly_maintenance(1, **kw)


def test_merge_smaller_into_larger_and_idempotent():
    store = MemoryShelfStore(1)
    big = seed(store, "Big", 0, [(1, "s1"), (2, "s2"), (3, "s3")])
    small = seed(store, "Small", 10, [(4, "s4")])  # cos dist ~0.015
    far = seed(store, "Far", 90, [(5, "s5")])
    res = run(store)
    assert (res["merged"], res["split"], res["asked"]) == (1, 0, 1)
    assert store.shelves[small["id"]]["status"] == "merged"
    assert store.shelves[small["id"]]["merged_into"] == big["id"]
    assert store.pages[4]["shelf_id"] == big["id"] and store.pages[4]["method"] == "merge"
    assert store.strings["s4"] == big["id"]
    assert store.shelves[big["id"]]["n_pages"] == 4
    want = unit(0) * 3 + unit(10) * 1
    want /= np.linalg.norm(want)
    assert np.allclose(store.shelves[big["id"]]["centroid"], want)
    assert store.shelves[far["id"]]["status"] == "active"
    again = run(store)
    assert (again["merged"], again["split"]) == (0, 0)


def test_merge_requires_confirmation_and_fail_open():
    def boom(a, b):
        raise RuntimeError("down")

    for ask in (lambda a, b: False, boom):
        store = MemoryShelfStore(1)
        seed(store, "A", 0, [(1, "a")])
        seed(store, "B", 5, [(2, "b")])
        res = run(store, ask_merge=ask)
        assert res["merged"] == 0 and res["asked"] == 1
        assert len(store.list_shelves()) == 2


def test_merge_order_by_distance_and_skips_merged_this_pass():
    store = MemoryShelfStore(1)
    a = seed(store, "A", 0, [(1, "a1"), (2, "a2")])
    b = seed(store, "B", 6, [(3, "b1")])
    c = seed(store, "C", 12, [(4, "c1")])
    asked = []

    def ask(x, y):
        asked.append((x["name"], y["name"]))
        return True

    res = run(store, ask_merge=ask)
    # A-B and B-C nearly tie (0.0055), A-C is 0.022; a shelf folded away is
    # skipped for later pairs, the survivor absorbs the rest.
    assert res["merged"] == 2
    # whichever order the near-tie resolves, merged_into never chains
    survivor = store.list_shelves()
    assert len(survivor) == 1
    sid = survivor[0]["id"]
    for x in (a, b, c):
        if x["id"] != sid:
            assert store.shelves[x["id"]]["merged_into"] == sid
    assert survivor[0]["n_pages"] == 4
    assert all(p["shelf_id"] == sid for p in store.pages.values())


def _members(n, prefix):
    return [(i, f"{prefix}{i}") for i in range(n)]


def test_split_oversized_shelf_and_idempotent():
    store = MemoryShelfStore(1)
    members = [(i, f"left {i}") for i in range(1, 6)] + [(i, f"right {i}") for i in range(6, 9)]
    shelf = seed(store, "Synthetic storage bins", 45, members)
    vecs = {i: unit(0) + 0.01 * i for i in range(1, 6)} | {i: unit(90) for i in range(6, 9)}
    vecs.pop(5)  # one member lacks a vector -> stays with the larger half
    res = run(
        store,
        config=ShelfConfig(soft_cap=7),
        page_vectors=lambda ids: {i: vecs[i] for i in ids if i in vecs},
    )
    assert res["split"] == 1 and res["merged"] == 0
    assert store.shelves[shelf["id"]]["n_pages"] == 5
    left = {c for c in store.pages if store.pages[c]["shelf_id"] == shelf["id"]}
    assert left == {1, 2, 3, 4, 5}
    new = [s for s in store.list_shelves() if s["id"] != shelf["id"]][0]
    assert new["name"] == "Synthetic storage bins (part 2)" and new["category"] == "home"
    assert new["n_pages"] == 3 and new["stable_id"] != shelf["stable_id"]
    assert {store.pages[c]["method"] for c in range(1, 9)} == {"split"}
    assert np.allclose(new["centroid"], unit(45))  # no embedder -> parent centroid
    again = run(
        store,
        config=ShelfConfig(soft_cap=7),
        page_vectors=lambda ids: {i: vecs[i] for i in ids if i in vecs},
    )
    assert (again["split"], again["merged"]) == (0, 0)


def test_split_name_from_model_and_subtopic_centroids():
    store = MemoryShelfStore(1)
    members = [(i, f"left {i}") for i in range(1, 6)] + [(i, f"right {i}") for i in range(6, 9)]
    seed(store, "Synthetic bins", 45, members)
    vecs = {i: unit(0) for i in range(1, 6)} | {i: unit(90) for i in range(6, 9)}

    def embed(texts):
        return np.array([unit(0) if t.startswith("left") else unit(90) for t in texts])

    res = run(
        store,
        page_vectors=lambda ids: vecs,
        embed=embed,
        ask_split_name=lambda s, subs: "Synthetic racks",
    )
    assert res["split"] == 1
    new = [s for s in store.list_shelves() if s["name"] == "Synthetic racks"][0]
    assert np.allclose(new["centroid"], unit(90))
    old = [s for s in store.list_shelves() if s["name"] == "Synthetic bins"][0]
    assert np.allclose(old["centroid"], unit(0))


def test_split_halves_do_not_merge_back():
    store = MemoryShelfStore(1)
    one = seed(store, "One", 0, [(1, "a")])
    two = seed(store, "Two", 3, [(2, "b")])
    store.move_pages(one["id"], one["id"], "split")
    store.move_pages(two["id"], two["id"], "split")
    res = run(store)
    assert res["merged"] == 0 and res["asked"] == 0


def test_split_skipped_when_under_cap_or_no_vectors():
    store = MemoryShelfStore(1)
    seed(store, "Small", 0, _members(3, "x"))
    assert run(store)["split"] == 0
    store2 = MemoryShelfStore(1)
    seed(store2, "Big", 0, _members(9, "y"))
    assert run(store2)["split"] == 0  # no vectors at all -> nothing to cluster


def test_cost_collected_from_default_askers(monkeypatch):
    store = MemoryShelfStore(1)
    seed(store, "A", 0, [(1, "a")])
    seed(store, "B", 5, [(2, "b")])
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: ("yes", 0.003))
    res = ss.weekly_maintenance(
        1, config=ShelfConfig(), store=store, embed=None, page_vectors=lambda ids: {}
    )
    assert res["merged"] == 1 and res["cost_usd"] == pytest.approx(0.003)


def test_default_page_vectors_key_selection(monkeypatch):
    calls = []
    fake = SimpleNamespace(
        get_clustering_embeddings=lambda ids, key: calls.append(("c", key)) or {1: [1.0, 0.0]},
        get_embeddings_for_content_ids=lambda ids: calls.append(("e", None)) or {2: [0.0, 1.0]},
    )
    monkeypatch.setattr(
        "backend.db.embedding_repo.get_clustering_embeddings", fake.get_clustering_embeddings
    )
    monkeypatch.setattr(
        "backend.db.embedding_repo.get_embeddings_for_content_ids",
        fake.get_embeddings_for_content_ids,
    )
    monkeypatch.setattr(
        ss,
        "settings",
        SimpleNamespace(
            clustering_embedding_model="text-embedding-3-small", clustering_text_contract="ctv2"
        ),
    )
    assert list(ss._default_page_vectors([1])) == [1]
    monkeypatch.setattr(
        ss, "settings", SimpleNamespace(clustering_embedding_model="all-MiniLM-L6-v2")
    )
    assert list(ss._default_page_vectors([2])) == [2]
    assert calls == [("c", "text-embedding-3-small@ctv2"), ("e", None)]


def test_explicit_no_embedder_never_reaches_the_default_embedder(monkeypatch):
    """embed=None means "no embedder"; only omitting it selects the real one."""
    calls = []
    monkeypatch.setattr(ss, "_default_embed", lambda texts: calls.append(texts) or np.zeros((1, 2)))
    store = MemoryShelfStore(1)
    members = [(i, f"left {i}") for i in range(1, 4)] + [(i, f"right {i}") for i in range(4, 7)]
    seed(store, "Synthetic shelf", 45, members)
    vecs = {i: unit(0) for i in range(1, 4)} | {i: unit(90) for i in range(4, 7)}
    res = run(store, config=ShelfConfig(soft_cap=4), page_vectors=lambda ids: vecs, embed=None)
    assert res["split"] == 1
    assert calls == []


def test_omitted_embedder_selects_the_default(monkeypatch):
    calls = []

    def fake(texts):
        calls.append(list(texts))
        return np.array([unit(0) if t.startswith("left") else unit(90) for t in texts])

    monkeypatch.setattr(ss, "_default_embed", fake)
    store = MemoryShelfStore(1)
    members = [(i, f"left {i}") for i in range(1, 4)] + [(i, f"right {i}") for i in range(4, 7)]
    seed(store, "Synthetic shelf", 45, members)
    vecs = {i: unit(0) for i in range(1, 4)} | {i: unit(90) for i in range(4, 7)}
    res = ss.weekly_maintenance(
        1,
        config=ShelfConfig(soft_cap=4),
        store=store,
        ask_merge=lambda a, b: True,
        ask_split_name=lambda s, subs: None,
        page_vectors=lambda ids: vecs,
    )
    assert res["split"] == 1
    assert calls
