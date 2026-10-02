"""Override store: validation messages, atomic writes, never the tracked file."""

import json
import os

import pytest

from backend.config.settings import settings
from backend.prompts import override_store as store
from backend.prompts import templates

NAME = "page_summary_v1"  # fills {title} and {content}
REGISTRY = templates.PROMPTS[NAME]["template"]


@pytest.fixture
def ofile(monkeypatch, tmp_path):
    f = tmp_path / "overrides.json"
    monkeypatch.setattr(settings, "prompt_overrides_path", str(f))
    return f


def test_template_fields():
    assert store.template_fields("a {title} {{lit}} {content} {title}") == ["content", "title"]
    with pytest.raises(ValueError):
        store.template_fields("a { b")


@pytest.mark.parametrize(
    "text, message",
    [
        ("", "The template is empty."),
        ("  \n ", "The template is empty."),
        ("x" * 32_001, "The template is longer than 32,000 characters."),
        ("{title} {", "The template has unbalanced braces ("),
        ("{title} }", "The template has unbalanced braces ("),
        (
            "{nope}",
            "Unknown placeholder {nope}. page_summary_v1 is filled with: {content}, {title}.",
        ),
        ("{}", "Unknown placeholder {}."),
        ("{0}", "Unknown placeholder {0}."),
        ("{title.upper}", "Unknown placeholder {title.upper}."),
        ("{title:{nope}}", "The template can't be filled ("),
        ("{title!x}", "The template can't be filled ("),
        ("{title:d}", "The template can't be filled ("),
        ("{title:{content[x]}}", "The template can't be filled ("),
    ],
)
def test_validate_messages(text, message):
    with pytest.raises(store.InvalidTemplate) as exc:
        store.validate(NAME, text)
    assert str(exc.value).startswith(message)


def test_unbalanced_message_says_how_to_escape():
    with pytest.raises(store.InvalidTemplate) as exc:
        store.validate(NAME, "{")
    assert str(exc.value).endswith("Write a literal brace as {{ or }}.")


def test_no_placeholder_prompt_lists_none():
    with pytest.raises(store.InvalidTemplate) as exc:
        store.validate("agent_system_v1", "hi {x}")
    assert str(exc.value).endswith("agent_system_v1 is filled with: no placeholders.")


def test_validate_returns_missing_and_allows_literals():
    assert store.validate(NAME, "only {title} and {{json}}") == ["content"]
    assert store.validate(NAME, "{title!r} {content}") == []


def test_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "prompt_overrides_path", "")
    assert store.configured() is False
    assert store.status() == {"configured": False, "readable": True, "count": 0}
    with pytest.raises(store.OverridesNotConfigured):
        store.save(NAME, "x {title} {content}")
    with pytest.raises(store.OverridesNotConfigured):
        store.reset(NAME)


def test_save_clear_reset_round_trip(ofile):
    assert store.status() == {"configured": True, "readable": True, "count": 0}
    assert store.save(NAME, "NEW {title}") == {
        "cleared": False,
        "missing_placeholders": ["content"],
    }
    assert json.loads(ofile.read_text(encoding="utf-8")) == {NAME: "NEW {title}"}
    assert ofile.read_text(encoding="utf-8").endswith("\n")
    assert store.status()["count"] == 1
    assert store.save(NAME, REGISTRY) == {"cleared": True, "missing_placeholders": []}
    assert json.loads(ofile.read_text(encoding="utf-8")) == {}
    store.save(NAME, "AGAIN {title} {content}")
    assert store.reset(NAME) is True
    assert store.reset(NAME) is False
    assert json.loads(ofile.read_text(encoding="utf-8")) == {}


def test_save_reaches_get_prompt(ofile):
    store.save(NAME, "LIVE {title} / {content}")
    assert templates.get_prompt(NAME, title="T", content="C") == "LIVE T / C"
    assert templates.get_prompt_template(NAME) == "LIVE {title} / {content}"


def test_atomic_write_leaves_no_temp_files(ofile):
    store.save(NAME, "A {title}")
    store.save("page_summary_v2", "B {title} {content}")
    assert sorted(p.name for p in ofile.parent.iterdir()) == ["overrides.json"]


@pytest.mark.parametrize("content", ["{not json", "[]", '{"page_summary_v1": 3}'])
def test_unreadable_file_is_never_clobbered(ofile, content):
    ofile.write_text(content, encoding="utf-8")
    assert store.status() == {"configured": True, "readable": False, "count": 0}
    with pytest.raises(store.OverrideFileUnreadable):
        store.save(NAME, "x {title}")
    with pytest.raises(store.OverrideFileUnreadable):
        store.reset(NAME)
    assert ofile.read_text(encoding="utf-8") == content


def test_missing_parent_directory_raises_oserror(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "prompt_overrides_path", str(tmp_path / "nope" / "o.json"))
    with pytest.raises(OSError):
        store.save(NAME, "x {title}")


def test_tracked_file_untouched(ofile):
    before = templates._OVERRIDES_PATH.read_bytes()
    store.save(NAME, "x {title}")
    store.reset(NAME)
    assert templates._OVERRIDES_PATH.read_bytes() == before
    assert ofile != templates._OVERRIDES_PATH


def test_new_file_is_private(ofile):
    store.save(NAME, "x {title}")
    assert oct(os.stat(ofile).st_mode & 0o777) == "0o600"
