"""Eval run reader for the Prompts dev view: synthetic runs only."""

import json
import os

import pytest

from backend.config.settings import settings
from backend.services import eval_runs as er


def _metric(acc, n=10, threats=None):
    return {
        "accuracy": acc,
        "n_fixtures": n,
        "n_correct": round(acc * n),
        "n_wrong": n - round(acc * n),
        "n_errored": 0,
        "confusion": {"keep": {"keep": 3, "drop": 1}, "drop": {"keep": 0, "drop": 6}},
        "per_class": {
            "keep": {"tp": 3, "fp": 1, "fn": 0, "precision": 0.75, "recall": 1.0, "f1": 0.857}
        },
        "per_threat_recall": threats or {},
        "cost_weighted_scalar": None,
        "extra": {},
    }


def _run(
    root,
    run_id,
    *,
    ts="2026-01-02T03:04:05Z",
    family="alpha_gate",
    version="v1.0",
    fixture_set="set-a",
    model="model-x",
    sel=0.5,
    stress=None,
    results=None,
    **extra,
):
    d = root / run_id
    d.mkdir()
    metrics = {}
    if sel is not None:
        metrics["selection"] = _metric(sel)
    if stress is not None:
        metrics["stress"] = _metric(stress, threats={"threat-b": 0.95, "threat-a": 0.4})
    data = {
        "run_id": "not-the-dir-name",
        "timestamp": ts,
        "git_sha": "abc1234def",
        "config_hash": "h-1",
        "prompt_name": family,
        "prompt_version": version,
        "prompt_text": "SECRET PROMPT TEXT",
        "model": model,
        "judge_model": None,
        "judge_version": None,
        "fixture_file": "fixtures/alpha.jsonl",
        "fixture_set_label": fixture_set,
        "fixture_version": "fv1",
        "notes": "",
        "cost_weights": {"x": 1},
        "type_counts": {"selection": 10},
        "totals": {
            "cost_usd": 0.0123,
            "wall_time_s": 12.5,
            "llm_calls": 10,
            "cache_hits": 2,
            "cache_misses": 8,
        },
        "metrics": metrics,
        "results": results if results is not None else [],
    }
    data.update(extra)
    (d / "run.json").write_text(json.dumps(data), encoding="utf-8")
    return d


def test_runs_dir_and_status(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "eval_runs_dir", "")
    assert er.runs_dir() is None
    assert er.status() == {"configured": False, "readable": False}
    monkeypatch.setattr(settings, "eval_runs_dir", str(tmp_path / "missing"))
    assert er.status() == {"configured": True, "readable": False}
    monkeypatch.setattr(settings, "eval_runs_dir", str(tmp_path))
    assert er.status() == {"configured": True, "readable": True}
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(settings, "eval_runs_dir", "~/runs")
    assert er.runs_dir() == tmp_path / "runs"


def test_scan_rows_and_order(tmp_path):
    _run(tmp_path, "r-old", ts="2026-01-01T00:00:00Z", version="v1.0", sel=0.5, stress=0.6)
    _run(tmp_path, "r-new", ts="2026-03-01T00:00:00Z", version="v1.1", sel=0.7)
    _run(tmp_path, "r-mid", ts="2026-02-01T00:00:00Z", version="v1.0", sel=0.55)
    _run(tmp_path, "r-nots", ts=None, version="v0.9", sel=0.1)
    out = er.scan(tmp_path)
    assert [r["run_id"] for r in out["runs"]] == ["r-new", "r-mid", "r-old", "r-nots"]
    assert out["skipped"] == 0
    old = out["runs"][2]
    assert (
        old["fixture_set"] == "set-a"
        and old["model"] == "model-x"
        and old["prompt_name"] == "alpha_gate"
    )
    assert old["selection"] == {"accuracy": 0.5, "n": 10} and old["stress"] == {
        "accuracy": 0.6,
        "n": 10,
    }
    assert old["cost_usd"] == 0.0123 and old["wall_time_s"] == 12.5
    assert old["cache_hits"] == 2 and old["cache_misses"] == 8
    assert out["runs"][0]["stress"] is None
    assert "SECRET PROMPT TEXT" not in json.dumps(out)


