"""The registry reads overrides from settings.prompt_overrides_path when set (a
deployment-local file outside the repo), else from the tracked overrides.json,
which stays empty so no override can ride into public history."""

import json

from backend.config.settings import settings
from backend.prompts import templates

REGISTRY = templates.PROMPTS["page_summary_v1"]["template"]


def test_unset_reads_the_tracked_file(monkeypatch):
    monkeypatch.setattr(settings, "prompt_overrides_path", "")
    assert templates._overrides_path() == templates._OVERRIDES_PATH


def test_whitespace_setting_counts_as_unset(monkeypatch):
    monkeypatch.setattr(settings, "prompt_overrides_path", "   ")
    assert templates._overrides_path() == templates._OVERRIDES_PATH


def test_tracked_file_stays_empty():
    assert json.loads(templates._OVERRIDES_PATH.read_text(encoding="utf-8")) == {}


def test_configured_file_wins(monkeypatch, tmp_path):
    f = tmp_path / "overrides.json"
    f.write_text(json.dumps({"page_summary_v1": "OVERRIDE {title} {content}"}), encoding="utf-8")
    monkeypatch.setattr(settings, "prompt_overrides_path", str(f))
    assert templates._overrides_path() == f
    assert templates.get_prompt_template("page_summary_v1") == "OVERRIDE {title} {content}"
    assert templates.get_prompt("page_summary_v1", title="T", content="C") == "OVERRIDE T C"


def test_configured_but_missing_is_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "prompt_overrides_path", str(tmp_path / "absent.json"))
    assert templates._load_overrides() == {}
    assert templates.get_prompt_template("page_summary_v1") == REGISTRY


def test_tilde_expands(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(settings, "prompt_overrides_path", "~/o.json")
    assert templates._overrides_path() == tmp_path / "o.json"


def test_monkeypatched_default_still_wins_when_unset(monkeypatch, tmp_path):
    f = tmp_path / "o.json"
    f.write_text(json.dumps({"page_summary_v1": "X {title} {content}"}), encoding="utf-8")
    monkeypatch.setattr(settings, "prompt_overrides_path", "")
    monkeypatch.setattr(templates, "_OVERRIDES_PATH", f)
    assert templates.get_prompt_template("page_summary_v1") == "X {title} {content}"
