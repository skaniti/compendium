"""Shelf canonicaliser: pure logic (no DB, no network) and flag-off entry points."""

from types import SimpleNamespace

import numpy as np
import pytest

from backend.services import shelf_service as ss
from backend.services.shelf_service import (
    MemoryShelfStore,
    ShelfCanonicaliser,
    ShelfConfig,
    ShelfIndex,
    normalize_subtopic,
)

# Deterministic vocabulary: each string maps to a fixed 2-d vector at a chosen angle.
ANGLES = {
    "storage bins": 0.0,
    "bin storage": 10.0,  # cos(10deg)=0.985 -> attach
    "garage shelving": 40.0,  # cos(40deg)=0.766 vs 0 -> ask band
    "bread baking": 90.0,  # orthogonal -> create
}


def embed(texts):
    rows = []
    for t in texts:
        a = np.deg2rad(ANGLES[t])
        rows.append([np.cos(a), np.sin(a)])
    return np.array(rows)


def make(ask=None, store=None):
    store = store or MemoryShelfStore(user_id=1)
    cfg = ShelfConfig(attach=0.80, ask=0.65)
    return ShelfCanonicaliser(ShelfIndex(), embed, ask, cfg, store), store


def lab(sub, cat="home"):
    return {"subtopic": sub, "category": cat}


def test_normalize_subtopic():
    assert normalize_subtopic("  The Storage-Bins!! ") == "storage bins"
    assert normalize_subtopic("An  apple") == "apple"
    assert normalize_subtopic("a") == "a"
    assert normalize_subtopic("") == ""


def test_first_string_creates_titlecased_shelf():
    c, store = make()
    r = c.assign(1, lab("storage bins"))
    assert r.created and r.method == "create"
    shelf = store.shelves[r.shelf_id]
    assert shelf["name"] == "Storage Bins" and shelf["category"] == "home"
    assert shelf["n_pages"] == 1 and r.stable_id == shelf["stable_id"]
    assert len(store.shelves[r.shelf_id]["stable_id"]) == 36


def test_attach_at_or_above_threshold():
    c, store = make()
    a = c.assign(1, lab("storage bins"))
    b = c.assign(2, lab("bin storage"))
    assert b.method == "attach" and b.shelf_id == a.shelf_id and not b.created
    assert store.pages[2]["method"] == "attach"


def test_ask_band_follows_answer():
    seen = []

    def yes(sub, shelf):
        seen.append((sub, shelf))
        return True

    c, _ = make(ask=yes)
    a = c.assign(1, lab("storage bins"))
    b = c.assign(2, lab("garage shelving"))
    assert b.method == "ask" and b.shelf_id == a.shelf_id
    assert seen[0][0] == "garage shelving"
    assert seen[0][1]["name"] == "Storage Bins" and "example_titles" in seen[0][1]
    assert c.asked == 1

    c2, _ = make(ask=lambda s, sh: False)
    c2.assign(1, lab("storage bins"))
    d = c2.assign(2, lab("garage shelving"))
    assert d.created and d.method == "create"


def test_ask_error_or_missing_creates():
    def boom(s, sh):
        raise RuntimeError("down")

    for ask in (boom, None):
        c, _ = make(ask=ask)
        c.assign(1, lab("storage bins"))
        assert c.assign(2, lab("garage shelving")).created


def test_below_ask_never_asks():
    calls = []
    c, _ = make(ask=lambda s, sh: calls.append(s) or True)
    c.assign(1, lab("storage bins"))
    assert c.assign(2, lab("bread baking")).created
    assert calls == []


def test_memo_short_circuits_and_stable_ids_survive_reassign():
    c, store = make()
    first = c.assign(1, lab("storage bins"))
    n_embeds = []
    c.embed = lambda texts: n_embeds.append(texts) or embed(texts)
    again = c.assign(2, lab("The Storage Bins!"))
    assert again.method == "attach" and again.similarity == 1.0
    assert again.shelf_id == first.shelf_id and again.stable_id == first.stable_id
    assert n_embeds == []  # memoised strings are not even embedded
    assert len(store.shelves) == 1


