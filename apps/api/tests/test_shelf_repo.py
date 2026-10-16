"""shelf_repo round trips on the test database (synthetic data only)."""

import uuid

import pytest

from tests.test_page_repo_time_windows import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from datetime import UTC

from backend.db import content_repo, page_repo, shelf_repo, user_repo
from backend.db.connection import get_conn


@pytest.fixture(autouse=True)
def _clean():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                TRUNCATE shelf_strings, shelf_pages, shelves, graph_cache, cluster_edges,
                         page_clusters, clusters, recluster_runs, pages, page_content,
                         captures, users
                CASCADE
                """
        )
    yield


def _content(n):
    return [
        content_repo.get_or_create_content(f"https://alpha.example/p{i}")["id"] for i in range(n)
    ]


def _user():
    return user_repo.create_user("shelf@example.test", name="Shelf Tester")["id"]


def test_create_and_read_back_vector_and_stable_id():
    uid = _user()
    s = shelf_repo.create_shelf(uid, "Synthetic storage bins", "home", [0.5, -0.25, 0.125], "m", 2)
    assert uuid.UUID(s["stable_id"]) and s["status"] == "active" and s["n_pages"] == 2
    got = shelf_repo.get_shelf(s["id"])
    assert got["centroid"] == pytest.approx([0.5, -0.25, 0.125])
    assert got["stable_id"] == s["stable_id"]
    other = shelf_repo.create_shelf(uid, "Synthetic bread", "food", None)
    assert other["centroid"] is None and other["stable_id"] != s["stable_id"]
    assert [x["id"] for x in shelf_repo.get_shelves(uid)] == [s["id"], other["id"]]


def test_update_shelf_and_status_filter():
    uid = _user()
    a = shelf_repo.create_shelf(uid, "A shelf", "home", [1.0, 0.0])
    b = shelf_repo.create_shelf(uid, "B shelf", "home", [0.0, 1.0])
    shelf_repo.update_shelf(a["id"], name="A2", centroid=[0.0, 1.0], n_pages=5)
    shelf_repo.update_shelf(b["id"], status="merged", merged_into=a["id"])
    got = shelf_repo.get_shelf(a["id"])
    assert (got["name"], got["n_pages"], got["centroid"]) == ("A2", 5, [0.0, 1.0])
    assert [s["id"] for s in shelf_repo.get_shelves(uid)] == [a["id"]]
    assert [s["id"] for s in shelf_repo.get_shelves(uid, "merged")] == [b["id"]]
    assert len(shelf_repo.get_shelves(uid, None)) == 2
    with pytest.raises(ValueError):
        shelf_repo.update_shelf(a["id"], bogus=1)


def test_pages_strings_move_and_recount():
    uid = _user()
    c = _content(3)
    a = shelf_repo.create_shelf(uid, "A shelf", "home", [1.0, 0.0])
    b = shelf_repo.create_shelf(uid, "B shelf", "home", [0.0, 1.0])
    for cid in c[:2]:
        shelf_repo.upsert_shelf_page(a["id"], cid, uid, "sub a", "create", 1.0)
    shelf_repo.upsert_shelf_page(b["id"], c[2], uid, "sub b", "attach", 0.9)
    shelf_repo.upsert_shelf_page(a["id"], c[2], uid, "sub b", "ask", 0.7)  # upsert moves
    assert shelf_repo.get_shelf_pages(uid) == {c[0]: a["id"], c[1]: a["id"], c[2]: a["id"]}
    shelf_repo.set_shelf_string(uid, "sub b", b["id"])
    shelf_repo.set_shelf_string(uid, "sub b", b["id"])  # idempotent
    assert shelf_repo.get_shelf_string(uid, "sub b") == b["id"]
    assert shelf_repo.get_shelf_string(uid, "nope") is None

    assert shelf_repo.move_shelf_pages(a["id"], b["id"], "split", [c[0]]) == 1
    assert shelf_repo.get_pages_for_shelf(b["id"]) == [c[0]]
    assert shelf_repo.move_shelf_pages(a["id"], b["id"], "merge") == 2
    assert shelf_repo.repoint_shelf_strings(b["id"], a["id"]) == 1
    shelf_repo.recount_shelves(uid)
    assert shelf_repo.get_shelf(b["id"])["n_pages"] == 3
    assert shelf_repo.get_shelf(a["id"])["n_pages"] == 0
    assert shelf_repo.has_page_method(b["id"], "merge")
    assert shelf_repo.has_page_method(b["id"], "split")  # c[0] was moved as a split
    assert not shelf_repo.has_page_method(a["id"], "split")
    assert set(shelf_repo.get_page_subtopics(b["id"]).values()) == {"sub a", "sub b"}


def test_example_titles_and_cascade():
    uid = _user()
    c = _content(2)
    from tests.test_page_repo_time_windows import _make_capture

    cap = _make_capture(uid)
    from datetime import datetime, timezone

    page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": f"https://alpha.example/p{i}",
                "title": f"Synthetic page {i}",
                "domain": "alpha.example",
                "visited_at": datetime(2026, 3, 15, 10, i, tzinfo=UTC),
            }
            for i in range(2)
        ],
    )
    with get_conn() as conn, conn.cursor() as cur:
        for i, cid in enumerate(c):
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE url = %s",
                (cid, f"https://alpha.example/p{i}"),
            )
    s = shelf_repo.create_shelf(uid, "A shelf", "home", [1.0])
    for cid in c:
        shelf_repo.upsert_shelf_page(s["id"], cid, uid, "x", "create", 1.0)
    assert shelf_repo.get_example_titles(s["id"], 3) == ["Synthetic page 1", "Synthetic page 0"]
    assert len(shelf_repo.get_example_titles(s["id"], 1)) == 1


def test_weekly_maintenance_on_db_store_merges(monkeypatch):
    from types import SimpleNamespace

    import numpy as np

    from backend.services import shelf_service as ss

    monkeypatch.setattr(ss, "settings", SimpleNamespace(label_first_enabled=True))
    uid = _user()
    c = _content(3)
    a = shelf_repo.create_shelf(uid, "Synthetic bins", "home", [1.0, 0.0], "m", 2)
    b = shelf_repo.create_shelf(uid, "Synthetic boxes", "home", [0.99, 0.1], "m", 1)
    for cid, s in ((c[0], a), (c[1], a), (c[2], b)):
        shelf_repo.upsert_shelf_page(s["id"], cid, uid, f"sub {cid}", "create", 1.0)
    shelf_repo.set_shelf_string(uid, "sub boxes", b["id"])
    res = ss.weekly_maintenance(
        uid, ask_merge=lambda x, y: True, ask_split_name=lambda s, subs: None, embed=None
    )
    assert (res["merged"], res["split"]) == (1, 0)
    assert [s["id"] for s in shelf_repo.get_shelves(uid)] == [a["id"]]
    merged = shelf_repo.get_shelf(b["id"])
    assert merged["status"] == "merged" and merged["merged_into"] == a["id"]
    assert shelf_repo.get_shelf(a["id"])["n_pages"] == 3
    assert shelf_repo.get_shelf_string(uid, "sub boxes") == a["id"]
    want = np.array([1.0, 0.0]) * 2 + np.array([0.99, 0.1]) / np.linalg.norm([0.99, 0.1])
    assert shelf_repo.get_shelf(a["id"])["centroid"] == pytest.approx(
        (want / np.linalg.norm(want)).tolist()
    )
    assert ss.weekly_maintenance(uid, ask_merge=lambda x, y: True, embed=None)["merged"] == 0
