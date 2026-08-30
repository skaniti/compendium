"""SSRF guard for server-side fetches of user-supplied URLs.

Capture ingestion accepts arbitrary URLs (``PageVisit.url`` is a bare
``str``) and the Stage-0 fallback fetcher retrieves them server-side. That
fetch originates from the app host, which also runs Postgres and the
FastAPI/Dash/Caddy ports on loopback, so an unvalidated URL turns the
capture pipeline into a request proxy into the trust boundary. The fetched
body is stored in ``page_content`` and served back through
``/api/pages/content`` and ``/api/pages/{id}/preview``, making it a
*readable* SSRF rather than a blind one.

The guard deliberately lives at FETCH time, not at ingest time. A capture
legitimately records whatever the user browsed -- including localhost dev
servers, which this project itself runs on -- so rejecting those URLs at
the API boundary would discard real history and fail the whole capture on
one bad page. Refusing to *fetch* them keeps the record intact: the
pipeline's per-page ``except Exception`` marks that page ``status="error"``
and processing continues.

Residual risk, accepted: this resolves the hostname and checks the
addresses, then hands the URL to httpx, which resolves again. A DNS entry
that changes between those two lookups (DNS rebinding) would slip through.
Closing that needs connection-level pinning of the validated address; for
an authenticated, self-hosted deployment the resolve-and-check bar is
proportionate. Revisit if the API is ever exposed on its own public
hostname (see the mig-06 deploy-flip plan).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

# Only real web schemes. Excludes file://, ftp://, gopher://, data:, and the
# rest -- several are classic SSRF escalation vectors and none are pages a
# browser capture would legitimately need fetched server-side.
ALLOWED_SCHEMES = frozenset({"http", "https"})

# Bound the redirect chain. Each hop is re-validated by the caller, so this
# only guards against redirect loops burning the request budget.
MAX_REDIRECTS = 5


class UnsafeURLError(ValueError):
    """A URL resolved to a non-public address, or used a disallowed scheme."""


def _unwrap(ip: ipaddress._BaseAddress) -> ipaddress._BaseAddress:
    """Collapse IPv4-mapped IPv6 to its IPv4 form.

    ``ipaddress.IPv6Address("::ffff:127.0.0.1").is_loopback`` is False --
    the loopback test only inspects the v6 representation. Without this
    unwrap, mapped notation is a one-line bypass of every check below.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return mapped
    return ip


def _is_public(ip: ipaddress._BaseAddress) -> bool:
    ip = _unwrap(ip)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local  # includes 169.254.0.0/16 -- cloud metadata
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def assert_public_url(url: str) -> None:
    """Raise UnsafeURLError unless ``url`` is http(s) on a public address.

    Fails closed: an unparseable URL, a missing host, or a DNS failure all
    raise rather than falling through to the fetch.
    """
    try:
        parsed = urlparse(url)
    except Exception as exc:  # malformed beyond urlparse's tolerance
        raise UnsafeURLError(f"unparseable URL: {url!r}") from exc

    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeURLError(
            f"scheme {parsed.scheme!r} not allowed (only http/https): {url!r}"
        )

    host = parsed.hostname
    if not host:
        raise UnsafeURLError(f"no host in URL: {url!r}")

    # A literal address needs no resolution -- and must not get any, since
    # getaddrinfo would happily echo it back and widen the code path.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not _is_public(literal):
            raise UnsafeURLError(f"non-public address: {host}")
        return

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"could not resolve host {host!r}") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise UnsafeURLError(f"host {host!r} resolved to nothing")

    # EVERY address must be public. A host with one public and one private
    # A-record is a rebinding primitive, so a single bad answer disqualifies.
    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise UnsafeURLError(f"unparseable address {addr!r} for host {host!r}")
        if not _is_public(ip):
            raise UnsafeURLError(f"host {host!r} resolves to non-public address {addr}")


async def assert_public_url_async(url: str) -> None:
    """Async wrapper -- getaddrinfo blocks, so keep it off the event loop."""
    await asyncio.to_thread(assert_public_url, url)