def test_assign_many_embeds_once_and_sees_new_shelves():
    calls = []

    def counting(texts):
        calls.append(list(texts))
        return embed(texts)

    store = MemoryShelfStore()
    c = ShelfCanonicaliser(ShelfIndex(), counting, None, ShelfConfig(), store)
    res = c.assign_many(
        [
            (1, lab("storage bins")),
            (2, lab("bin storage")),
            (3, lab("bread baking")),
            (4, lab("storage bins")),
        ]
    )
    assert len(calls) == 1 and sorted(calls[0]) == sorted(
        ["storage bins", "bin storage", "bread baking"]
    )
    assert res[1].created and res[2].shelf_id == res[1].shelf_id
    assert res[3].created and res[4].shelf_id == res[1].shelf_id
    assert store.shelves[res[1].shelf_id]["n_pages"] == 3


def test_running_centroid_update():
    c, store = make()
    c.assign(1, lab("storage bins"))
    c.assign(2, lab("bin storage"))
    shelf = c.index.shelves()[0]
    a0, a10 = np.deg2rad(0), np.deg2rad(10)
    expect = np.array([np.cos(a0) + np.cos(a10), np.sin(a0) + np.sin(a10)])
    expect /= np.linalg.norm(expect)
    assert np.allclose(shelf["centroid"], expect)
    assert shelf["n_pages"] == 2
    assert np.allclose(store.shelves[shelf["id"]]["centroid"], expect)
    assert store.shelves[shelf["id"]]["n_pages"] == 2


def test_index_nearest_empty_and_many():
    idx = ShelfIndex()
    assert idx.nearest([1.0, 0.0]) == (None, 0.0)
    rng = np.random.default_rng(0)
    vecs = rng.normal(size=(100, 8))
    for i, v in enumerate(vecs):
        idx.add({"id": i + 1, "name": str(i), "category": "x", "centroid": v, "n_pages": 1})
    q = vecs[42] + 0.001
    shelf, cos = idx.nearest(q)
    assert shelf["id"] == 43 and cos > 0.999


def test_index_remove():
    idx = ShelfIndex()
    for i, v in enumerate([[1.0, 0.0], [0.0, 1.0]]):
        idx.add({"id": i + 1, "name": "n", "category": "x", "centroid": v})
    idx.remove(1)
    assert len(idx) == 1 and idx.nearest([1.0, 0.0])[0]["id"] == 2


def test_memory_store_mints_unique_uuid_strings():
    s = MemoryShelfStore()
    a = s.create_shelf("A", "x", [1.0], 0)
    b = s.create_shelf("B", "x", [1.0], 0)
    assert a["stable_id"] != b["stable_id"] and len(a["stable_id"]) == 36


def test_config_from_settings_defaults_and_overrides(monkeypatch):
    cfg = ShelfConfig.from_settings()
    assert (cfg.attach, cfg.ask, cfg.soft_cap) == (0.80, 0.65, 40)
    monkeypatch.setattr(ss, "settings", SimpleNamespace(shelf_soft_cap=12))
    assert ShelfConfig.from_settings().soft_cap == 12


# ── exclusions (DB layer faked) ──────────────────────────────────────────


@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setattr(ss, "settings", SimpleNamespace(label_first_enabled=True))


def test_excluded_labels_never_shelved(flag_on, monkeypatch):
    labels = {
        1: {"subtopic": "storage bins", "category": "home", "knowledge_value": "high"},
        2: {"subtopic": "bin storage", "category": "home", "knowledge_value": "exclude"},
        3: {"subtopic": "bread baking", "category": "food", "content_kind": "search_results"},
        4: {"subtopic": "bread baking", "category": "food", "content_kind": "article"},
        5: {"subtopic": "storage bins", "category": "home", "knowledge_value": "low"},
    }
    store = MemoryShelfStore(user_id=1)
    monkeypatch.setattr(ss, "_get_labels", lambda ids: {i: labels[i] for i in ids if i in labels})
    monkeypatch.setattr("backend.db.shelf_repo.get_shelf_pages", lambda uid: {5: 99})
    monkeypatch.setattr(
        ss,
        "_build_canonicaliser",
        lambda uid: ShelfCanonicaliser(ShelfIndex(), embed, None, ShelfConfig(), store),
    )
    res = ss.assign_new_labels(1, [1, 2, 3, 4, 5])
    assert sorted(res) == [1, 4]  # 2 excluded value, 3 excluded kind, 5 already shelved
    assert sorted(store.pages) == [1, 4]


