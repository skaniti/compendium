"""SSRF guard: which URLs the Stage-0 fallback fetcher may retrieve.

The capture pipeline fetches user-supplied URLs server-side from a host
that also runs Postgres and the app ports on loopback, and the fetched
body is readable afterwards via /api/pages/content. These tests pin the
address and scheme rules, the IPv4-mapped-IPv6 bypass, and the
fail-closed behaviour -- a regression here silently reopens a readable
SSRF, which no other test would catch.
"""

from unittest.mock import patch

import pytest

from backend.services.url_guard import UnsafeURLError, assert_public_url


def _resolves_to(*addrs):
    """Stub getaddrinfo to return the given literal addresses."""
    return [(None, None, None, None, (a, 0)) for a in addrs]


class TestSchemes:
    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com:70/_x",
            "data:text/html,<h1>x</h1>",
        ],
    )
    def test_non_web_schemes_rejected(self, url):
        with pytest.raises(UnsafeURLError, match="scheme|no host"):
            assert_public_url(url)

    def test_https_public_allowed(self):
        with patch("socket.getaddrinfo", return_value=_resolves_to("93.184.216.34")):
            assert_public_url("https://example.com/page")


class TestLiteralAddresses:
    @pytest.mark.parametrize(
        "host",
        [
            "127.0.0.1",       # loopback
            "10.0.0.5",        # private (scan-ok: test-ip)
            "192.168.1.1",     # private (scan-ok: test-ip)
            "172.16.0.1",      # private
            "169.254.169.254", # link-local / cloud metadata
            "0.0.0.0",         # unspecified
            "[::1]",           # IPv6 loopback
        ],
    )
    def test_non_public_literals_rejected(self, host):
        with pytest.raises(UnsafeURLError, match="non-public"):
            assert_public_url(f"http://{host}/x")

    def test_public_literal_allowed(self):
        assert_public_url("https://93.184.216.34/x")

    def test_ipv4_mapped_ipv6_loopback_rejected(self):
        """::ffff:127.0.0.1 is NOT is_loopback in the stdlib -- the unwrap in
        url_guard is the only thing standing between this and a bypass."""
        with pytest.raises(UnsafeURLError, match="non-public"):
            assert_public_url("http://[::ffff:127.0.0.1]/x")

    def test_ipv4_mapped_private_rejected(self):
        with pytest.raises(UnsafeURLError, match="non-public"):
            assert_public_url("http://[::ffff:10.0.0.1]/x")  # scan-ok: test-ip


class TestResolution:
    def test_hostname_resolving_to_loopback_rejected(self):
        """The DNS-pointed-inward case: a public-looking name, private answer."""
        with patch("socket.getaddrinfo", return_value=_resolves_to("127.0.0.1")):
            with pytest.raises(UnsafeURLError, match="non-public address"):
                assert_public_url("http://sneaky.example.com/x")

    def test_metadata_endpoint_via_dns_rejected(self):
        with patch("socket.getaddrinfo", return_value=_resolves_to("169.254.169.254")):
            with pytest.raises(UnsafeURLError, match="non-public address"):
                assert_public_url("http://metadata.example.com/")

    def test_mixed_public_and_private_answers_rejected(self):
        """One bad A-record disqualifies -- otherwise it's a rebinding primitive."""
        with patch(
            "socket.getaddrinfo", return_value=_resolves_to("93.184.216.34", "127.0.0.1")
        ):
            with pytest.raises(UnsafeURLError, match="non-public address"):
                assert_public_url("http://mixed.example.com/x")

    def test_dns_failure_fails_closed(self):
        import socket as _s

        with patch("socket.getaddrinfo", side_effect=_s.gaierror("nope")):
            with pytest.raises(UnsafeURLError, match="could not resolve"):
                assert_public_url("http://nonexistent.example.com/x")

    def test_empty_resolution_fails_closed(self):
        with patch("socket.getaddrinfo", return_value=[]):
            with pytest.raises(UnsafeURLError, match="resolved to nothing"):
                assert_public_url("http://empty.example.com/x")


