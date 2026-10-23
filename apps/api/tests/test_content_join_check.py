"""content_join_check: the shared mismatch definition, the notes payload, and the
caller-scoped status derived from a recorded nightly run. Synthetic data only."""

from datetime import UTC, datetime

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

from backend.db import capture_repo, content_repo, page_repo, user_repo
from backend.db.connection import get_conn
from backend.services import content_join_check as cjc

T0 = datetime(2026, 3, 15, 10, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE graph_cache, cluster_edges, page_clusters, clusters, recluster_runs,
                     pages, page_content, captures, users CASCADE
            """
        )
    yield


def _url(name):
    return f"https://{name}.example.test/page"


def _sql(query, params=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall() if cur.description else None


def _content(name):
    return content_repo.get_or_create_content(
        _url(name), extracted_text=f"text {name}", content_summary=f"summary {name}"
    )["id"]


def _user(email):
    return user_repo.create_user(email, name="Join Check")


def _pages(user, names, cap_id="cap_join"):
    """Insert one page per name for ``user``; returns {name: page id}."""
    cap = capture_repo.save_capture(
        user_id=user["id"],
        capture_id=f"{cap_id}_{user['id']}",
        source="desktop_active",
        started_at=T0,
        ended_at=T0.replace(hour=11),
    )
    ids = {}
    for i, n in enumerate(names):
        ids[n] = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": _url(n),
                    "title": f"Synthetic {n}",
                    "domain": f"{n}.example.test",
                    "visited_at": T0.replace(minute=i),
                    "extracted_text": f"own {n}",
                }
            ],
        )[0]
    return ids


def _join(page_id, content_id):
    _sql("UPDATE pages SET page_content_id=%s WHERE id=%s", (content_id, page_id))


def _snapshot():
    return (
        _sql("SELECT * FROM pages ORDER BY id"),
        _sql("SELECT * FROM page_content ORDER BY id"),
        _sql("SELECT * FROM page_embeddings ORDER BY 1"),
        _sql("SELECT * FROM clustering_embeddings ORDER BY 1"),
    )


class TestFindMismatchedPages:
    def test_flags_only_pages_joined_to_another_urls_content(self):
        u = _user("a@example.test")
        p = _pages(u, ["a", "b", "c"])
        c = {n: _content(n) for n in "abc"}
        _join(p["a"], c["b"])  # wrong
        _join(p["b"], c["b"])  # right
        # c has no content row joined at all (pending): not a mismatch
        with get_conn() as conn, conn.cursor() as cur:
            rows = cjc.find_mismatched_pages(cur)
        assert [r["page_id"] for r in rows] == [p["a"]]
        r = rows[0]
        assert r["user_id"] == u["id"]
        assert r["old_content_id"] == c["b"]
        assert r["url"] == _url("a")

    def test_user_filter(self):
        u1, u2 = _user("u1@example.test"), _user("u2@example.test")
        p1, p2 = _pages(u1, ["a"]), _pages(u2, ["b"])
        wrong = _content("z")
        _join(p1["a"], wrong)
        _join(p2["b"], wrong)
        with get_conn() as conn, conn.cursor() as cur:
            assert [r["page_id"] for r in cjc.find_mismatched_pages(cur, u2["id"])] == [p2["b"]]
            assert len(cjc.find_mismatched_pages(cur)) == 2

    def test_stale_stored_normalized_url_with_a_right_join_is_not_a_mismatch(self):
        u = _user("stale@example.test")
        p = _pages(u, ["a"])
        _join(p["a"], _content("a"))
        # pages.normalized_url predates a normalizer change; the join is right under today's rules
        _sql(
            "UPDATE pages SET normalized_url='https://old-form.example.test/page' WHERE id=%s",
            (p["a"],),
        )
        with get_conn() as conn, conn.cursor() as cur:
            assert cjc.find_mismatched_pages(cur) == []


class TestCheckContentJoins:
    def test_clean_db_reports_count_zero_and_empty_by_user(self):
        u = _user("clean@example.test")
        p = _pages(u, ["a"])
        _join(p["a"], _content("a"))
        assert cjc.check_content_joins() == {"count": 0, "by_user": {}}

    def test_mismatches_give_count_ids_and_per_user_breakdown(self):
        u1, u2 = _user("one@example.test"), _user("two@example.test")
        p1 = _pages(u1, ["a", "b"])
        p2 = _pages(u2, ["c"])
        wrong = _content("z")
        for pid in (*p1.values(), *p2.values()):
            _join(pid, wrong)
        out = cjc.check_content_joins()
        assert out["count"] == 3
        assert out["by_user"] == {
            str(u1["id"]): {"count": 2, "page_ids": sorted(p1.values())},
            str(u2["id"]): {"count": 1, "page_ids": sorted(p2.values())},
        }

    def test_page_ids_are_capped_at_twenty_ascending_but_count_is_true(self):
        u = _user("many@example.test")
        names = [f"n{i:02d}" for i in range(25)]
        p = _pages(u, names)
        wrong = _content("z")
        for pid in p.values():
            _join(pid, wrong)
        out = cjc.check_content_joins()
        slice_ = out["by_user"][str(u["id"])]
        assert out["count"] == 25
        assert slice_["count"] == 25
        assert slice_["page_ids"] == sorted(p.values())[:20]

    def test_check_never_writes(self):
        u = _user("ro@example.test")
        p = _pages(u, ["a", "b"])
        wrong = _content("z")
        _join(p["a"], wrong)
        _join(p["b"], _content("b"))
        for cid in (wrong,):
            _sql(
                "INSERT INTO clustering_embeddings (page_content_id, model_key, dim, embedding)"
                " VALUES (%s, 'm@v', 3, '[1,2,3]')",
                (cid,),
            )
        before = _snapshot()
        assert cjc.check_content_joins()["count"] == 1
        assert _snapshot() == before


def _run(notes, finished=datetime(2026, 10, 22, 3, 0, tzinfo=UTC)):
    return {"finished_at": finished, "notes": notes}


class TestStatusForUser:
    def test_never_when_no_run_recorded_the_check(self):
        assert cjc.status_for_user(None, 5) == {
            "state": "never",
            "checked_at": None,
            "count": 0,
            "page_ids": [],
        }

    def test_clean(self):
        s = cjc.status_for_user(_run({"content_join_mismatches": {"count": 0, "by_user": {}}}), 5)
        assert s["state"] == "clean"
        assert s["count"] == 0 and s["page_ids"] == []
        assert s["checked_at"] == "2026-10-22T03:00:00+00:00"

    def test_mismatches_carry_only_the_callers_slice(self):
        notes = {
            "content_join_mismatches": {
                "count": 5,
                "by_user": {
                    "5": {"count": 2, "page_ids": [10, 11]},
                    "9": {"count": 3, "page_ids": [20, 21, 22]},
                },
            }
        }
        s = cjc.status_for_user(_run(notes), 5)
        assert (s["state"], s["count"], s["page_ids"]) == ("mismatches", 2, [10, 11])
        assert set(s) == {"state", "checked_at", "count", "page_ids"}
        assert not {20, 21, 22} & set(s["page_ids"])

    def test_other_users_mismatches_read_as_clean_for_the_caller(self):
        notes = {
            "content_join_mismatches": {
                "count": 3,
                "by_user": {"9": {"count": 3, "page_ids": [20, 21, 22]}},
            }
        }
        s = cjc.status_for_user(_run(notes), 5)
        assert (s["state"], s["count"], s["page_ids"]) == ("clean", 0, [])

    def test_error_state_has_no_message(self):
        s = cjc.status_for_user(
            _run({"content_join_mismatches": {"error": "secret dsn detail"}}), 5
        )
        assert s["state"] == "error"
        assert "secret" not in repr(s)
        assert s["count"] == 0 and s["page_ids"] == []

    def test_malformed_entry_reads_as_error_not_a_crash(self):
        for bad in ("oops", [], {"count": "x"}, {"count": 1, "by_user": "nope"}):
            s = cjc.status_for_user(_run({"content_join_mismatches": bad}), 5)
            assert s["state"] == "error"
