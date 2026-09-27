"""Rate limiter key function (task 7e, post-flip-closeout).

Why this exists
----------------
The api container is reached through a `127.0.0.1:8001:8000` docker port
map, so the peer address uvicorn sees is the docker bridge gateway for
every request, and uvicorn's default `forwarded-allow-ips=127.0.0.1` does
not match that gateway, so `X-Forwarded-For` is ignored -- `slowapi`'s
default `get_remote_address` key function therefore puts every caller into
one shared bucket, behind both the Cloudflare tunnel and the Vercel-hosted
Next.js proxy.

`client_key` prefers an attested real client address over the raw peer, in
this order:

1. A proxy-attested address: the Next.js proxy (apps/web) presents
   `X-Compendium-Proxy-Secret` matching `settings.proxy_shared_secret`
   (constant-time compare) alongside `X-Compendium-Client-Ip`. Trusted only
   when the secret is configured (non-empty) -- a browser can set both
   headers itself, but it cannot know the secret.
2. `CF-Connecting-IP`, trusted only when `settings.rate_limit_trust_cf_header`
   is on -- safe only when Cloudflare is the sole ingress and overwrites
   this header on every request (the production tunnel deployment).
3. `slowapi.util.get_remote_address` (the raw peer address) -- today's
   behavior, and the fallback for every malformed/untrusted case above.

Both knobs default to their safe, inert state (flag off, secret empty), so
this module changes nothing until a deployment explicitly configures it.
Never raises: a malformed header at any stage simply falls through to the
next rule.
"""

import hmac
from ipaddress import ip_address

from fastapi import Request
from slowapi.util import get_remote_address

from backend.config.settings import settings

PROXY_SECRET_HEADER = "X-Compendium-Proxy-Secret"
PROXY_CLIENT_IP_HEADER = "X-Compendium-Client-Ip"
CF_CONNECTING_IP_HEADER = "CF-Connecting-IP"


def _valid_ip_or_none(value: str | None) -> str | None:
    """Return the canonical string form of `value` if it parses as an IP,
    else None. Canonicalizing (rather than returning the raw header text)
    means textually-distinct spellings of one address (upper/lower-case
    IPv6 hex, non-compressed zero runs) share a rate-limit bucket -- fix
    round 1, Note 3 (review-7e.md)."""
    if not value:
        return None
    try:
        return str(ip_address(value))
    except ValueError:
        return None


def _secret_matches(presented: str, configured: str) -> bool:
    """Constant-time compare that never raises.

    `hmac.compare_digest` on two `str` requires BOTH to be pure ASCII and
    raises `TypeError` otherwise. Starlette decodes header values as
    latin-1, whose full byte range (0x00-0xFF) is a valid `str`, so a
    presented header value with any high byte reaches here as a non-ASCII
    `str` -- and would raise past this point, which slowapi re-raises,
    500ing the request. Fix round 1, Finding 1 (review-7e.md): compare as
    bytes instead (`compare_digest` on bytes never raises for content, only
    for a type mismatch, which can't happen once both sides are encoded the
    same way), and keep the try/except as a second, belt-and-suspenders
    guard -- any exception here is treated as a mismatch, never propagated.
    """
    try:
        return hmac.compare_digest(
            presented.encode("utf-8", "surrogateescape"),
            configured.encode("utf-8", "surrogateescape"),
        )
    except (TypeError, UnicodeError):
        return False


def client_key(request: Request) -> str:
    """Return the rate-limit bucket key for `request`. Never raises."""
    secret = settings.proxy_shared_secret
    if secret:
        presented = request.headers.get(PROXY_SECRET_HEADER, "")
        if _secret_matches(presented, secret):
            attested_ip = _valid_ip_or_none(request.headers.get(PROXY_CLIENT_IP_HEADER))
            if attested_ip is not None:
                return attested_ip

    if settings.rate_limit_trust_cf_header:
        cf_ip = _valid_ip_or_none(request.headers.get(CF_CONNECTING_IP_HEADER))
        if cf_ip is not None:
            return cf_ip

    return get_remote_address(request)
