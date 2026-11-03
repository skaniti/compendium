"""Claude rows in llm_service.MODEL_PRICING must equal the vendored backend/prices.json."""
import json
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parent.parent / "backend"
_PRICES = json.loads((_BACKEND / "prices.json").read_text())["models"]

# Dated ids the table carries -> canonical prices.json id.
_ALIASES = {
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
    "claude-sonnet-4-5-20250514": "claude-sonnet-4-5",
}


def _claude_rows():
    from backend.services.llm_service import MODEL_PRICING

    return [m for m in MODEL_PRICING if m.startswith("claude-")]


def test_prices_json_sits_inside_backend():
    # Dockerfile does `COPY . .` from apps/api, so backend/ rides into the image.
    assert (_BACKEND / "prices.json").is_file()
    assert (_BACKEND / "prices.json.sha256").is_file()
    dockerignore = (_BACKEND.parent / ".dockerignore").read_text()
    assert "*.json" not in dockerignore
    assert "prices" not in dockerignore


def test_per_1k_aliases():
    from backend.services.claude_prices import per_1k

    t = per_1k(aliases=_ALIASES)
    assert t["claude-haiku-4-5-20251001"] == t["claude-haiku-4-5"]
    assert t["claude-haiku-5-5"]["input"] == pytest.approx(0.0001)
    assert set(_PRICES) <= set(t)


def test_per_1k_unknown_alias_message():
    from backend.services.claude_prices import per_1k

    with pytest.raises(KeyError, match="nope"):
        per_1k(aliases={"x": "nope"})


def test_per_1k_missing_file_names_path(monkeypatch, tmp_path):
    from backend.services import claude_prices

    missing = tmp_path / "prices.json"
    monkeypatch.setattr(claude_prices, "PRICES_PATH", missing)
    with pytest.raises(FileNotFoundError, match="prices.json"):
        claude_prices.per_1k()


def test_llm_service_has_claude_rows():
    assert _claude_rows()


@pytest.mark.parametrize("model_id", _claude_rows())
def test_llm_service_claude_row_matches_prices_json(model_id):
    from backend.services.llm_service import MODEL_PRICING

    canon = _PRICES[_ALIASES.get(model_id, model_id)]
    assert MODEL_PRICING[model_id]["input"] == pytest.approx(canon["input"] / 1000)
    assert MODEL_PRICING[model_id]["output"] == pytest.approx(canon["output"] / 1000)


def test_llm_service_has_every_prices_json_claude_model():
    from backend.services.llm_service import MODEL_PRICING

    missing = [m for m in _PRICES if m.startswith("claude-") and m not in MODEL_PRICING]
    assert not missing


def test_estimate_cost_finds_haiku_5_5(monkeypatch):
    from backend.config.settings import settings
    from backend.services import page_labeller

    monkeypatch.setattr(settings, "label_model", "claude-haiku-5-5")
    est = page_labeller.estimate_cost(10)
    assert est["usd_list"] > 0
