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


def test_batches_split_by_batch_size():
    items = list(range(40))
    chunks = list(bf.batches(items, bf.BATCH_SIZE))
    assert bf.BATCH_SIZE == 15
    assert [len(c) for c in chunks] == [15, 15, 10]
    assert [x for c in chunks for x in c] == items


def test_tool_enum_matches_categories():
    tool = bf.classify_tool()
    fn = tool["function"]
    assert fn["name"] == "classify_skip_reasons"
    item = fn["parameters"]["properties"]["items"]["items"]
    assert item["properties"]["category"]["enum"] == list(SKIP_CATEGORY_IDS)
    assert "web_app" in SKIP_CATEGORY_IDS
    assert set(item["required"]) == {"index", "category", "echo"}


def _ans(i, cat, reasons):
    return {"index": i, "category": cat, "echo": reasons[i][:30]}


def test_parse_response_gaps_and_invalid_are_none_not_other():
    reasons = ["r0", "r1", "r2", "r3", "r4"]
    args = {
        "items": [
            _ans(0, "login_wall", reasons),
            _ans(1, "Search Results", reasons),  # label tolerated
            _ans(2, "not_a_category", reasons),  # invalid -> None
            {"index": 9, "category": "error_page", "echo": "r0"},  # out of range
            {"index": "x", "category": "error_page", "echo": "r0"},  # bad index
            "junk",
        ]
    }
    out = bf.parse_response(args, reasons)
    assert out == ["login_wall", "search_results", None, None, None]


def test_parse_response_valid_other_is_other():
    reasons = ["weird"]
    assert bf.parse_response({"items": [_ans(0, "other", reasons)]}, reasons) == ["other"]


def test_parse_response_rejects_echo_mismatch_and_missing_echo():
    reasons = ["login wall seen", "error page seen"]
    args = {
        "items": [
            {"index": 0, "category": "error_page", "echo": "error page seen"},  # shifted
            {"index": 1, "category": "error_page"},  # no echo
        ]
    }
    assert bf.parse_response(args, reasons) == [None, None]


def test_parse_response_echo_is_prefix_of_long_reason_case_insensitive():
    reasons = ["Marketplace / product / store listing page with many items"]
    args = {"items": [{"index": 0, "category": "store_listing", "echo": reasons[0][:30].upper()}]}
    assert bf.parse_response(args, reasons) == ["store_listing"]


def test_parse_response_handles_garbage():
    assert bf.parse_response(None, ["a", "b"]) == [None, None]
    assert bf.parse_response({"items": "nope"}, ["a", "b"]) == [None, None]


class _Resp:
    input_tokens = 10
    output_tokens = 5
    cost_usd = 0.001


