"""Skip-gate standardized categories: module, tool schema, gate path, storage."""

import logging
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from backend.services import skip_categories as sc

EXPECTED_IDS = (
    "login_wall",
    "user_specific",
    "store_listing",
    "homepage_index",
    "search_results",
    "asset_library",
    "entertainment_video",
    "disambiguation",
    "error_page",
    "content_free_stub",
    "local_file",
    "other",
)


def test_ids_and_order_match_spec():
    assert sc.SKIP_CATEGORY_IDS == EXPECTED_IDS
    assert tuple(c[0] for c in sc.SKIP_CATEGORIES) == EXPECTED_IDS
    assert sc.SKIP_CATEGORY_LABELS["login_wall"] == "Login Wall"
    assert sc.SKIP_CATEGORY_LABELS["content_free_stub"] == "Content-Free Stub"
    assert sc.SKIP_CATEGORY_LABELS["asset_library"] == "Asset Library Listing"
    assert all(len(c) == 3 and all(c) for c in sc.SKIP_CATEGORIES)


@pytest.mark.parametrize("cid", EXPECTED_IDS)
def test_normalize_valid_passthrough(cid):
    assert sc.normalize_category(cid) == cid


@pytest.mark.parametrize("value", [None, "", "   ", 5, [], {}])
def test_normalize_empty_or_nonstring_is_other_quietly(value, caplog):
    with caplog.at_level(logging.WARNING):
        assert sc.normalize_category(value) == "other"
    if value in (None, "", "   "):
        assert not caplog.records


def test_normalize_invalid_and_case_mismatch_logs(caplog):
    with caplog.at_level(logging.WARNING):
        assert sc.normalize_category("bogus") == "other"
        assert sc.normalize_category("LOGIN_WALL") == "other"
    assert len(caplog.records) == 2


def test_tool_schema_lists_exactly_the_ids_and_requires_category():
    from backend.services.llm_service import PAGE_PROCESSING_TOOLS

    skip = next(t for t in PAGE_PROCESSING_TOOLS if t["function"]["name"] == "skip_page")
    params = skip["function"]["parameters"]
    cat = params["properties"]["category"]
    assert tuple(cat["enum"]) == EXPECTED_IDS
    assert cat["type"] == "string"
    for cid in EXPECTED_IDS:
        assert f"{cid}: " in cat["description"]
    assert params["required"] == ["category", "reason"]
    assert "a few words" in params["properties"]["reason"]["description"]
    process = next(t for t in PAGE_PROCESSING_TOOLS if t["function"]["name"] == "process_page")
    assert "category" not in process["function"]["parameters"]["properties"]


# -- gate path ---------------------------------------------------------------


def _result():
    return SimpleNamespace(
        status="success",
        processing_depth=None,
        processing_depth_reasoning=None,
        skip_category=None,
    )


def test_gate_skip_valid_category():
    from backend.api.main import _apply_gate_tool_call

    r = _result()
    _apply_gate_tool_call(r, "skip_page", {"category": "login_wall", "reason": "sign in"})
    assert (r.status, r.processing_depth) == ("skipped", "skipped")
    assert r.skip_category == "login_wall"
    assert r.processing_depth_reasoning == "sign in"


@pytest.mark.parametrize("args", [{"category": "bogus", "reason": "x"}, {"reason": "x"}])
def test_gate_skip_bad_or_missing_category_is_other(args):
    from backend.api.main import _apply_gate_tool_call

    r = _result()
    _apply_gate_tool_call(r, "skip_page", args)
    assert r.skip_category == "other"
    assert r.status == "skipped"


def test_gate_process_leaves_category_none():
    from backend.api.main import _apply_gate_tool_call

    r = _result()
    _apply_gate_tool_call(r, "process_page", {"reasoning": "good"})
    assert r.skip_category is None
    assert r.processing_depth == "processed"
    assert r.processing_depth_reasoning == "good"


def test_capture_result_model_has_optional_skip_category():
    from backend.models.capture import PageProcessingResult

    assert PageProcessingResult.model_fields["skip_category"].default is None


# -- persistence -------------------------------------------------------------


def _persist_args(category):
    result = SimpleNamespace(
        url="https://example.com/x",
        status="skipped",
        processing_depth="skipped",
        processing_depth_reasoning="sign in",
        skip_category=category,
        content_summary=None,
        tool_selected=None,
        cost_usd=None,
        input_tokens=None,
        output_tokens=None,
        latency_ms=None,
        is_learning=None,
        page_content_id=None,
    )
    return result


def test_persist_single_page_passes_skip_category():
    from backend import process_captures

    result = _persist_args("login_wall")
    page_row = {"id": 7, "url": result.url, "extracted_text": None}
    with (
        patch.object(process_captures.page_repo, "update_page_status") as upd,
        patch.object(process_captures.page_repo, "redact_page_extracted_text"),
        patch.object(process_captures.content_repo, "get_or_create_content") as goc,
    ):
        goc.return_value = {"id": 99}
        process_captures._persist_single_page(
            page_row,
            result,
            SimpleNamespace(fetched_contents={}, raw_html_artifacts={}),
        )
    assert upd.call_args.kwargs["skip_category"] == "login_wall"


def test_persist_domain_skip_without_attribute_writes_none():
    from backend import process_captures

    result = _persist_args(None)
    del result.skip_category  # rule-based skips never set the field
    page_row = {"id": 7, "url": result.url, "extracted_text": None}
    with (
        patch.object(process_captures.page_repo, "update_page_status") as upd,
        patch.object(process_captures.page_repo, "redact_page_extracted_text"),
        patch.object(process_captures.content_repo, "get_or_create_content") as goc,
    ):
        goc.return_value = {"id": 99}
        process_captures._persist_single_page(
            page_row,
            result,
            SimpleNamespace(fetched_contents={}, raw_html_artifacts={}),
        )
    assert upd.call_args.kwargs["skip_category"] is None


# -- DB ----------------------------------------------------------------------


def _db_page():
    from backend.db import capture_repo, page_repo, user_repo

    user = user_repo.create_user(f"sc-{uuid.uuid4().hex[:8]}@example.com", name="T")
    cap = capture_repo.save_capture(
        user_id=user["id"],
        capture_id=f"cap_{uuid.uuid4().hex[:8]}",
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=UTC),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=UTC),
    )
    ids = page_repo.insert_pages(cap["id"], [{"url": "https://example.com/a", "title": "T"}])
    return ids[0]


def _read_category(page_id):
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT skip_category FROM pages WHERE id = %s", (page_id,))
        return cur.fetchone()[0]


def test_update_page_status_persists_category_and_default_null():
    from backend.db import page_repo

    pid = _db_page()
    page_repo.update_page_status(
        pid, "archived", skip_reasoning="sign in", skip_category="login_wall"
    )
    assert _read_category(pid) == "login_wall"
    pid2 = _db_page()
    page_repo.update_page_status(pid2, "active")
    assert _read_category(pid2) is None


def test_check_constraint_rejects_invalid_value():
    import psycopg2

    from backend.db.connection import get_conn

    pid = _db_page()
    with (
        pytest.raises(psycopg2.errors.CheckViolation),
        get_conn() as conn,
        conn.cursor() as cur,
    ):
        cur.execute("UPDATE pages SET skip_category = 'bogus' WHERE id = %s", (pid,))


def test_partial_index_exists():
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT indexdef FROM pg_indexes WHERE tablename='pages' "
            "AND indexname='idx_pages_skip_category'"
        )
        row = cur.fetchone()
    assert row and "WHERE" in row[0]
