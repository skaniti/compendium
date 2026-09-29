"""Tests for scripts/regate_dwell_archives.py (no network, no DB)."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import regate_dwell_archives as rg

USAGE = {"model": "m", "input_tokens": 1, "output_tokens": 2, "cost_usd": 0.001}


def _page(pid, reasoning="no dwell time recorded"):
    return {
        "id": pid,
        "title": f"Page {pid}",
        "url": f"https://example.com/{pid}",
        "skip_reasoning": reasoning,
        "page_content_id": pid * 10,
        "fetched_content": {},
        "tool_selected": None,
    }


@pytest.fixture
def env(monkeypatch):
    calls = {"restore": [], "write": [], "gate": [], "select": [], "cost": []}
    state = {"pages": [], "verdicts": {}, "embeds": {}, "snippets": {}}

    def fake_select(user_id, pattern, limit=None):
        calls["select"].append((user_id, pattern, limit))
        return state["pages"]

    async def fake_gate(page, snippet):
        calls["gate"].append(page["id"])
        v = state["verdicts"][page["id"]]
        if isinstance(v, Exception):
            raise v
        return (*v, USAGE)

    monkeypatch.setattr(rg, "select_pages", fake_select)
    monkeypatch.setattr(rg, "gate_verdict", fake_gate)
    monkeypatch.setattr(rg, "build_snippet", lambda p: state["snippets"].get(p["id"], "text"))
    monkeypatch.setattr(rg, "has_embeddings", lambda pcid: state["embeds"].get(pcid, True))
    monkeypatch.setattr(rg, "set_current_user_id", lambda uid: None)
    monkeypatch.setattr(rg.page_repo, "restore_page", lambda pid: calls["restore"].append(pid))
    monkeypatch.setattr(
        rg,
        "write_regate",
        lambda pid, text, depth, *, set_depth: calls["write"].append((pid, text, depth, set_depth)),
    )
    monkeypatch.setattr(rg, "record_cost", lambda uid, usage: calls["cost"].append(uid))
    return calls, state


def test_selection_uses_user_and_pattern(env):
    calls, _ = env
    rg.run(152, "%foo%", False, None)
    assert calls["select"] == [(152, "%foo%", None)]


def test_dry_run_writes_nothing(env, capsys):
    calls, state = env
    state["pages"] = [_page(1), _page(2)]
    state["verdicts"] = {1: ("include", "on topic"), 2: ("skip", "junk")}
    res = rg.run(152, "%dwell%", False, None)
    assert calls["restore"] == [] and calls["write"] == [] and calls["cost"] == []
    assert (res["include"], res["skip"], res["error"]) == (1, 1, 0)
    out = capsys.readouterr().out
    assert "1 include / 1 skip / 0 error / 0 no_content" in out
    assert "snippet=4" in out and "depth->processed" in out


def test_dry_run_reports_missing_embeddings(env):
    _, state = env
    state["pages"] = [_page(1)]
    state["verdicts"] = {1: ("include", "a")}
    state["embeds"] = {10: False}
    assert rg.run(152, "%dwell%", False, None)["needs_reprocess"] == [1]


def test_apply_restores_only_include_and_rewrites_both(env):
    calls, state = env
    state["pages"] = [_page(1), _page(2)]
    state["verdicts"] = {1: ("include", "useful"), 2: ("skip", "junk")}
    rg.run(152, "%dwell%", True, None)
    assert calls["restore"] == [1]
    assert [w[0] for w in calls["write"]] == [1, 2]
    t1, t2 = calls["write"][0][1], calls["write"][1][1]
    assert " under skip_gate_v2_3 -> INCLUDE (was: no dwell time recorded): useful" in t1
    assert t1.startswith("re-gated ")
    assert " under skip_gate_v2_3 -> SKIP (was: no dwell time recorded): junk" in t2
    assert calls["cost"] == [152, 152]


def test_include_sets_depth_processed_with_embeddings_null_without(env):
    calls, state = env
    state["pages"] = [_page(1), _page(2)]
    state["verdicts"] = {1: ("include", "a"), 2: ("include", "b")}
    state["embeds"] = {20: False}
    res = rg.run(152, "%dwell%", True, None)
    assert calls["write"][0][2:] == ("processed", True)
    assert calls["write"][1][2:] == (None, True)
    assert calls["restore"] == [1, 2]  # restored AND flagged
    assert res["needs_reprocess"] == [2]


def test_skip_verdict_does_not_touch_depth(env):
    calls, state = env
    state["pages"] = [_page(1)]
    state["verdicts"] = {1: ("skip", "junk")}
    rg.run(152, "%dwell%", True, None)
    assert calls["write"][0][3] is False


def test_rewrite_precedes_restore(env, monkeypatch):
    _, state = env
    order = []
    monkeypatch.setattr(rg, "write_regate", lambda *a, **k: order.append("write"))
    monkeypatch.setattr(rg.page_repo, "restore_page", lambda pid: order.append("restore"))
    state["pages"] = [_page(1)]
    state["verdicts"] = {1: ("include", "a")}
    rg.run(152, "%dwell%", True, None)
    assert order == ["write", "restore"]


def test_empty_snippet_include_not_restored_unless_allowed(env, capsys):
    calls, state = env
    state["pages"] = [_page(1)]
    state["verdicts"] = {1: ("include", "title looks fine")}
    state["snippets"] = {1: ""}
    res = rg.run(152, "%dwell%", True, None)
    assert calls["restore"] == [] and calls["write"] == []
    assert res["no_content"] == 1 and res["title_only"] == [1]
    assert "title-only" in capsys.readouterr().out
    rg.run(152, "%dwell%", True, None, allow_title_only=True)
    assert calls["restore"] == [1]


def test_failure_counted_and_others_proceed(env):
    calls, state = env
    state["pages"] = [_page(1), _page(2), _page(3)]
    state["verdicts"] = {1: ("include", "a"), 2: RuntimeError("boom"), 3: ("include", "c")}
    res = rg.run(152, "%dwell%", True, None)
    assert res["error"] == 1 and res["include"] == 2
    assert calls["restore"] == [1, 3]
    assert res["errors"][0][0] == 2


def test_main_exit_code_nonzero_on_error(env):
    _, state = env
    state["pages"] = [_page(1)]
    state["verdicts"] = {1: RuntimeError("boom")}
    assert rg.main(["--user-id", "152"]) == 1
    state["verdicts"] = {1: ("skip", "x")}
    assert rg.main(["--user-id", "152"]) == 0


def test_limit_caps_gate_calls_including_zero(env):
    calls, state = env
    state["pages"] = [_page(i) for i in range(1, 6)]
    state["verdicts"] = {i: ("skip", "x") for i in range(1, 6)}
    rg.run(152, "%dwell%", False, 2)
    assert calls["select"][0][2] == 2
    assert calls["gate"] == [1, 2]
    calls["gate"].clear()
    rg.run(152, "%dwell%", False, 0)
    assert calls["gate"] == []


class _Resp:
    input_tokens = 3
    output_tokens = 4
    cost_usd = 0.5


@pytest.mark.parametrize(
    "tool_calls,expected",
    [
        ([{"name": "skip_page", "arguments": {"reasoning": "junk"}}], ("skip", "junk")),
        ([{"name": "process_page", "arguments": {"reason": "good"}}], ("include", "good")),
        (None, ("include", "")),
    ],
)
def test_gate_verdict_prompt_kwargs_and_branches(monkeypatch, tool_calls, expected):
    from backend.api.main import TOOL_SELECTION_MODEL
    from backend.services import llm_service

    seen = {}

    def fake_get_prompt(name, **kw):
        seen["prompt"] = (name, kw)
        return "PROMPT"

    async def fake_select_tool(self, prompt, tools, model=None, **kw):
        seen["llm"] = (prompt, tools, model, kw)
        return _Resp(), tool_calls

    monkeypatch.setattr("backend.prompts.templates.get_prompt", fake_get_prompt)
    monkeypatch.setattr(llm_service.LLMService, "select_tool", fake_select_tool)
    monkeypatch.setattr(llm_service.LLMService, "__init__", lambda self: None)

    page = {"title": None, "url": "https://sub.example.com/x"}
    verdict, reasoning, usage = asyncio.run(rg.gate_verdict(page, "hello"))

    assert (verdict, reasoning) == expected
    name, kw = seen["prompt"]
    assert name == "skip_gate_v2_3"
    assert kw == {
        "title": "Unknown",
        "url": "https://sub.example.com/x",
        "domain": "sub.example.com",
        "snippet_len": "5",
        "snippet": "hello",
    }
    prompt, tools, model, extra = seen["llm"]
    assert prompt == "PROMPT" and tools is llm_service.PAGE_PROCESSING_TOOLS
    assert model == TOOL_SELECTION_MODEL and extra == {"temperature": 0.0}
    assert usage == {
        "model": TOOL_SELECTION_MODEL,
        "input_tokens": 3,
        "output_tokens": 4,
        "cost_usd": 0.5,
    }


def test_selection_sql_skips_rows_already_regated():
    # The rewrite keeps the old wording in "(was: ...)", so without this
    # exclusion a SKIP verdict would match the default %dwell% pattern again
    # on every re-run and burn a gate call each time.
    from scripts import regate_dwell_archives as m

    assert "NOT ILIKE 're-gated%%'" in m.SELECT_SQL
