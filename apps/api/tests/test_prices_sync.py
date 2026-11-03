"""Claude rows in llm_service.MODEL_PRICING must equal the vendored backend/prices.json."""
import fnmatch
import json
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parent.parent / "backend"
_PRICES = json.loads((_BACKEND / "prices.json").read_text())["models"]

from backend.services.llm_service import _CLAUDE_DATED_ALIASES as _ALIASES


def _claude_rows():
    from backend.services.llm_service import MODEL_PRICING

    return [m for m in MODEL_PRICING if m.startswith("claude-")]


def _dockerignore_excludes(text, rel_path):
    """Uncommented, non-negated patterns that would exclude ``rel_path``."""
    # Negations (!) are deliberately not honoured: a "*.json" + "!backend/prices.json"
    # pair trips the guard by design.
    hits = []
    name = rel_path.rsplit("/", 1)[-1]
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "!")):
            continue
        pat = line.rstrip("/")
        if pat.startswith("**/"):
            pat = pat[3:]
        if fnmatch.fnmatchcase(rel_path, pat) or fnmatch.fnmatchcase(name, pat):
            hits.append(line)
            continue
        if any(fnmatch.fnmatchcase("/".join(rel_path.split("/")[: i + 1]), pat)
               for i in range(len(rel_path.split("/")) - 1)):
            hits.append(line)
    return hits


@pytest.mark.parametrize(
    "text, expected",
    [
        ("# prices.json mentioned in a comment\n", []),
        ("*.log\ntests\n", []),
        ("*.json\n", ["*.json"]),
        ("backend/prices.json\n", ["backend/prices.json"]),
        ("**/prices.json\n", ["**/prices.json"]),
        ("backend\n", ["backend"]),
        ("!*.json\n# *.json\n", []),
    ],
)
def test_dockerignore_guard_matches_excluding_lines_only(text, expected):
    assert _dockerignore_excludes(text, "backend/prices.json") == expected


def test_prices_json_sits_inside_backend():
    # Dockerfile does `COPY . .` from apps/api, so backend/ rides into the image.
    assert (_BACKEND / "prices.json").is_file()
    assert (_BACKEND / "prices.json.sha256").is_file()
    dockerignore = (_BACKEND.parent / ".dockerignore").read_text()
    assert _dockerignore_excludes(dockerignore, "backend/prices.json") == []


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


def test_per_1k_malformed_json_names_path(monkeypatch, tmp_path):
    from backend.services import claude_prices

    bad = tmp_path / "prices.json"
    bad.write_text("{not json")
    monkeypatch.setattr(claude_prices, "PRICES_PATH", bad)
    with pytest.raises(ValueError, match="not valid JSON") as exc:
        claude_prices.per_1k()
    assert str(bad) in str(exc.value)
    assert "\n" not in str(exc.value)


def test_per_1k_missing_models_key_names_path(monkeypatch, tmp_path):
    from backend.services import claude_prices

    bad = tmp_path / "prices.json"
    bad.write_text('{"other": {}}')
    monkeypatch.setattr(claude_prices, "PRICES_PATH", bad)
    with pytest.raises(KeyError) as exc:
        claude_prices.per_1k()
    assert "models" in str(exc.value)
    assert str(bad) in str(exc.value)
