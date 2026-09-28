"""Unit tests for scripts/agent_regression.py (no network, no subprocess)."""

import json
import sys

import httpx
import pytest

from scripts import agent_regression as ar

SAMPLE = {
    "answer": "Guidance mixes scores. It also trades diversity for fidelity.",
    "sources": ["https://a.example/1", "https://a.example/2"],
    "tool_calls_made": [{"tool": "search_pages"}, {"tool": "get_page"}],
    "total_cost_usd": 0.0123,
}


def _write_fixtures(tmp_path, n=3):
    p = tmp_path / "index.json"
    p.write_text(
        json.dumps(
            [{"n": f"{i:02d}", "question": f"Q{i}?", "file": "x"} for i in range(1, n + 1)]
        )
    )
    return p


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_load_questions_preserves_order(tmp_path):
    qs = ar.load_questions(_write_fixtures(tmp_path))
    assert [q["n"] for q in qs] == ["01", "02", "03"]
    assert qs[1]["question"] == "Q2?"


def test_default_fixtures_path_exists():
    assert ar.DEFAULT_FIXTURES.name == "index.json"
    assert len(ar.load_questions(ar.DEFAULT_FIXTURES)) == 12


def test_first_sentence():
    assert ar.first_sentence("Hello  world.\nNext one.") == "Hello world."
    assert ar.first_sentence("no terminator") == "no terminator"
    assert len(ar.first_sentence("x" * 500)) == 160


def test_build_row_from_response():
    row = ar.build_row("01", SAMPLE, 3.14159, None)
    assert row["n"] == "01"
    assert row["tool_calls"] == 2
    assert row["tools"] == ["search_pages", "get_page"]
    assert row["sources"] == 2
    assert row["first_sentence"] == "Guidance mixes scores."
    assert row["answer_chars"] == len(SAMPLE["answer"])
    assert row["cost_usd"] == 0.0123
    assert row["latency_s"] == 3.1
    assert row["answer"] == SAMPLE["answer"]
    assert row["error"] is None


def test_verdict_rules():
    assert ar.verdict({"tool_calls": 1, "sources": 1, "error": None}) == "PASS"
    assert ar.verdict({"tool_calls": 0, "sources": 3, "error": None}) == "FAIL"
    assert ar.verdict({"tool_calls": 2, "sources": 0, "error": None}) == "FAIL"
    assert ar.verdict({"tool_calls": 2, "sources": 2, "error": "boom"}) == "FAIL"


def test_error_row_is_fail():
    row = ar.build_row("01", None, 1.0, "HTTP 500")
    assert row["error"] == "HTTP 500"
    assert ar.verdict(row) == "FAIL"


def test_reruns_once_on_transport_error(monkeypatch):
    monkeypatch.setattr(ar.time, "sleep", lambda s: None)
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        return httpx.Response(200, json=SAMPLE)

    row = ar.run_question(_client(handler), "http://x", "01", "Q?", None)
    assert len(calls) == 2
    assert row["error"] is None and row["tool_calls"] == 2


def test_transport_error_twice_gives_error_row(monkeypatch):
    monkeypatch.setattr(ar.time, "sleep", lambda s: None)
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ConnectError("down")

    row = ar.run_question(_client(handler), "http://x", "01", "Q?", None)
    assert len(calls) == 2
    assert row["error"]


def test_no_rerun_on_http_500():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(500, text="nope")

    row = ar.run_question(_client(handler), "http://x", "01", "Q?", None)
    assert len(calls) == 1
    assert row["error"].startswith("HTTP 500")


def test_request_shape_and_token():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=SAMPLE)

    ar.run_question(_client(handler), "http://x", "01", "Q?", "tok")
    assert seen["url"] == "http://x/api/agent/query"
    assert seen["auth"] == "Bearer tok"
    assert seen["body"] == {"query": "Q?"}


def test_pacing_between_calls_not_after_last(monkeypatch, tmp_path):
    sleeps = []
    monkeypatch.setattr(ar.time, "sleep", lambda s: sleeps.append(s))
    client = _client(lambda r: httpx.Response(200, json=SAMPLE))
    qs = ar.load_questions(_write_fixtures(tmp_path, 3))
    rows = ar.run_all(client, "http://x", qs, None, 7.0)
    assert len(rows) == 3
    assert sleeps == [7.0, 7.0]


