"""SSRF guard + pinning coverage for the raw-HTML archiver's generic fetch.

``_fetch_generic`` GETs an arbitrary user-supplied URL server-side, same
trust-boundary shape as ``content_fetcher.fetch_generic_content`` -- these
tests mirror that module's rebinding/pinning coverage in
``tests/test_url_guard.py`` rather than re-deriving it. See
``backend/services/url_guard.py``'s module docstring for the underlying
design (pin-not-recheck, per-hop revalidation).
"""

from unittest.mock import patch

import httpx
import pytest

from backend.services.content_fetcher import ContentFetchError
from backend.services.raw_html_archiver import _fetch_generic, archive_raw_html
from backend.services.url_guard import MAX_REDIRECTS, UnsafeURLError
from tests.test_url_guard import _HTML, _PUBLIC, _patched_client, _resolves_to


class TestRawHtmlFetcherRevalidation:
    @pytest.mark.asyncio
    async def test_submitted_loopback_url_blocked_before_any_request(self):
        """The direct case: no request should be issued at all."""
        issued = []

        def handler(request):
            issued.append(str(request.url))
            return httpx.Response(200, text=_HTML)

        with patch("httpx.AsyncClient", _patched_client(handler)):
            with pytest.raises(UnsafeURLError, match="non-public"):
                await _fetch_generic("http://127.0.0.1:8001/api/logs")

        assert issued == []

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
                await _fetch_generic("https://safe.example.com/start")

    @pytest.mark.asyncio
    async def test_redirect_loop_is_bounded(self):
        """Self-redirect must terminate rather than spin."""

        def handler(request):
            return httpx.Response(
                302, headers={"location": "https://safe.example.com/loop"}
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            with pytest.raises(ContentFetchError, match=f"more than {MAX_REDIRECTS}"):
                await _fetch_generic("https://safe.example.com/loop")

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
            body, content_type = await _fetch_generic("https://safe.example.com/start")

        assert b"Safe Page" in body
        assert "html" in content_type
        assert len(seen) == 2  # followed exactly one hop

    @pytest.mark.asyncio
    async def test_rebinding_hop_still_blocked(self):
        """Fake resolver flips answers between calls -- pinning closes the
        check/fetch window, it does not skip the per-hop check."""

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
                await _fetch_generic("https://rebind.example.com/start")

    @pytest.mark.asyncio
    async def test_request_targets_pinned_address_with_host_and_sni(self):
        seen_requests = []

        def handler(request):
            seen_requests.append(request)
            return httpx.Response(
                200, headers={"content-type": "text/html"}, text=_HTML
            )

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch(
            "httpx.AsyncClient", _patched_client(handler)
        ):
            await _fetch_generic("https://pinned.example.com/page")

        assert len(seen_requests) == 1
        req = seen_requests[0]
        assert req.url.host == "93.184.216.34"
        assert req.headers["host"] == "pinned.example.com"
        assert req.extensions.get("sni_hostname") == "pinned.example.com"

    @pytest.mark.asyncio
    async def test_archive_raw_html_returns_none_for_blocked_url(self):
        """The best-effort contract: archive_raw_html swallows the guard's
        raise via its existing blanket except-Exception, same as any other
        fetch failure -- no new failure mode reaches its callers."""
        with patch("httpx.AsyncClient", _patched_client(lambda request: httpx.Response(200))):
            result = await archive_raw_html("http://127.0.0.1:8001/api/logs")
        assert result is None


class TestRawHtmlFetcherKeepAliveDisabled:
    """Same rationale as the equivalent content_fetcher/asset_archiver
    tests: connections are pinned by ADDRESS and httpcore pools by
    (scheme, address, port) with no SNI in the key, so keep-alive must be
    off. MockTransport bypasses real pooling, so this asserts on the
    client's own construction."""

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
            await _fetch_generic("https://safe.example.com/page")

        assert captured_kwargs, "AsyncClient was never constructed"
        limits = captured_kwargs[0].get("limits")
        assert isinstance(limits, httpx.Limits)
        assert limits.max_keepalive_connections == 0