class TestMalformed:
    @pytest.mark.parametrize("url", ["", "not a url", "http://", "https://"])
    def test_missing_host_rejected(self, url):
        with pytest.raises(UnsafeURLError):
            assert_public_url(url)


# ---------------------------------------------------------------------------
# Integration: the guard applied across a redirect chain.
#
# Guarding only the submitted URL is the classic half-fix -- a public page
# that 302s to 127.0.0.1 defeats it. fetch_generic_content therefore follows
# redirects manually and re-validates every hop; these tests pin that.
# ---------------------------------------------------------------------------

import httpx

from backend.services.content_fetcher import fetch_generic_content
from backend.services.url_guard import MAX_REDIRECTS

_HTML = (
    "<html><head><title>Safe Page</title></head><body>"
    "<article><p>" + ("Real extractable body text. " * 20) + "</p></article>"
    "</body></html>"
)

_PUBLIC = [(None, None, None, None, ("93.184.216.34", 0))]


def _patched_client(handler):
    """Return a factory that injects a MockTransport into AsyncClient."""
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return factory


class TestRedirectRevalidation:
    @pytest.mark.asyncio
    async def test_redirect_to_loopback_is_blocked(self):
        """A public URL redirecting inward must be refused at the hop."""

        def handler(request):
            return httpx.Response(
                302, headers={"location": "http://127.0.0.1:8001/api/logs"}
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            with pytest.raises(UnsafeURLError, match="non-public"):
                await fetch_generic_content("https://safe.example.com/start")

    @pytest.mark.asyncio
    async def test_redirect_to_metadata_is_blocked(self):
        def handler(request):
            return httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest/meta-data/"}
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            with pytest.raises(UnsafeURLError, match="non-public"):
                await fetch_generic_content("https://safe.example.com/start")

    @pytest.mark.asyncio
    async def test_redirect_loop_is_bounded(self):
        """Self-redirect must terminate rather than spin."""

        def handler(request):
            return httpx.Response(
                302, headers={"location": "https://safe.example.com/loop"}
            )

        from backend.services.content_fetcher import ContentFetchError

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            with pytest.raises(ContentFetchError, match=f"more than {MAX_REDIRECTS}"):
                await fetch_generic_content("https://safe.example.com/loop")

    @pytest.mark.asyncio
    async def test_public_redirect_chain_still_works(self):
        """Guard must not break legitimate redirects (http->https, canonical)."""
        seen = []

        def handler(request):
            seen.append(str(request.url))
            if request.url.path == "/start":
                return httpx.Response(
                    301, headers={"location": "https://safe.example.com/final"}
                )
            return httpx.Response(
                200, headers={"content-type": "text/html"}, text=_HTML
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            result = await fetch_generic_content("https://safe.example.com/start")

        assert result.title == "Safe Page"
        assert "extractable body text" in result.full_text
        assert len(seen) == 2  # followed exactly one hop

    @pytest.mark.asyncio
    async def test_plain_public_fetch_unaffected(self):
        """No-redirect happy path is unchanged by the guard."""

        def handler(request):
            return httpx.Response(
                200, headers={"content-type": "text/html"}, text=_HTML
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            result = await fetch_generic_content("https://safe.example.com/page")

        assert result.title == "Safe Page"

    @pytest.mark.asyncio
    async def test_submitted_loopback_url_blocked_before_any_request(self):
        """The direct case: no request should be issued at all."""
        issued = []

        def handler(request):
            issued.append(str(request.url))
            return httpx.Response(200, text=_HTML)

        with patch("httpx.AsyncClient", _patched_client(handler)):
            with pytest.raises(UnsafeURLError, match="non-public"):
                await fetch_generic_content("http://127.0.0.1:8001/api/logs")

        assert issued == []
