"""Evaluation-harness runs for the Prompts dev view (admins only, not viewing as demo).

Runs live in ``settings.eval_runs_dir`` (env ``EVAL_RUNS_DIR``): a directory
outside the repo holding ``<run_id>/run.json`` files written by the
evaluation harness. Hosted deployments have none. A run's fixtures can carry
browsing-derived text, so nothing here is ever copied into a tracked file, and
the routes serve it to admins only, never to a demo session (view-as included).

Path safety: a run id is only ever matched against the names ``os.scandir``
returns for that directory -- a client string is never joined into a path --
and symlinked entries are refused.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
from pathlib import Path

RUN_FILE = "run.json"
MAX_RUN_BYTES = 20 * 1024 * 1024
RAW_RESPONSE_CHARS = 8000
MAX_FIXTURES = 1000
RUN_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$"
METRIC_TYPES = ("selection", "stress")

_RUN_ID_RE = re.compile(RUN_ID_PATTERN)
_TRUNCATED = "…(truncated)"


def natural_key(text: str) -> tuple:
    """Sort key that orders digit runs numerically: v1.2 < v1.10, v2 < v2_1."""
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in re.split(r"(\d+)", text) if p)


def runs_dir() -> Path | None:
    from backend.config.settings import settings

    configured = (settings.eval_runs_dir or "").strip()
    return Path(configured).expanduser() if configured else None


def status() -> dict:
    root = runs_dir()
    return {"configured": root is not None, "readable": bool(root is not None and root.is_dir())}


def _num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def _count(v):
    """A count: an int, or an integral finite float (JSON writers emit 3.0); else None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    return None


def _str(v):
    return v if isinstance(v, str) else None


def _dict(v) -> dict:
    return v if isinstance(v, dict) else {}


def _clean(v, depth: int = 0):
    """JSON-safe copy: non-finite floats -> None, nesting capped."""
    if depth > 20:
        return None
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): _clean(x, depth + 1) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x, depth + 1) for x in v]
    if v is None or isinstance(v, (str, int, bool)):
        return v
    return str(v)


def _entries(root: Path) -> list[os.DirEntry]:
    """Real (non-symlink) run directories with a well-formed id."""
    try:
        with os.scandir(root) as it:
            return [e for e in it if e.is_dir(follow_symlinks=False) and _RUN_ID_RE.match(e.name)]
    except OSError:
        return []


def _load(dir_path: str) -> dict | None:
    """``run.json`` under a run directory: a regular file within the size cap
    that parses to an object, else None."""
    path = os.path.join(dir_path, RUN_FILE)
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_RUN_BYTES:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _score(metrics: dict, kind: str) -> dict | None:
    m = metrics.get(kind)
    if not isinstance(m, dict):
        return None
    return {"accuracy": _num(m.get("accuracy")), "n": _count(m.get("n_fixtures"))}


def _row(run_id: str, data: dict) -> dict:
    metrics = _dict(data.get("metrics"))
    totals = _dict(data.get("totals"))
    return {
        "run_id": run_id,
        "timestamp": _str(data.get("timestamp")),
        "prompt_name": _str(data.get("prompt_name")),
        "prompt_version": _str(data.get("prompt_version")),
        "fixture_set": _str(data.get("fixture_set_label")),
        "model": _str(data.get("model")),
        "selection": _score(metrics, "selection"),
        "stress": _score(metrics, "stress"),
        "cost_usd": _num(totals.get("cost_usd")),
        "wall_time_s": _num(totals.get("wall_time_s")),
        "cache_hits": _count(totals.get("cache_hits")),
        "cache_misses": _count(totals.get("cache_misses")),
        "delta": None,
    }


def scan(root: Path) -> dict:
    rows: list[dict] = []
    skipped = 0
    for entry in _entries(root):
        if not os.path.lexists(os.path.join(entry.path, RUN_FILE)):
            continue
        data = _load(entry.path)
        if data is None:
            skipped += 1
            continue
        rows.append(_row(entry.name, data))
    rows.sort(key=lambda r: r["run_id"], reverse=True)
    rows.sort(key=lambda r: (r["timestamp"] is not None, r["timestamp"] or ""), reverse=True)
    attach_deltas(rows)
    return {"runs": rows, "skipped": skipped}


def _acc(row: dict, kind: str):
    score = row.get(kind)
    return score.get("accuracy") if score else None


def _diff(a, b):
    return round(a - b, 4) if a is not None and b is not None else None