def test_scan_skips_and_counts(tmp_path, monkeypatch):
    _run(tmp_path, "good")
    (tmp_path / "no-run-json").mkdir()  # ignored, not counted
    (tmp_path / "bad-json").mkdir()
    (tmp_path / "bad-json" / "run.json").write_text("{nope", encoding="utf-8")  # counted
    (tmp_path / "a-list").mkdir()
    (tmp_path / "a-list" / "run.json").write_text("[]", encoding="utf-8")  # counted
    (tmp_path / "loose.json").write_text("{}", encoding="utf-8")  # not a dir: ignored
    _run(tmp_path, ".hidden")  # bad id: ignored
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    _run(outside, "elsewhere")
    os.symlink(outside / "elsewhere", tmp_path / "linked")  # symlinked dir: ignored
    (tmp_path / "linkfile").mkdir()
    os.symlink(outside / "elsewhere" / "run.json", tmp_path / "linkfile" / "run.json")  # counted
    out = er.scan(tmp_path)
    assert [r["run_id"] for r in out["runs"]] == ["good"]
    assert out["skipped"] == 3
    monkeypatch.setattr(er, "MAX_RUN_BYTES", 10)
    assert er.scan(tmp_path)["skipped"] == 4  # oversized now too


def test_deltas_like_for_like(tmp_path):
    _run(tmp_path, "a", ts="2026-01-01T00:00:00Z", version="v1.0", sel=0.5, stress=0.4)
    _run(tmp_path, "b", ts="2026-01-02T00:00:00Z", version="v1.2", sel=0.6)
    _run(tmp_path, "b2", ts="2026-01-03T00:00:00Z", version="v1.2", sel=0.7)
    _run(tmp_path, "c", ts="2026-01-04T00:00:00Z", version="v1.10", sel=0.8)
    _run(
        tmp_path,
        "other-set",
        ts="2026-01-05T00:00:00Z",
        version="v2.0",
        fixture_set="set-b",
        sel=0.9,
    )
    _run(
        tmp_path, "other-model", ts="2026-01-06T00:00:00Z", version="v2.0", model="model-y", sel=0.9
    )
    _run(
        tmp_path,
        "other-family",
        ts="2026-01-07T00:00:00Z",
        family="beta_gate",
        version="v9.0",
        sel=0.9,
    )
    rows = {r["run_id"]: r for r in er.scan(tmp_path)["runs"]}
    assert rows["a"]["delta"] is None
    assert rows["b"]["delta"] == {
        "vs_version": "v1.0",
        "vs_run_id": "a",
        "selection": 0.1,
        "stress": None,
    }
    assert rows["c"]["delta"]["vs_version"] == "v1.2"  # natural order: v1.10 > v1.2
    assert rows["c"]["delta"]["vs_run_id"] == "b2"  # the latest run of that version
    assert rows["c"]["delta"]["selection"] == pytest.approx(0.1)
    assert rows["other-set"]["delta"] is None
    assert rows["other-model"]["delta"] is None
    assert rows["other-family"]["delta"] is None


def test_natural_key():
    assert sorted(["v1.10", "v1.2", "v1.0", "v2"], key=er.natural_key) == [
        "v1.0",
        "v1.2",
        "v1.10",
        "v2",
    ]
    assert sorted(["v2_3", "v2", "v2_1", "v1b", "v1a"], key=er.natural_key) == [
        "v1a",
        "v1b",
        "v2",
        "v2_1",
        "v2_3",
    ]


def test_detail_shape(tmp_path):
    results = [
        {
            "fixture_id": "fx-001",
            "type": "selection",
            "threat_category": None,
            "actual_output": {"verdict": "keep", "reasoning": "r"},
            "expected_output": {"verdict": "keep"},
            "verdict": "?",
            "error": None,
            "from_cache": True,
            "input_tokens": 10,
            "output_tokens": 2,
            "cost_usd": 0.001,
            "latency_ms": 120.0,
            "raw_response": "x" * 9000,
        },
        {
            "fixture_id": "fx-002",
            "type": "stress",
            "threat_category": "threat-a",
            "actual_output": {"verdict": "keep", "score": float("nan")},
            "expected_output": {"verdict": "drop"},
            "error": None,
            "from_cache": False,
            "raw_response": "y",
        },
        {
            "fixture_id": "fx-003",
            "type": "stress",
            "threat_category": "threat-b",
            "actual_output": "not a dict",
            "expected_output": {"verdict": "drop"},
            "error": "timeout",
            "raw_response": None,
        },
        "not a dict",
    ]
    _run(tmp_path, "run-1", sel=0.5, stress=0.4, results=results, notes="a note")
    d = er.load_detail(tmp_path, "run-1")
    assert d["run_id"] == "run-1" and d["fixture_version"] == "fv1" and d["git_sha"] == "abc1234def"
    assert d["notes"] == "a note" and d["totals"]["llm_calls"] == 10
    assert set(d["metrics"]) == {"selection", "stress"}
    assert d["metrics"]["stress"]["per_threat_recall"] == {"threat-b": 0.95, "threat-a": 0.4}
    assert d["metrics"]["selection"]["confusion"]["keep"] == {"keep": 3, "drop": 1}
    assert d["metrics"]["selection"]["per_class"]["keep"]["tp"] == 3
    assert [f["status"] for f in d["fixtures"]] == ["correct", "wrong", "error"]
    assert d["fixtures_total"] == 3
    f1, f2, f3 = d["fixtures"]
    assert f1["expected"] == "keep" and f1["actual"] == "keep" and f1["from_cache"] is True
    assert len(f1["detail"]["raw_response"]) < 9000 and f1["detail"]["raw_response"].endswith(
        "…(truncated)"
    )
    assert f2["detail"]["actual_output"]["score"] is None  # NaN cleaned
    assert f3["actual"] is None and f3["error"] == "timeout"
    blob = json.dumps(d, allow_nan=False)  # raises if any NaN survived
    assert (
        "SECRET PROMPT TEXT" not in blob
        and "config_hash" not in blob
        and "cost_weights" not in blob
    )


