"""Tests for scripts/backfill_skip_categories.py (LLM mocked)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.services.skip_categories import SKIP_CATEGORY_IDS
from scripts import backfill_skip_categories as bf


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001 - any failure means unreachable
        return False


needs_pg = pytest.mark.skipif(not _pg_reachable(), reason="test PostgreSQL not reachable")


def test_batches_split_into_forty():
    items = list(range(95))
    chunks = list(bf.batches(items, 40))
    assert [len(c) for c in chunks] == [40, 40, 15]
    assert [x for c in chunks for x in c] == items


def test_tool_enum_matches_categories():
    tool = bf.classify_tool()
    fn = tool["function"]
    assert fn["name"] == "classify_skip_reasons"
    item = fn["parameters"]["properties"]["items"]["items"]
    assert item["properties"]["category"]["enum"] == list(SKIP_CATEGORY_IDS)
    assert set(item["required"]) == {"index", "category"}


def test_parse_response_fills_missing_and_invalid_with_other():
    args = {
        "items": [
            {"index": 0, "category": "login_wall"},
            {"index": 1, "category": "Search Results"},  # label tolerated
            {"index": 2, "category": "not_a_category"},  # invalid -> other
            {"index": 9, "category": "error_page"},  # out of range, ignored
            {"index": "x", "category": "error_page"},  # bad index, ignored
            "junk",
        ]
    }
    out = bf.parse_response(args, 5)
    assert out == ["login_wall", "search_results", "other", "other", "other"]


def test_parse_response_handles_garbage():
    assert bf.parse_response(None, 2) == ["other", "other"]
    assert bf.parse_response({"items": "nope"}, 2) == ["other", "other"]


def test_classify_batch_uses_mock_and_returns_usage(monkeypatch):
    seen = {}

    class FakeResp:
        input_tokens = 10
        output_tokens = 5
        cost_usd = 0.001

    class FakeLLM:
        async def select_tool(self, prompt, tools, model=None, **kw):
            seen.update(prompt=prompt, tools=tools, kw=kw)
            args = {"items": [{"index": 0, "category": "error_page"}]}
            return FakeResp(), [{"name": "classify_skip_reasons", "arguments": args}]

    cats, usage = asyncio.run(bf.classify_batch(FakeLLM(), ["r0", "r1"], "m"))
    assert cats == ["error_page", "other"]
    assert usage["cost_usd"] == 0.001
    assert seen["kw"]["temperature"] == 0.0
    assert "r0" in seen["prompt"] and "r1" in seen["prompt"]


def test_classify_batch_no_tool_call_is_all_other():
    class FakeResp:
        input_tokens = 0
        output_tokens = 0
        cost_usd = 0.0

    class FakeLLM:
        async def select_tool(self, prompt, tools, model=None, **kw):
            return FakeResp(), None

    cats, _ = asyncio.run(bf.classify_batch(FakeLLM(), ["a", "b"], "m"))
    assert cats == ["other", "other"]


def test_build_mapping_shape():
    rows = [("a", 3), ("b", 1), ("c", 2)]
    m = bf.build_mapping("m", rows, ["login_wall", "other", "login_wall"])
    assert set(m) == {"generated_at", "model", "counts_by_category", "items"}
    assert m["model"] == "m"
    assert m["items"][0] == {"reason": "a", "category": "login_wall", "pages": 3}
    assert m["counts_by_category"]["login_wall"] == {"reasons": 2, "pages": 5}
    assert m["counts_by_category"]["other"] == {"reasons": 1, "pages": 1}
    assert set(m["counts_by_category"]) == set(SKIP_CATEGORY_IDS)


def test_refuses_path_inside_repo():
    inside = Path(bf.__file__).resolve().parent / "mapping.json"
    with pytest.raises(SystemExit):
        bf.check_outside_repo(inside)


def test_accepts_path_outside_repo(tmp_path):
    bf.check_outside_repo(tmp_path / "m.json")


def test_default_mapping_path_is_outside_repo():
    p = bf.default_mapping_path()
    assert ".local/share/compendium" in str(p)
    bf.check_outside_repo(p)


@needs_pg
def test_apply_mapping_updates_only_matching_null_rows():
    from backend.db import capture_repo, page_repo, user_repo
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, page_clusters, pages, page_content, captures, users CASCADE"
        )
    uid = user_repo.create_user("bf@example.com", name="BF")["id"]
    from datetime import UTC, datetime

    now = datetime(2026, 3, 15, 10, 0, tzinfo=UTC)
    cap_id = capture_repo.save_capture(
        user_id=uid, capture_id="bf_cap", source="desktop_active", started_at=now, ended_at=now
    )["id"]
    with get_conn() as conn, conn.cursor() as cur:
        for i, (reason, cat) in enumerate(
            [
                ("reason one", None),
                ("reason one", None),
                ("reason two", None),
                ("reason one", "other"),
            ]
        ):
            cur.execute(
                "INSERT INTO pages (url, title, domain, status, user_id, capture_id, "
                "archive_reason, skip_reasoning, skip_category, normalized_url) "
                "VALUES (%s, 't', 'example.com', 'archived', %s, %s, 'skip_gate', %s, %s, %s)",
                (f"https://example.com/{i}", uid, cap_id, reason, cat, f"https://example.com/{i}"),
            )
    mapping = {
        "items": [
            {"reason": "reason one", "category": "login_wall", "pages": 2},
            {"reason": "reason two", "category": "error_page", "pages": 1},
        ]
    }
    updated = bf.apply_mapping(mapping["items"])
    assert updated == 3  # the already-categorised row is untouched
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT skip_reasoning, skip_category, count(*) FROM pages GROUP BY 1, 2")
        got = {(r, c): n for r, c, n in cur.fetchall()}
    assert got == {
        ("reason one", "login_wall"): 2,
        ("reason two", "error_page"): 1,
        ("reason one", "other"): 1,
    }


def test_load_mapping_in_roundtrip(tmp_path):
    f = tmp_path / "m.json"
    f.write_text(json.dumps({"items": [{"reason": "x", "category": "bogus", "pages": 1}]}))
    items = bf.load_mapping(f)
    assert items == [{"reason": "x", "category": "other", "pages": 1}]
