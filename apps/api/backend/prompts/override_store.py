"""Prompt overrides for the Prompts dev view's editor.

The override file is ``settings.prompt_overrides_path`` (env
``PROMPT_OVERRIDES_PATH``): a JSON object mapping a registry prompt name to
its override template, kept outside the repo. ``templates._load_overrides``
reads the same file on every LLM call, so a save takes effect on the next
call. Nothing here writes the tracked ``backend/prompts/overrides.json``:
with the setting unset, every write raises ``OverridesNotConfigured``.

Writes are validated (non-empty, size cap, balanced braces, only the
registry template's placeholders, and the text must fill with every
registry placeholder) and atomic (temp file in the same
directory, fsync, ``os.replace``) under a process lock. An existing file
that does not parse is never overwritten.
"""

from __future__ import annotations

import contextlib
import json
import os
import string
import tempfile
import threading
from pathlib import Path

from backend.prompts import templates

MAX_TEMPLATE_CHARS = 32_000

_lock = threading.Lock()


class OverridesNotConfigured(Exception):
    """PROMPT_OVERRIDES_PATH is unset on this deployment."""


class OverrideFileUnreadable(Exception):
    """The override file exists but is not a JSON object of strings."""


class InvalidTemplate(ValueError):
    """The submitted template fails validation; the message is shown verbatim."""


def template_fields(text: str) -> list[str]:
    """Sorted unique placeholder names in ``text``; ValueError when malformed."""
    return sorted({field for _, field, _, _ in string.Formatter().parse(text) if field is not None})


def configured() -> bool:
    from backend.config.settings import settings

    return bool((settings.prompt_overrides_path or "").strip())


def _path() -> Path:
    if not configured():
        raise OverridesNotConfigured()
    return templates._overrides_path()


def _read_strict(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise OverrideFileUnreadable(str(exc)) from exc
    if not isinstance(data, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in data.items()
    ):
        raise OverrideFileUnreadable("not a JSON object of strings")
    return data


def status() -> dict:
    if not configured():
        return {"configured": False, "readable": True, "count": 0}
    try:
        data = _read_strict(templates._overrides_path())
    except OverrideFileUnreadable:
        return {"configured": True, "readable": False, "count": 0}
    return {"configured": True, "readable": True, "count": sum(1 for v in data.values() if v)}


def validate(name: str, text: str) -> list[str]:
    """Raise InvalidTemplate, or return the registry placeholders ``text`` leaves out."""
    if not text.strip():
        raise InvalidTemplate("The template is empty.")
    if len(text) > MAX_TEMPLATE_CHARS:
        raise InvalidTemplate(f"The template is longer than {MAX_TEMPLATE_CHARS:,} characters.")
    try:
        fields = template_fields(text)
    except ValueError as exc:
        raise InvalidTemplate(
            f"The template has unbalanced braces ({exc}). Write a literal brace as {{{{ or }}}}."
        ) from exc
    allowed = template_fields(templates.PROMPTS[name]["template"])
    unknown = [f for f in fields if f not in allowed]
    if unknown:
        listed = ", ".join("{" + f + "}" for f in allowed) or "no placeholders"
        raise InvalidTemplate(
            f"Unknown placeholder {{{unknown[0]}}}. {name} is filled with: {listed}."
        )
    try:
        text.format(**{f: "" for f in allowed})
    except (ValueError, KeyError, IndexError, AttributeError, TypeError) as exc:
        raise InvalidTemplate(f"The template can't be filled ({exc}).") from exc
    return [f for f in allowed if f not in fields]


def _write(path: Path, data: dict[str, str]) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def save(name: str, text: str) -> dict:
    """Store ``text`` as ``name``'s override; text equal to the registry clears it."""
    path = _path()
    missing = validate(name, text)
    cleared = text == templates.PROMPTS[name]["template"]
    with _lock:
        data = _read_strict(path)
        if cleared:
            data.pop(name, None)
        else:
            data[name] = text
        _write(path, data)
    return {"cleared": cleared, "missing_placeholders": [] if cleared else missing}


def reset(name: str) -> bool:
    """Remove ``name``'s override; False when there was none."""
    path = _path()
    with _lock:
        data = _read_strict(path)
        if name not in data:
            return False
        del data[name]
        _write(path, data)
    return True
