"""Owner gateway identity helper (owner-gateway, Task 1)."""
import http.client
import importlib.util
import json
import subprocess
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/server/owner-gateway/whois_auth.py"
spec = importlib.util.spec_from_file_location("whois_auth", SCRIPT)
wa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa)

USER = {"Node": {"ComputedName": "laptop", "Tags": None}, "UserProfile": {"LoginName": "owner@example.test"}}
TAGGED = {"Node": {"ComputedName": "server", "Tags": ["tag:server"]}, "UserProfile": {"LoginName": "tagged-devices"}}


class FakeWhois:
    def __init__(self, answers):
        self.answers = answers  # ip -> dict | Exception
        self.calls = []

    def __call__(self, ip):
        self.calls.append(ip)
        a = self.answers.get(ip)
        if isinstance(a, Exception):
            raise a
        return a


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.mark.parametrize("raw,expected", [
    ("100.64.0.5", "100.64.0.5"),
    (" 100.127.255.1 ", "100.127.255.1"),
    ("fd7a:115c:a1e0::5", "fd7a:115c:a1e0::5"),
    ("127.0.0.1", None),
    ("198.51.100.10", None),
    ("100.128.0.1", None),
    ("fd7a:115c:a1e1::5", None),
    ("not-an-ip", None),
    ("", None),
    (None, None),
])
def test_tailnet_ip(raw, expected):
    assert wa.tailnet_ip(raw) == expected


@pytest.mark.parametrize("data,expected", [
    (USER, "owner@example.test"),
    (TAGGED, None),
    ({"Node": {}, "UserProfile": {}}, None),
    ({"UserProfile": {"LoginName": "owner@example.test"}}, None),
    ({"Node": None, "UserProfile": {"LoginName": "owner@example.test"}}, None),
    ({"Node": {"Tags": None}, "UserProfile": {"LoginName": "tagged-devices"}}, None),
    ({"Node": {}, "UserProfile": {"LoginName": "bad\r\nX-Evil: 1"}}, None),
    ({"Node": {}, "UserProfile": {"LoginName": "naïve@example.test"}}, None),
    ({"Node": {}, "UserProfile": {"LoginName": "a" * 321}}, None),
    ({"Node": {}, "UserProfile": {"LoginName": "  owner@example.test  "}}, "owner@example.test"),
    (None, None),
    ([], None),
])
def test_login_from_whois(data, expected):
    assert wa.login_from_whois(data) == expected


def test_resolver_returns_the_login_and_caches_for_60s():
    whois, clock = FakeWhois({"100.64.0.5": USER}), Clock()
    r = wa.Resolver(whois=whois, clock=clock)
    assert r.login_for("100.64.0.5") == "owner@example.test"
    clock.t += 59
    assert r.login_for("100.64.0.5") == "owner@example.test"
    assert whois.calls == ["100.64.0.5"]
    clock.t += 2
    r.login_for("100.64.0.5")
    assert whois.calls == ["100.64.0.5", "100.64.0.5"]


def test_resolver_caches_a_tagged_answer_as_no_identity():
    whois, clock = FakeWhois({"100.64.0.9": TAGGED}), Clock()
    r = wa.Resolver(whois=whois, clock=clock)
    assert r.login_for("100.64.0.9") is None
    assert r.login_for("100.64.0.9") is None
    assert whois.calls == ["100.64.0.9"]


def test_resolver_does_not_call_whois_for_non_tailnet_peers():
    whois = FakeWhois({})
    r = wa.Resolver(whois=whois, clock=Clock())
    assert r.login_for("127.0.0.1") is None
    assert r.login_for(None) is None
    assert whois.calls == []


@pytest.mark.parametrize("err", [
    subprocess.TimeoutExpired(cmd="tailscale", timeout=2),
    RuntimeError("tailscale whois exited 1"),
    json.JSONDecodeError("bad", "x", 0),
])
def test_resolver_failure_gives_no_identity_and_is_not_cached(err):
    whois = FakeWhois({"100.64.0.5": err})
    r = wa.Resolver(whois=whois, clock=Clock())
    assert r.login_for("100.64.0.5") is None
    whois.answers["100.64.0.5"] = USER
    assert r.login_for("100.64.0.5") == "owner@example.test"
    assert whois.calls == ["100.64.0.5", "100.64.0.5"]


def test_run_whois_uses_no_shell_and_a_timeout(monkeypatch):
    seen = {}

    def fake_run(args, **kw):
        seen["args"], seen["kw"] = args, kw
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(USER), stderr="")

    monkeypatch.setattr(wa.subprocess, "run", fake_run)
    assert wa.run_whois("100.64.0.5") == USER
    assert seen["args"] == ["tailscale", "whois", "--json", "100.64.0.5"]
    assert seen["kw"].get("timeout") == 2.0
    assert "shell" not in seen["kw"] or seen["kw"]["shell"] is False


def test_run_whois_raises_on_nonzero_exit(monkeypatch):
    monkeypatch.setattr(
        wa.subprocess, "run",
        lambda args, **kw: subprocess.CompletedProcess(args, 1, stdout="", stderr="no such peer"),
    )
    with pytest.raises(RuntimeError):
        wa.run_whois("100.64.0.5")


@pytest.fixture
def server():
    whois = FakeWhois({"100.64.0.5": USER, "100.64.0.9": TAGGED})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), wa.make_handler(wa.Resolver(whois=whois)))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield httpd.server_address[1]
    httpd.shutdown()


def _get(port, peer=None, method="GET"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"X-Compendium-Peer": peer} if peer is not None else {}
    c.request(method, "/whois", headers=headers)
    r = c.getresponse()
    r.read()
    return r.status, r.getheader("Tailscale-User-Login")


def test_handler_answers_200_with_the_login(server):
    assert _get(server, "100.64.0.5") == (200, "owner@example.test")


@pytest.mark.parametrize("peer", ["100.64.0.9", "127.0.0.1", None, "garbage"])
def test_handler_answers_200_without_a_login(server, peer):
    assert _get(server, peer) == (200, None)


@pytest.mark.parametrize("method", ["HEAD", "POST"])
def test_handler_accepts_other_methods(server, method):
    assert _get(server, "100.64.0.5", method=method)[0] == 200
