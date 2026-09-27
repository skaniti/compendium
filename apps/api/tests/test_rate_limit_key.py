"""Rate limiter key function (task 7e, post-flip-closeout).

The api container is reached through a `127.0.0.1:8001:8000` docker port
map, so uvicorn's peer address is always the docker bridge gateway --
`slowapi`'s default `get_remote_address` therefore keys every caller into
one shared bucket. `client_key` prefers an attested client address over the
raw peer, but ONLY when the deployment has explicitly opted in via config;
with nothing configured it falls straight through to `get_remote_address`,
so this lands inert.

Precedence: proxy-attested address (shared-secret gated) > Cloudflare
`CF-Connecting-IP` (flag-gated) > raw peer address. Never raises -- a
malformed header at any stage falls through to the next rule rather than
blowing up the request.
"""

import hmac

from starlette.requests import Request

from backend.api.rate_limit_key import client_key
from backend.config.settings import settings

PROXY_SECRET = "test-proxy-shared-secret"


def make_request(headers: dict[str, str] | None = None, peer: str | None = "203.0.113.5") -> Request:
    """Build a minimal starlette Request with a fake client and headers."""
    encoded_headers = [
        (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/whatever",
        "headers": encoded_headers,
        "client": (peer, 12345) if peer is not None else None,
    }
    return Request(scope)


def configure(monkeypatch, *, trust_cf: bool = False, proxy_secret: str = "") -> None:
    monkeypatch.setattr(settings, "rate_limit_trust_cf_header", trust_cf)
    monkeypatch.setattr(settings, "proxy_shared_secret", proxy_secret)


class TestNothingConfigured:
    def test_falls_back_to_peer_address(self, monkeypatch):
        configure(monkeypatch)
        req = make_request(peer="203.0.113.5")

        assert client_key(req) == "203.0.113.5"

    def test_ignores_cf_header_when_flag_is_off(self, monkeypatch):
        configure(monkeypatch)
        req = make_request(headers={"CF-Connecting-IP": "198.51.100.9"}, peer="203.0.113.5")

        assert client_key(req) == "203.0.113.5"

    def test_ignores_proxy_headers_when_secret_is_empty(self, monkeypatch):
        configure(monkeypatch, proxy_secret="")
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": "anything-at-all",
                "X-Compendium-Client-Ip": "198.51.100.9",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "203.0.113.5"


class TestCloudflareHeader:
    def test_trusted_when_flag_on_and_header_valid(self, monkeypatch):
        configure(monkeypatch, trust_cf=True)
        req = make_request(headers={"CF-Connecting-IP": "198.51.100.9"}, peer="203.0.113.5")

        assert client_key(req) == "198.51.100.9"

    def test_malformed_header_falls_back_to_peer(self, monkeypatch):
        configure(monkeypatch, trust_cf=True)
        req = make_request(headers={"CF-Connecting-IP": "not-an-ip"}, peer="203.0.113.5")

        assert client_key(req) == "203.0.113.5"

    def test_ipv6_header_is_accepted(self, monkeypatch):
        configure(monkeypatch, trust_cf=True)
        req = make_request(headers={"CF-Connecting-IP": "2001:db8::1"}, peer="203.0.113.5")

        assert client_key(req) == "2001:db8::1"


class TestProxyAttestedAddress:
    def test_trusted_when_secret_matches_and_ip_valid(self, monkeypatch):
        configure(monkeypatch, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": PROXY_SECRET,
                "X-Compendium-Client-Ip": "198.51.100.9",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "198.51.100.9"

    def test_secret_matches_but_ip_is_garbage_falls_to_next_rule(self, monkeypatch):
        configure(monkeypatch, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": PROXY_SECRET,
                "X-Compendium-Client-Ip": "not-an-ip",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "203.0.113.5"

    def test_secret_matches_but_ip_header_missing_falls_to_next_rule(self, monkeypatch):
        configure(monkeypatch, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={"X-Compendium-Proxy-Secret": PROXY_SECRET},
            peer="203.0.113.5",
        )

        assert client_key(req) == "203.0.113.5"

    def test_wrong_secret_is_ignored(self, monkeypatch):
        configure(monkeypatch, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": "wrong-secret",
                "X-Compendium-Client-Ip": "198.51.100.9",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "203.0.113.5"

    def test_takes_precedence_over_cloudflare_header(self, monkeypatch):
        configure(monkeypatch, trust_cf=True, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": PROXY_SECRET,
                "X-Compendium-Client-Ip": "198.51.100.9",
                "CF-Connecting-IP": "192.0.2.1",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "198.51.100.9"

    def test_bad_proxy_attestation_still_falls_through_to_valid_cf_header(self, monkeypatch):
        configure(monkeypatch, trust_cf=True, proxy_secret=PROXY_SECRET)
        req = make_request(
            headers={
                "X-Compendium-Proxy-Secret": "wrong-secret",
                "X-Compendium-Client-Ip": "198.51.100.9",
                "CF-Connecting-IP": "192.0.2.1",
            },
            peer="203.0.113.5",
        )

        assert client_key(req) == "192.0.2.1"


def test_constant_time_compare_is_actually_used(monkeypatch):
    """Not a timing test (too flaky) -- just pins that the module calls
    hmac.compare_digest rather than `==`, which the brief requires."""
    import backend.api.rate_limit_key as module

    calls = []
    real_compare = hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real_compare(a, b)

    monkeypatch.setattr(module.hmac, "compare_digest", spy)
    configure(monkeypatch, proxy_secret=PROXY_SECRET)
    req = make_request(
        headers={
            "X-Compendium-Proxy-Secret": PROXY_SECRET,
            "X-Compendium-Client-Ip": "198.51.100.9",
        },
        peer="203.0.113.5",
    )

    assert client_key(req) == "198.51.100.9"
    assert calls, "expected hmac.compare_digest to be called"


def test_never_raises_on_a_request_with_no_client():
    req = make_request(peer=None)

    assert client_key(req) == "127.0.0.1"
