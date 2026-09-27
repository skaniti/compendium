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


# ---------------------------------------------------------------------------
# Pinning: resolve_public_url returns the exact address it checked, and
# pinned_request_kwargs builds a request that connects to THAT address
# directly rather than handing the hostname back to httpx for a second,
# independent resolution (the DNS-rebinding gap task 7c closes).
# ---------------------------------------------------------------------------

from backend.services.url_guard import PinnedURL, pinned_request_kwargs, resolve_public_url


class TestResolvePublicURL:
    def test_returns_first_address_in_resolver_order_not_sorted(self):
        """getaddrinfo already applies the system's address-selection
        policy -- pin its first answer, not a re-sort of the address
        strings (a string sort would prefer any IPv6 address over IPv4
        regardless of what the resolver/box actually prefers)."""
        with patch(
            "socket.getaddrinfo",
            return_value=_resolves_to("1.1.1.1", "93.184.216.34"),
        ):
            pinned = resolve_public_url("https://multi.example.com/x")
        assert pinned.address == "1.1.1.1"  # first in resolver order
        assert pinned.host == "multi.example.com"
        assert pinned.scheme == "https"
        assert pinned.port is None

    def test_second_address_pinned_when_it_is_first_in_resolver_order(self):
        """Order, not value, decides -- swapping the answers swaps the pin."""
        with patch(
            "socket.getaddrinfo",
            return_value=_resolves_to("93.184.216.34", "1.1.1.1"),
        ):
            pinned = resolve_public_url("https://multi.example.com/x")
        assert pinned.address == "93.184.216.34"

    def test_duplicate_answers_deduped_without_disturbing_order(self):
        with patch(
            "socket.getaddrinfo",
            return_value=_resolves_to("93.184.216.34", "93.184.216.34", "1.1.1.1"),
        ):
            pinned = resolve_public_url("https://multi.example.com/x")
        assert pinned.address == "93.184.216.34"

    def test_literal_ip_url_returns_itself(self):
        pinned = resolve_public_url("https://93.184.216.34:8443/x")
        assert pinned.address == "93.184.216.34"
        assert pinned.host == "93.184.216.34"
        assert pinned.port == 8443
        assert pinned.scheme == "https"

    def test_port_and_scheme_preserved_for_resolved_host(self):
        with patch("socket.getaddrinfo", return_value=_PUBLIC):
            pinned = resolve_public_url("http://safe.example.com:8080/x")
        assert pinned.port == 8080
        assert pinned.scheme == "http"
        assert pinned.host == "safe.example.com"

    def test_still_rejects_non_public(self):
        with patch("socket.getaddrinfo", return_value=_resolves_to("127.0.0.1")):
            with pytest.raises(UnsafeURLError, match="non-public address"):
                resolve_public_url("http://sneaky.example.com/x")

    @pytest.mark.parametrize(
        "url",
        [
            "http://example.com:99999/x",  # out of range
            "http://example.com:abc/x",  # non-numeric
        ],
    )
    def test_malformed_port_fails_closed_as_unsafe_url_error(self, url):
        """urlparse(...).port raises a bare ValueError for these -- must
        surface as UnsafeURLError so a caller's `except UnsafeURLError`
        (e.g. the archiver's per-hop refusal handling) actually catches
        it, instead of a different exception type escaping and dropping
        a whole batch via gather(..., return_exceptions=True)."""
        with pytest.raises(UnsafeURLError, match="invalid port"):
            resolve_public_url(url)


