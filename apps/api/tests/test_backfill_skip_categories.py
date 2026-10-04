"""Tests for scripts/_archive/backfill_skip_categories.py (LLM mocked)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.services.skip_categories import SKIP_CATEGORY_IDS
from scripts._archive import backfill_skip_categories as bf


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
        self.kwargs = getattr(self, "kwargs", [])
        self.kwargs.append(kw)
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


def test_max_tokens_scales_with_batch_size():
    llm = _ScriptedLLM([{"r0": "error_page", "r1": "other"}])
    asyncio.run(bf.classify_batch(llm, ["r0", "r1"], "m"))
    assert llm.kwargs[0]["max_tokens"] == 40 * 2 + 100


def test_failed_parse_still_adds_usage():
    import json

    class Truncating(_ScriptedLLM):
        async def select_tool(self, prompt, tools, model=None, **kw):
            if not self.prompts:
                self.prompts.append(prompt)
                raise json.JSONDecodeError("cut", "{", 1)
            return await super().select_tool(prompt, tools, model, **kw)

    llm = Truncating([{"r0": "error_page"}])
    cats, usage, _ = asyncio.run(bf.classify_batch(llm, ["r0"], "m"))
    assert cats == ["error_page"]
    # the failed call is estimated (prompt tokens + the output cap), plus the good call's 10/5
    assert usage["input_tokens"] > 10 and usage["output_tokens"] > 5
    assert "estimated_usd" in usage


def test_record_cost_splits_estimated_and_actual(monkeypatch):
    seen = {}
    monkeypatch.setattr("backend.db.trends_repo.insert_cost_event", lambda **kw: seen.update(kw))
    bf.record_cost(
        1, "m", {"input_tokens": 1, "output_tokens": 1, "cost_usd": 0.03, "estimated_usd": 0.01}
    )
    assert seen["metadata"]["estimated_usd"] == 0.01
    assert abs(seen["metadata"]["actual_usd"] - 0.02) < 1e-9


def test_usage_recorded_even_when_guard_trips(monkeypatch):
    recorded = []

    async def fake_batch(llm, reasons, model, usage=None):
        usage["cost_usd"] += 9.0
        return ["other"] * len(reasons), usage, {"retried": 0, "single": 0}

    monkeypatch.setattr(bf, "classify_batch", fake_batch)
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: object())
    monkeypatch.setattr(bf, "record_cost", lambda uid, model, usage: recorded.append(usage))
    with pytest.raises(SystemExit):
        asyncio.run(bf.classify_all([("a", 1)], "m", user_id=7))
    assert recorded and recorded[0]["cost_usd"] == 9.0


def test_merges_items_from_every_tool_call():
    class TwoCalls:
        async def select_tool(self, prompt, tools, model=None, **kw):
            c = lambda i, cat: {
                "name": "classify_skip_reasons",
                "arguments": {"items": [{"index": i, "category": cat, "echo": f"r{i}"}]},
            }
            return _Resp(), [c(0, "login_wall"), c(1, "error_page")]

    cats, _, _ = asyncio.run(bf.classify_batch(TwoCalls(), ["r0", "r1"], "m"))
    assert cats == ["login_wall", "error_page"]


def test_echo_must_be_long_enough():
    reason = "A fairly long reason about a login wall page"
    short = {"items": [{"index": 0, "category": "login_wall", "echo": "a"}]}
    assert bf.parse_response(short, [reason]) == [None]
    ok = {"items": [{"index": 0, "category": "login_wall", "echo": reason[:28].lower()}]}
    assert bf.parse_response(ok, [reason]) == ["login_wall"]
    tiny = {"items": [{"index": 0, "category": "other", "echo": "ab"}]}
    assert bf.parse_response(tiny, ["ab"]) == ["other"]


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
    assert set(m) == {
        "generated_at",
        "model",
        "counts_by_category",
        "items",
        "mixed_prefix_groups",
    }
    assert m["model"] == "m"
    assert m["items"][0] == {"reason": "a", "category": "login_wall", "pages": 3}
    assert m["counts_by_category"]["login_wall"] == {"reasons": 2, "pages": 5}
    assert m["counts_by_category"]["other"] == {"reasons": 1, "pages": 1}
    assert set(m["counts_by_category"]) == set(SKIP_CATEGORY_IDS)


def test_refuses_path_inside_repo():
    inside = Path(bf.__file__).resolve().parent / "mapping.json"
    with pytest.raises(SystemExit):
        bf.check_outside_repo(inside)


def test_refuses_relative_path_inside_repo(monkeypatch):
    monkeypatch.chdir(Path(bf.__file__).resolve().parent)
    with pytest.raises(SystemExit):
        bf.check_outside_repo(Path("x.json"))


def test_refuses_tilde_path_when_home_is_in_repo(monkeypatch, tmp_path):
    repo = Path(bf.__file__).resolve().parent
    monkeypatch.setenv("HOME", str(repo))
    with pytest.raises(SystemExit):
        bf.check_outside_repo(Path("~/x.json"))


def test_refuses_symlink_that_points_into_repo(tmp_path):
    link = tmp_path / "link"
    link.symlink_to(Path(bf.__file__).resolve().parent)
    with pytest.raises(SystemExit):
        bf.check_outside_repo(link / "x.json")


def test_refuses_in_repo_symlink_that_points_out(tmp_path, monkeypatch):
    import subprocess

    fake_repo = tmp_path / "repo"
    fake_repo.mkdir()
    subprocess.run(["git", "init", "-q", str(fake_repo)], check=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (fake_repo / "docs").symlink_to(outside)
    monkeypatch.setattr(bf, "_repo_root", lambda: fake_repo.resolve())
    with pytest.raises(SystemExit):
        bf.check_outside_repo(fake_repo / "docs" / "x.json")


def test_refuses_when_nearest_ancestor_is_a_git_work_tree(tmp_path):
    import subprocess

    subprocess.run(["git", "init", "-q", str(tmp_path / "other")], check=True)
    with pytest.raises(SystemExit):
        bf.check_outside_repo(tmp_path / "other" / "new" / "dir" / "m.json")


def test_probe_fails_closed_on_oserror(monkeypatch, tmp_path):
    monkeypatch.setattr(bf, "_repo_root", lambda: None)

    def boom(*a, **k):
        raise PermissionError("git")

    monkeypatch.setattr(bf.subprocess, "run", boom)
    with pytest.raises(SystemExit):
        bf.check_outside_repo(tmp_path / "m.json")


def test_probe_fails_closed_on_unrecognised_stderr(monkeypatch, tmp_path):
    from types import SimpleNamespace

    monkeypatch.setattr(bf, "_repo_root", lambda: None)
    monkeypatch.setattr(
        bf.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=128, stderr="fatal: something odd", stdout=""),
    )
    with pytest.raises(SystemExit):
        bf.check_outside_repo(tmp_path / "m.json")


def test_probe_runs_with_c_locale(monkeypatch, tmp_path):
    from types import SimpleNamespace

    seen = {}

    def fake(*a, **k):
        seen["env"] = k.get("env")
        return SimpleNamespace(returncode=128, stderr="fatal: not a git repository", stdout="")

    monkeypatch.setattr(bf, "_repo_root", lambda: None)
    monkeypatch.setattr(bf.subprocess, "run", fake)
    bf.check_outside_repo(tmp_path / "m.json")
    assert seen["env"]["LC_ALL"] == "C"


def test_no_git_binary_walks_for_dot_git(monkeypatch, tmp_path):
    def nogit(*a, **k):
        raise FileNotFoundError("git")

    monkeypatch.setattr(bf.subprocess, "run", nogit)
    monkeypatch.setattr(bf, "_repo_root", lambda: None)
    bf.check_outside_repo(tmp_path / "m.json")  # no .git anywhere above: accepted
    (tmp_path / ".git").mkdir()  # a .git directory
    with pytest.raises(SystemExit):
        bf.check_outside_repo(tmp_path / "sub" / "m.json")
    (tmp_path / ".git").rmdir()
    (tmp_path / ".git").write_text("gitdir: elsewhere")  # a .git file (worktree)
    with pytest.raises(SystemExit):
        bf.check_outside_repo(tmp_path / "m.json")


def test_existing_mapping_file_probes_its_parent_dir(monkeypatch, tmp_path):
    from types import SimpleNamespace

    f = tmp_path / "m.json"
    f.write_text("{}")
    seen = []

    def fake(cmd, **k):
        seen.append(cmd[2])
        return SimpleNamespace(returncode=128, stderr="not a git repository", stdout="")

    monkeypatch.setattr(bf, "_repo_root", lambda: None)
    monkeypatch.setattr(bf.subprocess, "run", fake)
    bf.check_outside_repo(f)
    assert seen == [str(tmp_path.resolve())]


def test_accepts_path_outside_repo(tmp_path):
    bf.check_outside_repo(tmp_path / "m.json")


def test_prompt_states_precedence_rule_and_examples():
    p = bf.build_prompt(["x"])
    assert "names a specific kind of page" in p
    assert "even when it also says the page lacks substantive content" in p
    assert "Use content_free_stub only when the reason names no more specific kind" in p
    assert p.count("Example:") == 6
    for cid in ("user_specific", "web_app", "search_results"):
        assert f"-> {cid}" in p


def test_normalize_key_cases():
    n = bf.normalize_key
    assert n("  Login   WALL. ") == "login wall"
    assert n("Error page!!") == "error page"
    assert n("Search results page -- URL clues: q=x") == "search results page"
    assert n("A page. URL clues: foo") == "a page"
    assert n("Same thing,") == n("same thing")


def test_group_reasons_picks_most_frequent_representative():
    rows = [("Dashboard page.", 2), ("dashboard  page", 9), ("Other thing", 1)]
    groups = bf.group_reasons(rows)
    assert len(groups) == 2
    g = next(g for g in groups if g["key"] == "dashboard page")
    assert g["rep"] == "dashboard  page" and g["members"] == [0, 1]


def test_classify_all_applies_representative_category_to_members(monkeypatch):
    seen = []

    async def fake_batch(llm, reasons, model, usage=None):
        seen.extend(reasons)
        return ["user_specific"] * len(reasons), usage, {"retried": 0, "single": 0}

    monkeypatch.setattr(bf, "classify_batch", fake_batch)
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: object())
    rows = [("Dashboard page.", 2), ("dashboard  page", 9), ("Login", 1)]
    cats, _, _, ngroups = asyncio.run(bf.classify_all(rows, "m"))
    assert ngroups == 2
    assert cats == ["user_specific"] * 3
    assert sorted(seen) == ["Login", "dashboard  page"]


def test_mixed_prefix_groups_detects_split_prefix():
    items = [
        {"reason": "Google Maps page, directions", "category": "web_app", "pages": 11},
        {"reason": "Google maps page with route", "category": "asset_library", "pages": 4},
        {"reason": "Login wall", "category": "login_wall", "pages": 5},
        {"reason": "Login wall again", "category": "login_wall", "pages": 2},
    ]
    mixed = bf.mixed_prefix_groups(items)
    assert mixed == [
        {"prefix": "google maps", "pages_by_category": {"web_app": 11, "asset_library": 4}}
    ]


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


def _write(tmp_path, items):
    f = tmp_path / "m.json"
    f.write_text(json.dumps({"items": items}))
    return f


def test_load_mapping_valid(tmp_path):
    f = _write(tmp_path, [{"reason": "x", "category": "login_wall", "pages": 1}])
    assert bf.load_mapping(f) == [{"reason": "x", "category": "login_wall", "pages": 1}]


@pytest.mark.parametrize(
    "item",
    [
        {"reason": "x", "category": "bogus", "pages": 1},
        {"reason": None, "category": "other", "pages": 1},
        {"reason": "   ", "category": "other", "pages": 1},
        {"category": "other", "pages": 1},
        {"reason": "x", "pages": 1},
    ],
)
def test_load_mapping_rejects_bad_items(tmp_path, item):
    with pytest.raises(SystemExit):
        bf.load_mapping(_write(tmp_path, [item]))


def test_dry_run_and_apply_are_mutually_exclusive():
    with pytest.raises(SystemExit):
        bf.main(["--dry-run", "--apply"])


def test_mapping_file_written_0600(tmp_path):
    out = tmp_path / "sub" / "m.json"
    bf.write_mapping(out, {"items": []})
    assert (out.stat().st_mode & 0o777) == 0o600


@needs_pg
def test_apply_mapping_ignores_non_skip_gate_rows():
    from datetime import UTC, datetime

    from backend.db import capture_repo, user_repo
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, page_clusters, pages, page_content, captures, users CASCADE"
        )
    uid = user_repo.create_user("bf3@example.com", name="BF")["id"]
    now = datetime(2026, 3, 15, 10, 0, tzinfo=UTC)
    cap_id = capture_repo.save_capture(
        user_id=uid, capture_id="bf_cap3", source="desktop_active", started_at=now, ended_at=now
    )["id"]
    with get_conn() as conn, conn.cursor() as cur:
        for i, arch in enumerate(["skip_gate", "domain_skip"]):
            cur.execute(
                "INSERT INTO pages (url, title, domain, status, user_id, capture_id, "
                "archive_reason, skip_reasoning, normalized_url) "
                "VALUES (%s, 't', 'example.com', 'archived', %s, %s, %s, 'same reason', %s)",
                (f"https://example.com/{i}", uid, cap_id, arch, f"https://example.com/{i}"),
            )
    assert bf.apply_mapping([{"reason": "same reason", "category": "web_app", "pages": 2}]) == 1
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT archive_reason, skip_category FROM pages ORDER BY id")
        assert cur.fetchall() == [("skip_gate", "web_app"), ("domain_skip", None)]