def test_missing_label_repo_is_nothing_to_do(flag_on, monkeypatch):
    import builtins

    real = builtins.__import__

    def fake(name, *a, **k):
        if name == "backend.db" and a and a[2] and "page_label_repo" in a[2]:
            raise ImportError("no labels branch")
        return real(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake)
    assert ss._get_labels([1]) == {}


# ── flag off: nothing is touched ─────────────────────────────────────────


def test_flag_off_entry_points_are_noops(monkeypatch):
    assert getattr(ss.settings, "label_first_enabled", False) is False

    def boom(*a, **k):
        raise AssertionError("must not be called with the flag off")

    monkeypatch.setattr(ss, "_get_labels", boom)
    monkeypatch.setattr(ss, "_build_canonicaliser", boom)
    monkeypatch.setattr("backend.services.text_embedder.embed_texts", boom)
    monkeypatch.setattr("backend.db.shelf_repo.get_shelf_pages", boom)
    monkeypatch.setattr("backend.db.shelf_repo.get_shelves", boom)
    monkeypatch.setattr(ss, "_complete_blocking", boom)
    assert ss.assign_new_labels(1, [1, 2]) == {}
    assert ss.assign_all_unshelved(1) == {}


# ── LLM callables are fail-open ──────────────────────────────────────────


def test_same_shelf_asker_yes_no_and_failure(monkeypatch):
    shelf = {"name": "Storage Bins", "category": "home", "example_titles": ["Synthetic page A"]}
    asker = ss.SameShelfAsker()
    prompts = []

    def fake(prompt):
        prompts.append(prompt)
        return "Yes.", 0.002

    monkeypatch.setattr(ss, "_complete_blocking", fake)
    assert asker("garage shelving", shelf) is True
    assert "Storage Bins" in prompts[0] and "Synthetic page A" in prompts[0]
    assert asker.cost_usd == pytest.approx(0.002)
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: ("No", 0.0))
    assert asker("garage shelving", shelf) is False

    def boom(p):
        raise RuntimeError("api down")

    monkeypatch.setattr(ss, "_complete_blocking", boom)
    assert asker("garage shelving", shelf) is False
    assert ss.ask_same_shelf("x", shelf) is False


def test_merge_asker_and_split_namer_fail_open(monkeypatch):
    a = {"name": "A", "category": "home", "example_titles": []}
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: ("yes", 0.0))
    assert ss.MergeAsker()(a, a) is True
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: ('"Garage Racks."\nextra', 0.0))
    assert ss.SplitNamer()(a, ["x"]) == "Garage Racks"

    def boom(p):
        raise RuntimeError

    monkeypatch.setattr(ss, "_complete_blocking", boom)
    assert ss.MergeAsker()(a, a) is False
    assert ss.SplitNamer()(a, ["x"]) is None


def test_shelf_model_call_has_a_timeout(monkeypatch):
    """A hung model call must end in the asker's fail-open path, not hang the hook."""
    import asyncio

    from backend.services import llm_service

    class Hung:
        async def complete(self, *a, **k):
            await asyncio.sleep(10)

    monkeypatch.setattr(llm_service, "LLMService", Hung)
    monkeypatch.setattr(ss, "LLM_TIMEOUT_S", 0.05)
    asker = ss.SameShelfAsker()
    assert asker("a subtopic", {"name": "S", "category": "c", "example_titles": []}) is False