class TestPinnedRequestKwargs:
    def test_swaps_hostname_for_address(self):
        pinned = PinnedURL(
            url="https://safe.example.com/a/b?q=1",
            host="safe.example.com",
            address="93.184.216.34",
            port=None,
            scheme="https",
        )
        url, headers, extensions = pinned_request_kwargs(pinned, {"Accept": "*/*"})
        assert url == "https://93.184.216.34/a/b?q=1"
        assert headers["Host"] == "safe.example.com"
        assert headers["Accept"] == "*/*"
        assert extensions == {"sni_hostname": "safe.example.com"}

    def test_http_has_no_sni_extension(self):
        pinned = PinnedURL(
            url="http://safe.example.com/x",
            host="safe.example.com",
            address="93.184.216.34",
            port=None,
            scheme="http",
        )
        _, headers, extensions = pinned_request_kwargs(pinned, {})
        assert extensions == {}
        assert headers["Host"] == "safe.example.com"

    def test_non_default_port_kept_on_url_and_host_header(self):
        pinned = PinnedURL(
            url="https://safe.example.com:8443/x",
            host="safe.example.com",
            address="93.184.216.34",
            port=8443,
            scheme="https",
        )
        url, headers, _ = pinned_request_kwargs(pinned, {})
        assert url == "https://93.184.216.34:8443/x"
        assert headers["Host"] == "safe.example.com:8443"

    def test_default_port_omitted_from_host_header(self):
        pinned = PinnedURL(
            url="https://safe.example.com:443/x",
            host="safe.example.com",
            address="93.184.216.34",
            port=443,
            scheme="https",
        )
        _, headers, _ = pinned_request_kwargs(pinned, {})
        assert headers["Host"] == "safe.example.com"

    def test_ipv6_address_bracketed_in_url(self):
        pinned = PinnedURL(
            url="https://safe.example.com/x",
            host="safe.example.com",
            address="2001:db8::1",
            port=None,
            scheme="https",
        )
        url, headers, _ = pinned_request_kwargs(pinned, {})
        assert url == "https://[2001:db8::1]/x"
        assert headers["Host"] == "safe.example.com"

    def test_ipv6_original_host_bracketed_in_host_header(self):
        pinned = PinnedURL(
            url="https://[::1]/x",
            host="::1",
            address="::1",
            port=None,
            scheme="https",
        )
        _, headers, extensions = pinned_request_kwargs(pinned, {})
        assert headers["Host"] == "[::1]"
        assert extensions == {"sni_hostname": "::1"}

    def test_does_not_mutate_caller_headers(self):
        original = {"Accept": "*/*"}
        pinned = PinnedURL(
            url="https://safe.example.com/x",
            host="safe.example.com",
            address="93.184.216.34",
            port=None,
            scheme="https",
        )
        pinned_request_kwargs(pinned, original)
        assert original == {"Accept": "*/*"}

    def test_idn_host_is_ascii_encoded_in_host_and_sni(self):
        """httpx sends header VALUES as raw ASCII (unlike the URL host,
        which it IDNA-encodes itself) -- an IDN original hostname put
        straight into Host previously raised UnicodeEncodeError at
        request-build time."""
        pinned = PinnedURL(
            url="https://xn--mnchen-3ya.example/x",
            host="münchen.example",
            address="93.184.216.34",
            port=None,
            scheme="https",
        )
        url, headers, extensions = pinned_request_kwargs(pinned, {})
        assert headers["Host"] == "xn--mnchen-3ya.example"
        assert extensions["sni_hostname"] == "xn--mnchen-3ya.example"
        # ASCII throughout -- would raise if handed to httpx as-is.
        headers["Host"].encode("ascii")
        assert url == "https://93.184.216.34/x"


class TestFetcherPinning:
    """fetch_generic_content must fetch the address it checked, not a
    hostname httpx re-resolves -- a fake resolver that flips answers
    between calls is the rebinding primitive this closes."""

    @pytest.mark.asyncio
    async def test_request_targets_pinned_address_with_host_and_sni(self):
        seen_requests = []

        def handler(request):
            seen_requests.append(request)
            return httpx.Response(
                200, headers={"content-type": "text/html"}, text=_HTML
            )

        answers = iter([_PUBLIC, _resolves_to("127.0.0.1")])

        def fake_getaddrinfo(host, *_args, **_kwargs):
            return next(answers)

        with patch("socket.getaddrinfo", side_effect=fake_getaddrinfo), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            await fetch_generic_content("https://rebind.example.com/page")

        assert len(seen_requests) == 1
        req = seen_requests[0]
        assert req.url.host == "93.184.216.34"  # the FIRST (checked) address
        assert req.headers["host"] == "rebind.example.com"
        assert req.extensions.get("sni_hostname") == "rebind.example.com"

    @pytest.mark.asyncio
    async def test_redirect_hop_resolving_to_loopback_still_blocked(self):
        """Pinning closes the check/fetch window -- it does not skip the
        per-hop check. A hop whose OWN resolution is non-public at the
        time it's checked must still raise, exactly as before pinning."""

        def handler(request):
            return httpx.Response(
                302, headers={"location": "http://inward.example.com/x"}
            )

        answers = iter([_PUBLIC, _resolves_to("127.0.0.1")])

        def fake_getaddrinfo(host, *_args, **_kwargs):
            return next(answers)

        with patch("socket.getaddrinfo", side_effect=fake_getaddrinfo), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            with pytest.raises(UnsafeURLError, match="non-public"):
                await fetch_generic_content("https://rebind.example.com/start")


class TestFetcherKeepAliveDisabled:
    """httpcore pools connections by (scheme, address, port) with no SNI
    in the key, and every hop here connects by PINNED ADDRESS, not
    hostname -- so a redirect hop that happens to pin to the same
    address:port as an earlier hop could reuse that hop's already
    -verified TLS connection under a different hostname, skipping the
    handshake (and the certificate check) the new hop's Host/SNI were
    supposed to trigger. Keep-alive must be off. MockTransport bypasses
    real pooling, so this asserts on the client's own construction
    instead."""

    @pytest.mark.asyncio
    async def test_client_disables_keepalive(self):
        captured_kwargs = []
        real = httpx.AsyncClient

        def spy(*args, **kwargs):
            captured_kwargs.append(kwargs)
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(
                    200, headers={"content-type": "text/html"}, text=_HTML
                )
            )
            return real(*args, **kwargs)

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", spy
        ):
            await fetch_generic_content("https://safe.example.com/page")

        assert captured_kwargs, "AsyncClient was never constructed"
        limits = captured_kwargs[0].get("limits")
        assert isinstance(limits, httpx.Limits)
        assert limits.max_keepalive_connections == 0


