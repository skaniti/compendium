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

DNS rebinding is closed by pinning, not by re-checking: ``resolve_public_url``
returns the exact address it validated (``PinnedURL``), and callers fetch
against that address directly rather than handing the hostname back to
httpx for a second, independent resolution. ``pinned_request_kwargs`` swaps
the hostname for the pinned address in the request URL, sets ``Host`` to
the original hostname (so virtual-hosted origins still route correctly),
and sets the ``sni_hostname`` extension so TLS certificate verification
still checks the ORIGINAL hostname, not the address. httpx never
re-resolves under this scheme, so a DNS answer that changes between the
check and the fetch can't matter. Both server-side fetchers
(``content_fetcher.fetch_generic_content``, ``asset_archiver._ensure_asset``)
re-validate and re-pin every redirect hop the same way.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

# Only real web schemes. Excludes file://, ftp://, gopher://, data:, and the
# rest -- several are classic SSRF escalation vectors and none are pages a
# browser capture would legitimately need fetched server-side.
ALLOWED_SCHEMES = frozenset({"http", "https"})

# Bound the redirect chain. Each hop is re-validated by the caller, so this
# only guards against redirect loops burning the request budget.
MAX_REDIRECTS = 5


class UnsafeURLError(ValueError):
    """A URL resolved to a non-public address, or used a disallowed scheme."""


@dataclass(frozen=True)
class PinnedURL:
    """The single address a guard check validated, to fetch against directly.

    ``url`` is the original (unpinned) URL the check was run against --
    ``pinned_request_kwargs`` needs it to recover path/query/fragment, and
    callers need it unchanged to resolve a relative redirect ``Location``.
    ``host`` is the original hostname (lowercased); ``address`` is the
    literal IP that was checked and must be the one fetched.
    """

    url: str
    host: str
    address: str
    port: int | None
    scheme: str


def _bracket_if_ipv6(host: str) -> str:
    """Wrap a literal IPv6 address in brackets for use in a URL/Host header."""
    return f"[{host}]" if ":" in host else host


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


def resolve_public_url(url: str) -> PinnedURL:
    """Raise UnsafeURLError unless ``url`` is http(s) on a public address;
    otherwise return the exact address validated, to fetch against directly.

    Fails closed: an unparseable URL, a missing host, or a DNS failure all
    raise rather than falling through to the fetch. When a host resolves
    to several public addresses, returns the sorted-first one -- arbitrary
    but deterministic, so the same host always pins to the same address
    within a single process's resolver behaviour.
    """
    try:
        parsed = urlparse(url)
    except Exception as exc:  # malformed beyond urlparse's tolerance
        raise UnsafeURLError(f"unparseable URL: {url!r}") from exc

    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError(
            f"scheme {parsed.scheme!r} not allowed (only http/https): {url!r}"
        )

    host = parsed.hostname
    if not host:
        raise UnsafeURLError(f"no host in URL: {url!r}")

    port = parsed.port

    # A literal address needs no resolution -- and must not get any, since
    # getaddrinfo would happily echo it back and widen the code path.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not _is_public(literal):
            raise UnsafeURLError(f"non-public address: {host}")
        return PinnedURL(url=url, host=host, address=host, port=port, scheme=scheme)

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

    pinned_address = sorted(addresses)[0]
    return PinnedURL(url=url, host=host, address=pinned_address, port=port, scheme=scheme)


def assert_public_url(url: str) -> None:
    """Raise UnsafeURLError unless ``url`` is http(s) on a public address.

    Thin wrapper over ``resolve_public_url`` for callers that only need the
    check, not the pinned address (e.g. validating the initial submitted
    URL before any fetch is attempted).
    """
    resolve_public_url(url)


def pinned_request_kwargs(pinned: PinnedURL, headers: dict) -> tuple[str, dict, dict]:
    """Build the request pieces that fetch ``pinned`` at its checked address.

    Returns ``(pinned_url, headers_with_host, extensions)``:

    - ``pinned_url``: ``pinned.url`` with the hostname replaced by the
      checked address (IPv6 bracketed), so the HTTP client connects
      directly to it and never re-resolves the hostname.
    - ``headers_with_host``: a copy of ``headers`` with ``Host`` set to the
      original hostname (plus ``:port`` when the port is non-default for
      the scheme), so a virtual-hosted origin still routes the request
      correctly.
    - ``extensions``: for https, ``{"sni_hostname": pinned.host}`` so TLS
      certificate verification checks the ORIGINAL hostname rather than
      the address httpx is actually connecting to (httpx forwards this
      extension to httpcore, which uses it as the TLS ``server_hostname``
      -- see httpcore's connection pool). Empty for http, which has no SNI.
    """
    parsed = urlparse(pinned.url)
    netloc = _bracket_if_ipv6(pinned.address)
    if pinned.port is not None:
        netloc = f"{netloc}:{pinned.port}"
    pinned_url = urlunparse(
        (parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment)
    )

    default_port = {"http": 80, "https": 443}.get(pinned.scheme)
    host_header = _bracket_if_ipv6(pinned.host)
    if pinned.port is not None and pinned.port != default_port:
        host_header = f"{host_header}:{pinned.port}"

    headers_with_host = dict(headers)
    headers_with_host["Host"] = host_header

    extensions: dict = {}
    if pinned.scheme == "https":
        extensions["sni_hostname"] = pinned.host

    return pinned_url, headers_with_host, extensions


async def resolve_public_url_async(url: str) -> PinnedURL:
    """Async wrapper -- getaddrinfo blocks, so keep it off the event loop."""
    return await asyncio.to_thread(resolve_public_url, url)


async def assert_public_url_async(url: str) -> None:
    """Async wrapper -- getaddrinfo blocks, so keep it off the event loop."""
    await asyncio.to_thread(assert_public_url, url)
