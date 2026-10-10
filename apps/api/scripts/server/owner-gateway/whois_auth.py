#!/usr/bin/env python3
"""Tailscale identity for the owner gateway (owner-gateway, 2026-10-10).

Caddy's forward_auth asks this loopback service who is at the peer address
of each request. Caddy sets the header X-Compendium-Peer from the TCP peer
with header_up, which replaces anything a client sent, and Caddy listens
directly on the server's tailnet addresses, so the peer is the caller's
tailnet IP. The answer is the Tailscale login of a user-owned device, from
the local tailscaled (`tailscale whois`), returned as Tailscale-User-Login;
Caddy copies it onto the request it proxies to the owner web, after
deleting every client copy of the identity headers. Tagged devices,
non-tailnet peers and failed lookups get no header. Always answers 200: an
unknown caller is not an error, it signs in another way.

Stdlib only. Runs as tailnet-whois.service (DynamicUser, loopback only).
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PEER_HEADER = "X-Compendium-Peer"
LOGIN_HEADER = "Tailscale-User-Login"
TAILNET_RANGES = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)
CACHE_SECONDS = 60.0
WHOIS_TIMEOUT_SECONDS = 2.0
MAX_LOGIN_LENGTH = 320


def tailnet_ip(raw: str | None) -> str | None:
    """The address as a string if it is a tailnet address, else None."""
    try:
        ip = ipaddress.ip_address((raw or "").strip())
    except ValueError:
        return None
    return str(ip) if any(ip in net for net in TAILNET_RANGES) else None


def login_from_whois(data: object) -> str | None:
    """The login of a user-owned device from `tailscale whois --json` output."""
    if not isinstance(data, dict):
        return None
    node = data.get("Node") or {}
    if not isinstance(node, dict) or node.get("Tags"):
        return None
    profile = data.get("UserProfile") or {}
    login = profile.get("LoginName") if isinstance(profile, dict) else None
    if not isinstance(login, str):
        return None
    login = login.strip()
    if (
        not login
        or len(login) > MAX_LOGIN_LENGTH
        or not login.isascii()
        or not login.isprintable()
    ):
        return None
    return login


def run_whois(ip: str) -> dict | None:
    """Ask the local tailscaled about ip. Raises on any failure."""
    out = subprocess.run(
        ["tailscale", "whois", "--json", ip],
        capture_output=True,
        text=True,
        timeout=WHOIS_TIMEOUT_SECONDS,
    )
    if out.returncode != 0:
        raise RuntimeError(f"tailscale whois exited {out.returncode}")
    return json.loads(out.stdout)


class Resolver:
    """Peer address -> login, caching successful lookups for 60 s."""

    def __init__(self, whois=run_whois, clock=time.monotonic):
        self._whois = whois
        self._clock = clock
        self._cache: dict[str, tuple[str | None, float]] = {}
        self._lock = threading.Lock()

    def login_for(self, raw_peer: str | None) -> str | None:
        ip = tailnet_ip(raw_peer)
        if ip is None:
            return None
        now = self._clock()
        with self._lock:
            hit = self._cache.get(ip)
            if hit is not None and now - hit[1] < CACHE_SECONDS:
                return hit[0]
        try:
            login = login_from_whois(self._whois(ip))
        except Exception as exc:  # timeout, non-zero exit, bad JSON
            print(f"tailnet-whois: lookup failed for {ip}: {exc}", file=sys.stderr, flush=True)
            return None
        with self._lock:
            self._cache[ip] = (login, now)
        return login


def make_handler(resolver: Resolver) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _answer(self) -> None:
            login = resolver.login_for(self.headers.get(PEER_HEADER))
            self.send_response(200)
            if login:
                self.send_header(LOGIN_HEADER, login)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_HEAD = do_POST = _answer

        def log_message(self, format, *args):  # no per-request lines
            return

    return Handler


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Tailscale identity for the owner gateway")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9180)
    args = parser.parse_args(argv)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(Resolver()))
    print(f"tailnet-whois: listening on {args.host}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