# ---------------------------------------------------------------------------
# Rebinding + pinning for the asset archiver: _ensure_asset downloads
# user-page-referenced URLs (images, stylesheets) with NO guard before this
# task. Same defect class as the page fetcher, same fix, own commit.
# ---------------------------------------------------------------------------

from backend.services import asset_archiver
from backend.services.asset_archiver import _ensure_asset


class TestAssetArchiverPinning:
    @pytest.mark.asyncio
    async def test_refused_hop_returns_none_and_logs_host_only(self, caplog):
        def handler(request):
            return httpx.Response(
                302, headers={"location": "http://inward.example.com/secret.png"}
            )

        answers = iter([_PUBLIC, _resolves_to("127.0.0.1")])

        def fake_getaddrinfo(host, *_args, **_kwargs):
            return next(answers)

        with patch("socket.getaddrinfo", side_effect=fake_getaddrinfo), patch.object(
            asset_archiver, "_get_asset_id_by_source_url", return_value=None
        ):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                with caplog.at_level("WARNING"):
                    result = await _ensure_asset(
                        client, "https://start.example.com/photo.png", user_id=1
                    )

        assert result is None
        messages = [rec.message for rec in caplog.records]
        assert any("inward.example.com" in m for m in messages)
        # host-only logging -- the refused hop's path must not appear
        assert not any("secret.png" in m for m in messages)

    @pytest.mark.asyncio
    async def test_pins_each_hop_of_a_redirect_chain(self):
        seen = []

        def handler(request):
            seen.append(request)
            if request.url.path == "/photo.png":
                return httpx.Response(
                    302, headers={"location": "https://cdn.example.com/final.png"}
                )
            return httpx.Response(
                200, content=b"\x89PNG", headers={"content-type": "image/png"}
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch.object(
            asset_archiver, "_get_asset_id_by_source_url", return_value=None
        ), patch.object(asset_archiver, "_get_asset_id_by_sha", return_value=42):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await _ensure_asset(
                    client, "https://start.example.com/photo.png", user_id=1
                )

        assert result == 42
        assert len(seen) == 2
        assert seen[0].headers["host"] == "start.example.com"
        assert seen[1].headers["host"] == "cdn.example.com"
        for req in seen:
            assert req.url.host == "93.184.216.34"
            assert req.extensions.get("sni_hostname") == req.headers["host"]

    @pytest.mark.asyncio
    async def test_too_many_redirects_returns_none(self, caplog):
        def handler(request):
            return httpx.Response(
                302, headers={"location": "https://loop.example.com/x.png"}
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch.object(
            asset_archiver, "_get_asset_id_by_source_url", return_value=None
        ):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                with caplog.at_level("WARNING"):
                    result = await _ensure_asset(
                        client, "https://loop.example.com/x.png", user_id=1
                    )

        assert result is None
        assert any("more than" in rec.message for rec in caplog.records)


class TestArchiverKeepAliveDisabled:
    """Same rationale as TestFetcherKeepAliveDisabled, for the client
    archive_assets_for_page builds per host -- asserted through the real
    call path (DB writes + the on-disk directory mocked out) since the
    limits kwarg lives on a client constructed inside a closure that
    isn't otherwise reachable from a test."""

    @pytest.mark.asyncio
    async def test_client_disables_keepalive(self, tmp_path):
        import gzip

        captured_kwargs = []
        real = httpx.AsyncClient

        def spy(*args, **kwargs):
            captured_kwargs.append(kwargs)
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(
                    200, content=b"\x89PNG", headers={"content-type": "image/png"}
                )
            )
            return real(*args, **kwargs)

        html = b'<html><body><img src="https://cdn.example.com/x.png"></body></html>'
        gzipped = gzip.compress(html)

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch.object(
            asset_archiver, "_get_asset_id_by_source_url", return_value=None
        ), patch.object(
            asset_archiver, "_get_asset_id_by_sha", return_value=42
        ), patch.object(
            asset_archiver, "_link_assets_to_page"
        ), patch.object(
            asset_archiver, "_BASE_ASSETS_DIR", tmp_path
        ), patch("httpx.AsyncClient", spy):
            count = await asset_archiver.archive_assets_for_page(
                page_content_id=1,
                gzipped_html=gzipped,
                base_url="https://cdn.example.com/page",
                user_id=1,
            )

        assert count == 1
        assert captured_kwargs, "AsyncClient was never constructed"
        limits = captured_kwargs[0].get("limits")
        assert isinstance(limits, httpx.Limits)
        assert limits.max_keepalive_connections == 0