def attach_deltas(rows: list[dict]) -> None:
    """vs previous: the latest run of the immediately preceding version (natural
    order) of the same family, on the same fixture set and model (spec R15)."""
    for row in rows:
        if not row["prompt_name"] or not row["prompt_version"]:
            continue
        mine = natural_key(row["prompt_version"])
        earlier = [
            r
            for r in rows
            if r is not row
            and r["prompt_name"] == row["prompt_name"]
            and r["fixture_set"] == row["fixture_set"]
            and r["model"] == row["model"]
            and r["prompt_version"]
            and natural_key(r["prompt_version"]) < mine
        ]
        if not earlier:
            continue
        prev_key = max(natural_key(r["prompt_version"]) for r in earlier)
        prev = max(
            (r for r in earlier if natural_key(r["prompt_version"]) == prev_key),
            key=lambda r: (r["timestamp"] or "", r["run_id"]),
        )
        row["delta"] = {
            "vs_version": prev["prompt_version"],
            "vs_run_id": prev["run_id"],
            "selection": _diff(_acc(row, "selection"), _acc(prev, "selection")),
            "stress": _diff(_acc(row, "stress"), _acc(prev, "stress")),
        }


def find_run(root: Path, run_id: str) -> str | None:
    """The directory of ``run_id``, matched against a listing of ``root``."""
    if not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id):
        return None
    for entry in _entries(root):
        if entry.name == run_id:
            return entry.path
    return None


def _counts(v) -> dict:
    out = {}
    for pred, row in _dict(v).items():
        if isinstance(pred, str) and isinstance(row, dict):
            out[pred] = {
                exp: n for exp, n in row.items() if isinstance(exp, str) and _count(n) is not None
            }
    return out


def _per_class(v) -> dict:
    out = {}
    for cls, d in _dict(v).items():
        if isinstance(cls, str) and isinstance(d, dict):
            out[cls] = {
                **{k: _count(d.get(k)) for k in ("tp", "fp", "fn")},
                **{k: _num(d.get(k)) for k in ("precision", "recall", "f1")},
            }
    return out


def _metric(m: dict) -> dict:
    return {
        "accuracy": _num(m.get("accuracy")),
        "n_fixtures": _count(m.get("n_fixtures")),
        "n_correct": _count(m.get("n_correct")),
        "n_wrong": _count(m.get("n_wrong")),
        "n_errored": _count(m.get("n_errored")),
        "confusion": _counts(m.get("confusion")),
        "per_class": _per_class(m.get("per_class")),
        "per_threat_recall": {
            k: _num(v)
            for k, v in _dict(m.get("per_threat_recall")).items()
            if isinstance(k, str) and _num(v) is not None
        },
        "cost_weighted_scalar": _num(m.get("cost_weighted_scalar")),
    }


def _verdict(output) -> str | None:
    return _str(output.get("verdict")) if isinstance(output, dict) else None


def _fixture(item: dict) -> dict:
    actual, expected = item.get("actual_output"), item.get("expected_output")
    a, e = _verdict(actual), _verdict(expected)
    error = item.get("error")
    status = "error" if error else ("correct" if a is not None and a == e else "wrong")
    raw = _str(item.get("raw_response"))
    if raw is not None and len(raw) > RAW_RESPONSE_CHARS:
        raw = raw[:RAW_RESPONSE_CHARS] + _TRUNCATED
    from_cache = item.get("from_cache")
    return {
        "fixture_id": _str(item.get("fixture_id")),
        "type": _str(item.get("type")),
        "threat_category": _str(item.get("threat_category")),
        "expected": e,
        "actual": a,
        "status": status,
        "error": str(error) if error else None,
        "from_cache": from_cache if isinstance(from_cache, bool) else None,
        "cost_usd": _num(item.get("cost_usd")),
        "latency_ms": _num(item.get("latency_ms")),
        "input_tokens": _count(item.get("input_tokens")),
        "output_tokens": _count(item.get("output_tokens")),
        "detail": {
            "actual_output": _clean(actual),
            "expected_output": _clean(expected),
            "raw_response": raw,
        },
    }


def load_detail(root: Path, run_id: str) -> dict | None:
    path = find_run(root, run_id)
    if path is None:
        return None
    data = _load(path)
    if data is None:
        return None
    row = _row(run_id, data)
    metrics = _dict(data.get("metrics"))
    totals = _dict(data.get("totals"))
    results = data.get("results") if isinstance(data.get("results"), list) else []
    items = [r for r in results if isinstance(r, dict)]
    return {
        "run_id": run_id,
        "timestamp": row["timestamp"],
        "prompt_name": row["prompt_name"],
        "prompt_version": row["prompt_version"],
        "fixture_set": row["fixture_set"],
        "fixture_version": _str(data.get("fixture_version")),
        "model": row["model"],
        "git_sha": _str(data.get("git_sha")),
        "notes": _str(data.get("notes")),
        "totals": {
            "cost_usd": row["cost_usd"],
            "wall_time_s": row["wall_time_s"],
            "llm_calls": _count(totals.get("llm_calls")),
            "cache_hits": row["cache_hits"],
            "cache_misses": row["cache_misses"],
        },
        "type_counts": {
            k: v
            for k, v in _dict(data.get("type_counts")).items()
            if isinstance(k, str) and _count(v) is not None
        },
        "metrics": {
            k: _metric(metrics[k]) for k in METRIC_TYPES if isinstance(metrics.get(k), dict)
        },
        "fixtures": [_fixture(i) for i in items[:MAX_FIXTURES]],
        "fixtures_total": len(items),
    }