def test_fixture_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(er, "MAX_FIXTURES", 2)
    items = [
        {
            "fixture_id": f"fx-{i}",
            "actual_output": {"verdict": "a"},
            "expected_output": {"verdict": "a"},
        }
        for i in range(5)
    ]
    _run(tmp_path, "run-cap", results=items)
    d = er.load_detail(tmp_path, "run-cap")
    assert len(d["fixtures"]) == 2 and d["fixtures_total"] == 5


def test_find_run_refuses(tmp_path):
    _run(tmp_path, "run-1")
    outside = tmp_path.parent / f"{tmp_path.name}-sibling"
    outside.mkdir()
    _run(outside, "secret-run")
    os.symlink(outside / "secret-run", tmp_path / "via-link")
    assert er.find_run(tmp_path, "run-1") == str(tmp_path / "run-1")
    for bad in [
        "",
        ".",
        "..",
        "../x",
        "a/b",
        f"../{outside.name}/secret-run",
        "via-link",
        ".hidden",
        "unknown",
        "run-1/../run-1",
        "x" * 201,
    ]:
        assert er.find_run(tmp_path, bad) is None, bad
        assert er.load_detail(tmp_path, bad) is None, bad


def test_count_helper():
    assert er._count(3) == 3
    assert er._count(3.0) == 3 and isinstance(er._count(3.0), int)
    assert er._count(2.5) is None
    assert er._count(True) is None
    assert er._count(float("nan")) is None
    assert er._count(float("inf")) is None
    assert er._count("3") is None
    assert er._count(None) is None


def test_float_counts_are_read_as_integers(tmp_path):
    m = _metric(0.5)
    m.update({"n_fixtures": 10.0, "n_correct": 5.0, "n_wrong": 4.0, "n_errored": 1.0})
    m["confusion"] = {"keep": {"keep": 3.0, "drop": 1.5}, "drop": {"keep": 0.0, "drop": 6.0}}
    m["per_class"] = {
        "keep": {"tp": 3.0, "fp": 2.5, "fn": 0.0, "precision": 0.75, "recall": 1.0, "f1": 0.857}
    }
    d = _run(
        tmp_path,
        "r1",
        results=[{"fixture_id": "fx-1", "input_tokens": 10.0, "output_tokens": 2.5}],
    )
    data = json.loads((d / "run.json").read_text())
    data["metrics"]["selection"] = m
    data["totals"].update({"llm_calls": 10.0, "cache_hits": 2.0, "cache_misses": 8.0})
    data["type_counts"] = {"selection": 10.0, "stress": 1.5}
    (d / "run.json").write_text(json.dumps(data), encoding="utf-8")

    row = er.scan(tmp_path)["runs"][0]
    assert row["selection"]["n"] == 10
    assert row["cache_hits"] == 2 and row["cache_misses"] == 8
    detail = er.load_detail(tmp_path, "r1")
    sel = detail["metrics"]["selection"]
    assert (sel["n_fixtures"], sel["n_correct"], sel["n_wrong"], sel["n_errored"]) == (10, 5, 4, 1)
    assert sel["per_class"]["keep"]["tp"] == 3
    assert sel["per_class"]["keep"]["fp"] is None
    assert sel["per_class"]["keep"]["fn"] == 0
    assert sel["confusion"]["keep"] == {"keep": 3}
    assert sel["confusion"]["drop"] == {"keep": 0, "drop": 6}
    assert detail["totals"]["llm_calls"] == 10
    assert detail["type_counts"] == {"selection": 10}
    fx = detail["fixtures"][0]
    assert fx["input_tokens"] == 10 and fx["output_tokens"] is None
