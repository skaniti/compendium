"""Unit tests for the Phase-1 mobile backlog replay script.

The transform must match SessionExporter.rewriteForBackend exactly:
replace only the FIRST "sessionId" key with "captureId".
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "replay_mobile_sessions",
    Path(__file__).resolve().parents[1] / "scripts" / "dev" / "replay_mobile_sessions.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def test_rewrite_replaces_only_first_session_id():
    raw = '{"sessionId": "x", "pages": [{"title": "sessionId mention"}]}'
    out = mod.rewrite_for_backend(raw)
    assert out.startswith('{"captureId"')
    assert "sessionId mention" in out


def test_rewrite_matches_app_behavior_on_real_shape():
    raw = '{\n  "sessionId": "2026-04-23_141530_abcdefghi_mobile",\n  "startedAt": "t"}'
    out = mod.rewrite_for_backend(raw)
    assert '"captureId"' in out
    assert '"sessionId"' not in out