def test_main_output_json_and_exit_zero(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(ar.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        ar, "_make_client", lambda: _client(lambda r: httpx.Response(200, json=SAMPLE))
    )
    out = tmp_path / "out.json"
    code = ar.main(
        [
            "--base-url", "http://x",
            "--fixtures", str(_write_fixtures(tmp_path, 2)),
            "--out", str(out),
            "--label", "t",
            "--pace-seconds", "0",
        ]
    )
    assert code == 0
    data = json.loads(out.read_text())
    assert set(data) == {"label", "base_url", "started_at", "rows", "passed", "failed"}
    assert data["label"] == "t" and data["base_url"] == "http://x"
    assert data["passed"] == 2 and data["failed"] == 0 and len(data["rows"]) == 2
    assert "done" in capsys.readouterr().out


def test_main_exit_one_on_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(ar.time, "sleep", lambda s: None)
    empty = {**SAMPLE, "sources": []}
    monkeypatch.setattr(
        ar, "_make_client", lambda: _client(lambda r: httpx.Response(200, json=empty))
    )
    code = ar.main(
        ["--base-url", "http://x", "--fixtures", str(_write_fixtures(tmp_path, 1)),
         "--pace-seconds", "0"]
    )
    assert code == 1


@pytest.mark.parametrize("port", [3000, 8001, 8765])
def test_spawn_refuses_reserved_ports(monkeypatch, port, capsys):
    def boom(*a, **k):
        raise AssertionError("Popen must not be called")

    monkeypatch.setattr(ar.subprocess, "Popen", boom)
    code = ar.main(["--spawn", "--port", str(port)])
    assert code == 2
    assert str(port) in capsys.readouterr().err


def test_spawn_with_base_url_rejected(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("Popen must not be called")

    monkeypatch.setattr(ar.subprocess, "Popen", boom)
    assert ar.main(["--spawn", "--base-url", "http://x"]) == 2


def test_child_env_keys(monkeypatch):
    monkeypatch.delenv("AGENT_SYSTEM_PROMPT_VERSION", raising=False)
    env = ar.build_child_env(8012, "demo@traversal.local", None)
    assert env["DEV_AUTH_BYPASS"] == "1"
    assert env["DEV_DEFAULT_USER_EMAIL"] == "demo@traversal.local"
    assert env["API_PORT"] == "8012"
    assert "AGENT_SYSTEM_PROMPT_VERSION" not in env


def test_child_env_prompt_version():
    env = ar.build_child_env(8012, "a@b.c", "v3")
    assert env["AGENT_SYSTEM_PROMPT_VERSION"] == "v3"


def test_spawn_popen_args_and_cleanup(monkeypatch, tmp_path):
    monkeypatch.setattr(ar.time, "sleep", lambda s: None)
    captured = {}

    class FakeProc:
        terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

        def kill(self):
            raise AssertionError("should not need SIGKILL")

    proc = FakeProc()

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw["env"]
        captured["cwd"] = kw["cwd"]
        return proc

    monkeypatch.setattr(ar.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(ar, "_wait_ready", lambda base, proc, timeout=60: True)
    monkeypatch.setattr(ar, "_port_free", lambda port: True)
    monkeypatch.setattr(
        ar, "_make_client", lambda: _client(lambda r: httpx.Response(200, json=SAMPLE))
    )
    code = ar.main(
        ["--spawn", "--port", "8012", "--fixtures", str(_write_fixtures(tmp_path, 1)),
         "--pace-seconds", "0"]
    )
    assert code == 0
    assert captured["cmd"][:3] == [sys.executable, "-m", "uvicorn"]
    assert captured["env"]["DEV_AUTH_BYPASS"] == "1"
    assert captured["cwd"] == str(ar.PROJECT_ROOT)
    assert "backend.api.main:app" in captured["cmd"]
    assert "8012" in captured["cmd"]
    assert proc.terminated


def test_spawn_not_ready_exits_2(monkeypatch):
    class FakeProc:
        terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

    proc = FakeProc()
    monkeypatch.setattr(ar.subprocess, "Popen", lambda *a, **k: proc)
    monkeypatch.setattr(ar, "_wait_ready", lambda base, proc, timeout=60: False)
    monkeypatch.setattr(ar, "_port_free", lambda port: True)
    assert ar.main(["--spawn", "--port", "8012"]) == 2
    assert proc.terminated


def test_child_death_detected_without_waiting(monkeypatch):
    slept = []
    monkeypatch.setattr(ar.time, "sleep", lambda s: slept.append(s))

    class DeadProc:
        def poll(self):
            return 1

        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 1

        def kill(self):
            pass

    monkeypatch.setattr(ar.subprocess, "Popen", lambda *a, **k: DeadProc())
    monkeypatch.setattr(ar, "_port_free", lambda port: True)
    assert ar.main(["--spawn", "--port", "8012"]) == 2
    assert slept == []


def test_spawn_port_in_use_exits_2_before_popen(monkeypatch, capsys):
    def boom(*a, **k):
        raise AssertionError("Popen must not be called")

    monkeypatch.setattr(ar.subprocess, "Popen", boom)
    monkeypatch.setattr(ar, "_port_free", lambda port: False)
    assert ar.main(["--spawn", "--port", "8012"]) == 2
    assert "in use" in capsys.readouterr().err


def test_malformed_200_is_fail():
    for body in ({"answer": "x"}, ["not", "a", "dict"]):
        row = ar.run_question(
            _client(lambda r, b=body: httpx.Response(200, json=b)), "http://x", "01", "Q?", None
        )
        assert row["error"].startswith("malformed response: missing")
        assert ar.verdict(row) == "FAIL"


def test_bad_fixtures_fails_before_spawn(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("Popen must not be called")

    monkeypatch.setattr(ar.subprocess, "Popen", boom)
    with pytest.raises(FileNotFoundError):
        ar.main(["--spawn", "--fixtures", str(tmp_path / "nope.json")])
