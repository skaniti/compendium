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
    if not value:
        return None
    try:
        ip_address(value)
    except ValueError:
        return None
    return value


def client_key(request: Request) -> str:
    """Return the rate-limit bucket key for `request`. Never raises."""
    secret = settings.proxy_shared_secret
    if secret:
        presented = request.headers.get(PROXY_SECRET_HEADER, "")
        if hmac.compare_digest(presented, secret):
            attested_ip = _valid_ip_or_none(request.headers.get(PROXY_CLIENT_IP_HEADER))
            if attested_ip is not None:
                return attested_ip

    if settings.rate_limit_trust_cf_header:
        cf_ip = _valid_ip_or_none(request.headers.get(CF_CONNECTING_IP_HEADER))
        if cf_ip is not None:
            return cf_ip

    return get_remote_address(request)
