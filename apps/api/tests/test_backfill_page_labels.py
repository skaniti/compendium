"""backfill_page_labels: dry run makes no API call; --apply is gated and resumable.

The LLM is mocked; synthetic data only.
"""

import json
import re

import pytest

from backend.config.settings import settings


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.scripts import backfill_page_labels as bf
from tests import _label_fixtures as fx

VERSION = "claude-haiku-5-5@page_annotation_v2"


@pytest.fixture(autouse=True)
def _clean():
    fx.truncate()
    yield


@pytest.fixture
def world():
    u1, u2 = fx.make_user("one"), fx.make_user("two")
    c1, c2 = fx.make_capture(u1), fx.make_capture(u2, "cap_two")
    ids = {}
    for i, n in enumerate(["a", "b", "c", "d", "e"]):
        ids[n] = fx.make_page(u1, c1, n, minute=i)[1]
    ids["f"] = fx.make_page(u2, c2, "f", minute=9)[1]
    ids["arch"] = fx.make_page(u1, c1, "arch", minute=10, status="archived")[1]
    return {"u1": u1["id"], "u2": u2["id"], **ids}


@pytest.fixture
def llm(monkeypatch):
    """Replace the model client; fail the test if anything but this is used."""
    fake = fx.FakeLLM()
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: fake)
    monkeypatch.setattr(type(settings), "has_anthropic", property(lambda self: True))
    return fake


def test_dry_run_prints_estimate_and_makes_no_call(world, llm, capsys):
    assert bf.main(["--user-id", str(world["u1"])]) == 0
    out = capsys.readouterr().out
    assert llm.calls == []
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 0
    assert fx.sql("SELECT COUNT(*) FROM cost_events")[0][0] == 0
    assert f"Labeller version : {VERSION}" in out
    assert "Pages to label   : 5" in out  # archived page excluded
    assert "Requests         : 1" in out
    assert "Cost at list price" in out and "Cost at measured effective" in out
    assert "$0.0005" in out  # 5 pages * $0.0001 measured
    assert "Dry run" in out
    assert out.index("Pages to label") < out.index("Dry run")


def test_dry_run_counts_follow_flags(world, llm, capsys):
    bf.main([])
    assert "Pages to label   : 6" in capsys.readouterr().out
    bf.main(["--all-statuses"])
    assert "Pages to label   : 7" in capsys.readouterr().out
    bf.main(["--limit", "2"])
    assert "Pages to label   : 2" in capsys.readouterr().out
    assert llm.calls == []


def test_apply_needs_confirmation_without_tty(world, llm, capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert bf.main(["--apply"]) == 1
    err = capsys.readouterr()
    assert "--yes" in err.err and llm.calls == []
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 0


def test_apply_tty_confirmation(world, llm, capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    assert bf.main(["--apply"]) == 1 and llm.calls == []
    monkeypatch.setattr("builtins.input", lambda prompt="": "y")
    assert bf.main(["--apply"]) == 0
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 6


def test_apply_yes_labels_everyone_prints_spend_and_is_resumable(world, llm, capsys):
    assert bf.main(["--apply", "--yes"]) == 0
    out = capsys.readouterr().out
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 6
    assert "Done: 6/6 labelled" in out and "Actual spend: $" in out
    # estimate printed before any progress/spend line
    assert out.index("Pages to label") < out.index("Actual spend")
    # per-user cost events, attributed to each owner
    owners = sorted(r[0] for r in fx.sql("SELECT user_id FROM cost_events"))
    assert owners == sorted([world["u1"], world["u2"]])
    calls = len(llm.calls)
    # second run: nothing to do, no API call
    assert bf.main(["--apply", "--yes"]) == 0
    assert "Nothing to label" in capsys.readouterr().out
    assert len(llm.calls) == calls


def test_apply_resumes_after_partial_failure(world, monkeypatch, capsys):
    state = {"fail": True}

    def handler(idx, prompt):
        if state["fail"] and idx == 0:
            return "{truncated"
        ids = [int(x) for x in re.findall(r"### page_id: (\d+)", prompt)]
        return json.dumps({"items": [fx.item(i) for i in ids]})

    fake = fx.FakeLLM(handler)
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: fake)
    monkeypatch.setattr(type(settings), "has_anthropic", property(lambda self: True))
    monkeypatch.setattr(settings, "label_batch_size", 3)
    rc = bf.main(["--apply", "--yes", "--user-id", str(world["u1"])])
    assert rc == 3  # a request failed
    done = fx.sql("SELECT COUNT(*) FROM page_labels")[0][0]
    assert 0 < done < 5
    state["fail"] = False
    assert bf.main(["--apply", "--yes", "--user-id", str(world["u1"])]) == 0
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 5


def test_apply_limit_and_all_statuses(world, llm, capsys):
    assert bf.main(["--apply", "--yes", "--limit", "2"]) == 0
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 2
    assert bf.main(["--apply", "--yes", "--all-statuses"]) == 0
    assert fx.sql("SELECT COUNT(*) FROM page_labels")[0][0] == 7


def test_apply_without_api_key_refuses(world, monkeypatch, capsys):
    monkeypatch.setattr(type(settings), "has_anthropic", property(lambda self: False))
    assert bf.main(["--apply", "--yes"]) == 2
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().err


def test_format_estimate_uses_measured_rates():
    from backend.services.page_labeller import estimate_cost

    text = bf.format_estimate(estimate_cost(8), VERSION)
    assert "6,114" in text and "1,005" in text and "$0.0001/page" in text
