"""Per-1K-token Claude prices derived from the vendored ``backend/prices.json``.

prices.json ($ per MTok) is the canonical table; never edit it here. Rows are
divided by 1000 to match the per-1K ``MODEL_PRICING`` table in ``llm_service``.
"""
from __future__ import annotations

import json
from pathlib import Path

PRICES_PATH = Path(__file__).resolve().parents[1] / "prices.json"


def per_1k(aliases: dict[str, str] | None = None) -> dict[str, dict[str, float]]:
    """``{model_id: {"input": usd/1K, "output": usd/1K}}`` for every model in
    prices.json, plus ``aliases`` (``{dated_id: canonical_id}``) as extra rows."""
    try:
        models = json.loads(PRICES_PATH.read_text(encoding="utf-8"))["models"]
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"prices.json not found at {PRICES_PATH} (backend/ must carry prices.json)"
        ) from exc
    table = {
        mid: {"input": row["input"] / 1000, "output": row["output"] / 1000}
        for mid, row in models.items()
    }
    for alias, canonical in (aliases or {}).items():
        if canonical not in table:
            raise KeyError(f"alias {alias!r} -> {canonical!r}: {canonical!r} not in {PRICES_PATH}")
        table[alias] = dict(table[canonical])
    return table