class _ScriptedLLM:
    """Answers per call from a script: each step maps the prompt's reasons to categories
    only for the indices the step lists (the model 'forgets' the rest)."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.prompts = []

    async def select_tool(self, prompt, tools, model=None, **kw):
        assert kw["temperature"] == 0.0
        self.prompts.append(prompt)
        reasons = bf.reasons_in_prompt(prompt)
        answered = self.steps.pop(0) if self.steps else {}
        items = [
            {"index": i, "category": answered[r], "echo": r[:30]}
            for i, r in enumerate(reasons)
            if r in answered
        ]
        return _Resp(), [{"name": "classify_skip_reasons", "arguments": {"items": items}}]


def test_classify_batch_all_answered_first_call():
    llm = _ScriptedLLM([{"r0": "error_page", "r1": "other"}])
    cats, usage, stats = asyncio.run(bf.classify_batch(llm, ["r0", "r1"], "m"))
    assert cats == ["error_page", "other"]
    assert stats == {"retried": 0, "single": 0}
    assert usage["cost_usd"] == 0.001 and len(llm.prompts) == 1


def test_retry_reasks_only_missing_items():
    llm = _ScriptedLLM([{"r0": "login_wall"}, {"r1": "error_page", "r2": "web_app"}])
    cats, _, stats = asyncio.run(bf.classify_batch(llm, ["r0", "r1", "r2"], "m"))
    assert cats == ["login_wall", "error_page", "web_app"]
    assert stats == {"retried": 2, "single": 0}
    assert len(llm.prompts) == 2
    assert "r0" not in bf.reasons_in_prompt(llm.prompts[1])
    assert bf.reasons_in_prompt(llm.prompts[1]) == ["r1", "r2"]


def test_falls_back_to_single_calls_then_leaves_none():
    # initial + 2 retries answer nothing for r1; its single call also answers nothing.
    llm = _ScriptedLLM([{"r0": "login_wall"}, {}, {}, {}])
    cats, _, _stats = asyncio.run(bf.classify_batch(llm, ["r0", "r1"], "m"))
    assert cats == ["login_wall", None]
    assert len(llm.prompts) == 4
    assert bf.reasons_in_prompt(llm.prompts[3]) == ["r1"]


def test_single_call_resolves():
    llm = _ScriptedLLM([{}, {}, {}, {"r0": "local_file"}])
    cats, _, stats = asyncio.run(bf.classify_batch(llm, ["r0"], "m"))
    assert cats == ["local_file"]
    assert stats == {"retried": 0, "single": 1}


def test_malformed_json_is_retried_not_fatal():
    import json

    class Flaky(_ScriptedLLM):
        async def select_tool(self, prompt, tools, model=None, **kw):
            if not self.prompts:
                self.prompts.append(prompt)
                json.loads('{"items": [{"index": 0, "cat')  # raises JSONDecodeError
            return await super().select_tool(prompt, tools, model, **kw)

    llm = Flaky([{"r0": "error_page"}])
    cats, _, stats = asyncio.run(bf.classify_batch(llm, ["r0"], "m"))
    assert cats == ["error_page"] and stats["retried"] == 1


def test_classify_batch_no_tool_call_leaves_none():
    class FakeLLM:
        async def select_tool(self, prompt, tools, model=None, **kw):
            return _Resp(), None

    cats, _, _ = asyncio.run(bf.classify_batch(FakeLLM(), ["a", "b"], "m"))
    assert cats == [None, None]


def test_blank_reasons_are_excluded_from_selection_sql():
    assert "skip_reasoning IS NOT NULL" in bf.SELECT_REASONS_SQL
    assert "btrim(skip_reasoning) <> ''" in bf.SELECT_REASONS_SQL
    assert "skip_reasoning IS NOT NULL" in bf.PER_USER_SQL


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


def test_build_mapping_skips_unresolved():
    m = bf.build_mapping("m", [("a", 3), ("b", 1)], ["login_wall", None])
    assert [i["reason"] for i in m["items"]] == ["a"]


def test_default_mapping_path_is_outside_repo():
    p = bf.default_mapping_path()
    assert ".local/share/compendium" in str(p)
    bf.check_outside_repo(p)


@needs_pg
def test_selection_excludes_null_and_blank_reasons():
    from datetime import UTC, datetime

    from backend.db import capture_repo, user_repo
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, page_clusters, pages, page_content, captures, users CASCADE"
        )
    uid = user_repo.create_user("bf2@example.com", name="BF")["id"]
    now = datetime(2026, 3, 15, 10, 0, tzinfo=UTC)
    cap_id = capture_repo.save_capture(
        user_id=uid, capture_id="bf_cap2", source="desktop_active", started_at=now, ended_at=now
    )["id"]
    with get_conn() as conn, conn.cursor() as cur:
        for i, reason in enumerate(["real reason", None, "  ", "real reason"]):
            cur.execute(
                "INSERT INTO pages (url, title, domain, status, user_id, capture_id, "
                "archive_reason, skip_reasoning, normalized_url) "
                "VALUES (%s, 't', 'example.com', 'archived', %s, %s, 'skip_gate', %s, %s)",
                (f"https://example.com/{i}", uid, cap_id, reason, f"https://example.com/{i}"),
            )
    rows, per_user = bf.select_reasons(None)
    assert rows == [("real reason", 2)]
    assert per_user == [(uid, 2)]


@needs_pg
def test_web_app_is_persisted():
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pages WHERE skip_category = 'web_app'")
        assert cur.fetchone()[0] == 0
    # the 047 constraint accepts it (covered by test_skip_categories parametrized write)
    assert "web_app" in SKIP_CATEGORY_IDS


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
