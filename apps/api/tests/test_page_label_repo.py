"""page_label_repo against the test database (migration 058)."""

import pytest


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings

        url = settings.test_database_url
        if not url.startswith("postgresql"):
            return False
        from psycopg2 import connect

        connect(url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import page_label_repo as repo
from tests import _label_fixtures as fx

V = "claude-haiku-5-5@page_annotation_v2"


@pytest.fixture(autouse=True)
def _clean():
    fx.truncate()
    yield


def _row(cid, user_id, version=V, **over):
    row = {
        "page_content_id": cid,
        "user_id": user_id,
        "labeller_version": version,
        "category": "science_nature",
        "subtopic": "Synthetic shelf",
        "entity": None,
        "specificity": "narrow_topic",
        "content_kind": "article_reference",
        "knowledge_value": "keep",
        "evidence_level": "text",
        "language": "en",
        "flags": ["non_english"],
        "private_sensitive": False,
        "confidence": 0.75,
    }
    row.update(over)
    return row


@pytest.fixture
def world():
    user = fx.make_user()
    other = fx.make_user("other")
    cap = fx.make_capture(user)
    ocap = fx.make_capture(other, "cap_other")
    pa, ca = fx.make_page(user, cap, "a", minute=1)
    pb, cb = fx.make_page(user, cap, "b", minute=2)
    _pc, cc = fx.make_page(user, cap, "c", minute=3, status="archived")
    _pd, cd = fx.make_page(other, ocap, "d", minute=4)
    return {
        "user": user["id"],
        "other": other["id"],
        "a": ca,
        "b": cb,
        "c": cc,
        "d": cd,
        "pa": pa,
        "pb": pb,
    }


def test_upsert_roundtrip_and_conflict_update(world):
    u = world["user"]
    assert repo.upsert_labels([_row(world["a"], u), _row(world["b"], u)]) == 2
    got = repo.get_labels([world["a"], world["b"]], V)
    assert set(got) == {world["a"], world["b"]}
    a = got[world["a"]]
    assert a["flags"] == ["non_english"]
    assert a["source"] == "model" and a["labeller_version"] == V
    assert a["confidence"] == pytest.approx(0.75)
    repo.upsert_labels([_row(world["a"], u, subtopic="Changed", flags=[])])
    a = repo.get_labels([world["a"]], V)[world["a"]]
    assert a["subtopic"] == "Changed" and a["flags"] == []
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 2


def test_get_labels_latest_version_and_owner_source(world):
    u = world["user"]
    repo.upsert_labels([_row(world["a"], u, version="old@v1", subtopic="Old")])
    repo.upsert_labels([_row(world["a"], u, subtopic="New", source="owner")])
    latest = repo.get_labels([world["a"]])[world["a"]]
    assert latest["subtopic"] == "New" and latest["source"] == "owner"
    assert repo.get_labels([world["a"]], "old@v1")[world["a"]]["subtopic"] == "Old"
    assert repo.get_labels([]) == {}
    assert repo.get_labels([world["b"]]) == {}


def test_unlabelled_filters(world):
    u = world["user"]
    assert repo.get_unlabelled_content_ids(V, user_id=u) == sorted([world["a"], world["b"]])
    assert repo.get_unlabelled_content_ids(V, user_id=u, only_active=False) == sorted(
        [world["a"], world["b"], world["c"]]
    )
    assert world["d"] in repo.get_unlabelled_content_ids(V)
    repo.upsert_labels([_row(world["a"], u)])
    assert repo.get_unlabelled_content_ids(V, user_id=u) == [world["b"]]
    # a different version does not count as labelled
    assert world["a"] in repo.get_unlabelled_content_ids("other@v", user_id=u)
    assert len(repo.get_unlabelled_content_ids(V, limit=1)) == 1


def test_unlabelled_respects_human_status(world):
    fx.sql("UPDATE pages SET human_status='archived' WHERE id=%s", (world["pa"],))
    assert repo.get_unlabelled_content_ids(V, user_id=world["user"]) == [world["b"]]


def test_count_labels(world):
    u = world["user"]
    repo.upsert_labels([_row(world["a"], u), _row(world["d"], world["other"])])
    assert repo.count_labels(u, V) == 1
    assert repo.count_labels(world["other"], V) == 1
    assert repo.count_labels(u, "nope") == 0


def test_get_label_inputs_picks_latest_page_per_content(world):
    cap = fx.make_capture(fx.make_user("third"), "cap_third")
    # second, later visit to content a's URL
    from backend.db import page_repo

    pid = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": "https://a.example.test/page",
                "title": "Later visit",
                "domain": "a.example.test",
                "visited_at": __import__("datetime").datetime(
                    2026, 3, 20, tzinfo=__import__("datetime").timezone.utc
                ),
                "dwell_time_seconds": 5,
            }
        ],
    )[0]
    fx.sql("UPDATE pages SET page_content_id=%s WHERE id=%s", (world["a"], pid))
    rows = repo.get_label_inputs([world["a"], world["b"], 999999])
    by = {r["page_content_id"]: r for r in rows}
    assert set(by) == {world["a"], world["b"]}
    assert by[world["a"]]["id"] == pid and by[world["a"]]["title"] == "Later visit"
    assert by[world["b"]]["visited_at"].startswith("2026-03-15")
    assert by[world["b"]]["extracted_text"] == "body text"
    assert by[world["b"]]["content_summary"] == "summary of b"
    assert repo.get_label_inputs([]) == []
