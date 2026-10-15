"""repair_page_content_joins: dry run, repoint, null+refetch, regate, cache purge."""

from datetime import datetime, timezone

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
from backend.scripts import repair_page_content_joins as repair


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


def _content(name, summary, text):
    return content_repo.get_or_create_content(
        _url(name), extracted_text=text, content_summary=summary
    )["id"]


def _vec(n):
    return "[" + ",".join(["0.1"] * n) + "]"


@pytest.fixture
def world():
    """Pages: A (repoint, skip_gate), D (no own content), E (human override), B (correct)."""
    user = user_repo.create_user("repair@example.test", name="Repair")
    cap = capture_repo.save_capture(
        user_id=user["id"],
        capture_id="cap_repair",
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )
    t = datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc)
    names = ["a", "b", "d", "e"]
    ids = {}
    for i, n in enumerate(names):
        pid = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": _url(n),
                    "title": f"Synthetic {n}",
                    "domain": f"{n}.example.test",
                    "visited_at": t.replace(minute=i),
                    "extracted_text": f"own text {n}",
                }
            ],
        )[0]
        ids[n] = pid
    c = {
        "a": _content("a", "summary of a", "content text a"),
        "b": _content("b", "summary of b", "content text b"),
        "c": _content("c", "summary of c", "content text c"),
        "e": _content("e", "summary of e", "content text e"),
    }
    # a -> b's content (wrong, own exists), archived by skip_gate
    _sql(
        "UPDATE pages SET page_content_id=%s, content_summary='wrong', status='archived',"
        " archive_reason='skip_gate', processing_depth='skipped', skip_reasoning='r' WHERE id=%s",
        (c["b"], ids["a"]),
    )
    # b -> b (correct)
    _sql(
        "UPDATE pages SET page_content_id=%s, content_summary='summary of b',"
        " status='active' WHERE id=%s",
        (c["b"], ids["b"]),
    )
    # d -> c's content (wrong, no own content row), active
    _sql(
        "UPDATE pages SET page_content_id=%s, content_summary='wrong', status='active',"
        " processing_depth='processed' WHERE id=%s",
        (c["c"], ids["d"]),
    )
    # e -> c's content (wrong, own exists), human override
    _sql(
        "UPDATE pages SET page_content_id=%s, status='active', human_status='archived' WHERE id=%s",
        (c["c"], ids["e"]),
    )
    # embedding caches on old (b, c) and new (a, e) targets, and an untouched row on none
    for cid in (c["a"], c["b"], c["c"], c["e"]):
        _sql(
            "INSERT INTO page_embeddings (page_content_id, embedding) VALUES (%s, %s)",
            (cid, _vec(384)),
        )
        _sql(
            "INSERT INTO clustering_embeddings (page_content_id, model_key, dim, embedding)"
            " VALUES (%s, 'm@v', 3, '[1,2,3]')",
            (cid,),
        )
    return {"user": user, "pages": ids, "content": c}


def _snapshot():
    return (
        _sql(
            "SELECT id, page_content_id, content_summary, extracted_text, status,"
            " archive_reason, human_status FROM pages ORDER BY id"
        ),
        _sql("SELECT page_content_id FROM page_embeddings ORDER BY 1"),
        _sql("SELECT page_content_id FROM clustering_embeddings ORDER BY 1"),
    )


def _page(pid):
    return _sql(
        "SELECT page_content_id, content_summary, extracted_text, status,"
        " archive_reason, processing_depth, human_status FROM pages WHERE id=%s",
        (pid,),
    )[0]


def test_dry_run_changes_nothing_and_counts(world):
    before = _snapshot()
    summary, rows = repair.run()
    assert _snapshot() == before
    assert summary["mode"] == "dry-run"
    assert summary["mismatched"] == 3
    assert summary["repairable"] == 2
    assert summary["null_and_refetch"] == 1
    assert summary["skip_gate_regate_needed"] == 1
    # old targets b, c + new targets a, e -> 4 contents x 2 cache tables
    assert summary["embedding_cache_rows"] == 8
    assert summary["by_user"] == {str(world["user"]["id"]): 3}
    assert {r["page_id"] for r in rows} == {world["pages"][n] for n in "ade"}


def test_apply_repoints_and_refreshes_denormalised_copies(world):
    repair.run(apply=True)
    cid, summary, text, *_ = _page(world["pages"]["a"])
    assert cid == world["content"]["a"]
    assert summary == "summary of a"
    assert text == "content text a"


def test_apply_nulls_and_marks_pending_when_no_own_content(world):
    repair.run(apply=True)
    cid, summary, _, status, reason, depth, _ = _page(world["pages"]["d"])
    assert (cid, summary, status, reason, depth) == (None, None, "pending", None, None)


def test_regate_list_is_exactly_skip_gate_pages_and_not_applied_by_default(world):
    _, rows = repair.run(apply=True)
    assert [r["page_id"] for r in rows if r["regate"]] == [world["pages"]["a"]]
    # without --regate the skip_gate verdict is left alone
    assert _page(world["pages"]["a"])[3:5] == ("archived", "skip_gate")


def test_regate_flag_resets_to_pending(world):
    repair.run(apply=True, regate=True)
    assert _page(world["pages"]["a"])[3:5] == ("pending", None)
    assert _sql("SELECT skip_reasoning FROM pages WHERE id=%s", (world["pages"]["a"],)) == [(None,)]


def test_apply_deletes_embedding_cache_for_involved_contents(world):
    summary, _ = repair.run(apply=True)
    assert summary["embedding_cache_rows_deleted"] == 8
    assert _sql("SELECT count(*) FROM page_embeddings") == [(0,)]
    assert _sql("SELECT count(*) FROM clustering_embeddings") == [(0,)]


def test_correct_pages_and_human_status_untouched(world):
    repair.run(apply=True, regate=True)
    cid, summary, _, status, *_ = _page(world["pages"]["b"])
    assert (cid, summary, status) == (world["content"]["b"], "summary of b", "active")
    assert _page(world["pages"]["e"])[6] == "archived"


def test_user_filter_limits_scope(world):
    summary, rows = repair.run(user_id=world["user"]["id"] + 1000)
    assert summary["mismatched"] == 0 and rows == []


def test_second_apply_is_noop(world):
    repair.run(apply=True, regate=True)
    summary, _ = repair.run(apply=True, regate=True)
    assert summary["mismatched"] == 0


def test_report_files(world, tmp_path):
    rp, gp = tmp_path / "r.json", tmp_path / "g.csv"
    assert repair.main(["--report", str(rp), "--regate-list", str(gp)]) == 0
    import csv
    import json

    assert len(json.loads(rp.read_text())) == 3
    assert len(list(csv.DictReader(gp.open()))) == 1