# ── cost of the model asks is recorded as a cost event ────────────────────


def _completion(text, cost, tin, tout):
    out = ss._Completion((text, cost))
    out.input_tokens, out.output_tokens = tin, tout
    return out


def _ask_world(monkeypatch):
    """Flag on; two stored labels, the second lands in the ask band; events captured."""
    monkeypatch.setattr(
        ss, "settings", SimpleNamespace(label_first_enabled=True, label_model="m-x")
    )
    labels = {1: lab("storage bins"), 2: lab("garage shelving")}
    monkeypatch.setattr(ss, "_get_labels", lambda ids: {i: labels[i] for i in ids if i in labels})
    monkeypatch.setattr("backend.db.shelf_repo.get_shelf_pages", lambda uid: {})
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: _completion("yes", 0.002, 120, 3))
    canon = ShelfCanonicaliser(
        ShelfIndex(), embed, ss.SameShelfAsker(), ShelfConfig(), MemoryShelfStore(1)
    )
    monkeypatch.setattr(ss, "_build_canonicaliser", lambda uid: canon)
    events = []
    monkeypatch.setattr("backend.db.trends_repo.insert_cost_event", lambda **kw: events.append(kw))
    return events


def test_assign_new_labels_records_the_same_shelf_cost(monkeypatch):
    events = _ask_world(monkeypatch)
    res = ss.assign_new_labels(7, [1, 2])
    assert res[2].method == "ask"
    assert len(events) == 1
    ev = events[0]
    assert ev["user_id"] == 7 and ev["event_type"] == "shelf_same_check" and ev["model"] == "m-x"
    assert (ev["input_tokens"], ev["output_tokens"]) == (120, 3)
    assert ev["cost_usd"] == pytest.approx(0.002) and ev["metadata"] == {"calls": 1}


def test_no_ask_means_no_cost_event(monkeypatch):
    events = _ask_world(monkeypatch)
    ss.assign_new_labels(7, [1])
    assert events == []


def test_cost_event_failure_does_not_break_assignment(monkeypatch):
    _ask_world(monkeypatch)

    def boom(**kw):
        raise RuntimeError("db down")

    monkeypatch.setattr("backend.db.trends_repo.insert_cost_event", boom)
    assert ss.assign_new_labels(7, [1, 2])[2].method == "ask"


def test_assign_all_unshelved_records_the_cost(monkeypatch):
    events = _ask_world(monkeypatch)

    class Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def cursor(self):
            return self

        def execute(self, *a):
            pass

        def fetchall(self):
            return [(1,), (2,)]

    monkeypatch.setattr("backend.db.connection.get_conn", lambda: Cur())
    out = ss.assign_all_unshelved(7)
    assert out["assigned"] == 2 and out["asked"] == 1
    assert [e["event_type"] for e in events] == ["shelf_same_check"]


def test_weekly_maintenance_records_merge_and_split_name_cost(monkeypatch):
    events = []
    monkeypatch.setattr("backend.db.trends_repo.insert_cost_event", lambda **kw: events.append(kw))
    monkeypatch.setattr(
        ss, "settings", SimpleNamespace(label_first_enabled=True, label_model="m-x")
    )
    monkeypatch.setattr(ss, "_complete_blocking", lambda p: _completion("yes", 0.003, 50, 2))
    store = MemoryShelfStore(1)
    a = store.create_shelf("A", "home", [1.0, 0.0], 1)
    b = store.create_shelf("B", "home", [0.99, 0.01], 1)
    for sid, cid in ((a["id"], 1), (b["id"], 2)):
        store.upsert_shelf_page(sid, cid, f"s{cid}", "create", 1.0)
    res = ss.weekly_maintenance(
        1, store=store, embed=None, page_vectors=lambda ids: {}, config=ShelfConfig()
    )
    assert res["merged"] == 1
    assert [e["event_type"] for e in events] == ["shelf_merge_check"]
    assert events[0]["cost_usd"] == pytest.approx(0.003) and events[0]["user_id"] == 1
