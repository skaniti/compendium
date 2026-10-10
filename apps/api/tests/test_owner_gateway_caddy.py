# apps/api/tests/test_owner_gateway_caddy.py
"""Owner gateway Caddy config (owner-gateway, Task 2).

The end-to-end tests run the real owner-app.caddy snippet in a local Caddy
on loopback, with a stub identity helper and an upstream that echoes the
headers it received. Skipped when no `caddy` binary is on PATH.
"""
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

GW = Path(__file__).resolve().parents[1] / "scripts/server/owner-gateway"
CADDY = shutil.which("caddy")
needs_caddy = pytest.mark.skipif(CADDY is None, reason="caddy binary not installed")


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _serve(handler_cls):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class _Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({k.lower(): v for k, v in self.headers.items()}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def _helper(login):
    seen = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("X-Compendium-Peer"))
            self.send_response(200)
            if login:
                self.send_header("Tailscale-User-Login", login)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    return H, seen


@pytest.fixture
def gateway(tmp_path):
    procs, servers = [], []

    def start(login):
        helper_cls, seen = _helper(login)
        helper, echo = _serve(helper_cls), _serve(_Echo)
        servers.extend([helper, echo])
        port = _free_port()
        shutil.copy(GW / "owner-app.caddy", tmp_path / "owner-app.caddy")
        (tmp_path / "Test.caddyfile").write_text(
            "{\n\tadmin off\n\tauto_https off\n}\n"
            f"http://127.0.0.1:{port} {{\n"
            f"\timport owner-app.caddy 127.0.0.1:{echo.server_address[1]} 127.0.0.1:{helper.server_address[1]}\n"
            "}\n"
        )
        p = subprocess.Popen(
            [CADDY, "run", "--config", "Test.caddyfile", "--adapter", "caddyfile"],
            cwd=tmp_path, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        procs.append(p)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        return port, seen

    yield start
    for p in procs:
        p.terminate()
        p.wait(timeout=5)
    for s in servers:
        s.shutdown()


FORGED = {
    "Tailscale-User-Login": "attacker@evil.test",
    "Tailscale-User-Name": "Mallory",
    "Tailscale-User-Profile-Pic": "https://evil.test/p.png",
    "X-Compendium-Peer": "100.64.0.66",
}


def _fetch(port, headers):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/x", headers=headers)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


@needs_caddy
def test_helper_login_replaces_a_forged_one(gateway):
    port, seen = gateway("owner@example.test")
    got = _fetch(port, FORGED)
    assert got.get("tailscale-user-login") == "owner@example.test"
    assert "tailscale-user-name" not in got
    assert "tailscale-user-profile-pic" not in got
    assert "x-compendium-peer" not in got
    assert seen == ["127.0.0.1"]  # the real TCP peer, not the forged header


@needs_caddy
def test_no_helper_login_means_no_identity_reaches_the_web(gateway):
    port, _ = gateway(None)
    got = _fetch(port, FORGED)
    for h in ("tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "x-compendium-peer"):
        assert h not in got


@needs_caddy
def test_production_caddyfile_listens_only_on_the_tailnet_addresses(tmp_path):
    shutil.copy(GW / "Caddyfile", tmp_path / "Caddyfile")
    shutil.copy(GW / "owner-app.caddy", tmp_path / "owner-app.caddy")
    (tmp_path / "acmedns.json").write_text("{}")
    env = dict(
        os.environ,
        OWNER_HOSTNAME="my.example.test",
        TAILNET_HOSTNAME="box.tail0000.ts.net",
        TAILNET_IPV4="100.64.0.9",
        TAILNET_IPV6="fd7a:115c:a1e0::9",
        ACMEDNS_CREDENTIALS=str(tmp_path / "acmedns.json"),
    )
    out = subprocess.run(
        [CADDY, "adapt", "--config", "Caddyfile", "--adapter", "caddyfile"],
        cwd=tmp_path, env=env, capture_output=True, text=True, check=True,
    )
    cfg = json.loads(out.stdout)
    listens = sorted(addr for srv in cfg["apps"]["http"]["servers"].values() for addr in srv["listen"])
    assert listens == ["100.64.0.9:443", "[fd7a:115c:a1e0::9]:443"]
    assert "my.example.test" in out.stdout and "box.tail0000.ts.net" in out.stdout


def test_snippet_runs_in_written_order_inside_one_route():
    text = (GW / "owner-app.caddy").read_text()
    body = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    assert body[0] == "route {"
    deletes = [line for line in body if line.startswith("request_header -")]
    assert deletes == [
        "request_header -Tailscale-User-Login",
        "request_header -Tailscale-User-Name",
        "request_header -Tailscale-User-Profile-Pic",
        "request_header -X-Compendium-Peer",
    ]
    assert body.index(deletes[-1]) < body.index("forward_auth {args[1]} {") < body.index("reverse_proxy {args[0]}")


def test_env_example_lists_exactly_the_five_names():
    names = sorted(
        line.split("=", 1)[0]
        for line in (GW / "env.example").read_text().splitlines()
        if line and not line.startswith("#")
    )
    assert names == ["ACMEDNS_CREDENTIALS", "OWNER_HOSTNAME", "TAILNET_HOSTNAME", "TAILNET_IPV4", "TAILNET_IPV6"]
