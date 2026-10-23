"""Name the client behind a rejected request (backlog #77).

A rejected request used to leave only method, path, status and a hashed
address, so a stale-key extension and a refused browser preflight could not be
told apart from any other caller. This module turns the request headers into a
small, safe dict that the request log (4xx lines) and the `api_key.auth_failed`
audit detail both carry.

Everything here is client-supplied DATA, never authentication: a caller can
claim any kind, version or device label. Values are sanitised (control,
bidi and line-separator characters stripped), redacted when shaped like a
credential, and truncated, in that order, before they reach a log line or a
database row. Dependency-light on purpose (no settings, no db) so the
audit path and the middleware can both import it without a cycle.

Headers the collectors send (apps/extension/modules/config.js::buildHeaders;
the Android half is SessionExporter.kt):

  X-Compendium-Client: <kind>[/<version>]   kind in extension | android | web
  X-Compendium-Device: <percent-encoded UTF-8 device label>

With no usable client header the kind is inferred from Origin / Sec-Fetch-Mode,
which names a build that predates the header and a refused CORS preflight
(preflights carry no custom headers). A User-Agent alone never implies a kind:
the Android collector's is browser-shaped.
"""

import logging
import re
from collections.abc import Iterable, Mapping
from typing import Any
from urllib.parse import unquote

from backend.db.audit_repo import SECRET_SHAPES

logger = logging.getLogger(__name__)

CLIENT_HEADER = "X-Compendium-Client"
DEVICE_HEADER = "X-Compendium-Device"

KNOWN_KINDS = frozenset({"extension", "android", "web"})

_REDACTED = "<redacted>"
_MAX_DEVICE = 64
_MAX_ORIGIN = 100
_MAX_USER_AGENT = 200
_MAX_CORS_HEADERS = 200

_CLIENT_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_-]{0,31})(?:/([0-9A-Za-z._+-]{1,32}))?\s*$")
# C0/C1 controls become a space; bidi marks/overrides/isolates, zero-width
# marks and the Unicode line/paragraph separators (which can make a log line
# read differently from what it holds) are dropped.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_INVISIBLE_RE = re.compile(r"[\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]")
_EXTENSION_ORIGIN_PREFIXES = (
    "moz-extension://",
    "chrome-extension://",
    "safari-web-extension://",
    "ms-browser-extension://",
)


def _clean(value: str | None, limit: int) -> str | None:
    """Strip control/invisible characters, trim, redact, then truncate.

    A value shaped like a credential (the audit table's SECRET_SHAPES) comes
    back as "<redacted>" in full. The match runs on the whole cleaned value
    BEFORE the cut: truncating first could leave a key's head too short to
    match (cmp_ plus 19 characters) and still carry it into api.jsonl and the
    audit row. None when nothing is left.
    """
    if not value:
        return None
    value = _INVISIBLE_RE.sub("", _CONTROL_RE.sub(" ", value)).strip()
    if not value:
        return None
    if any(p.search(value) for p in SECRET_SHAPES):
        return _REDACTED
    return value[:limit]


def _parse_client(value: str | None) -> tuple[str | None, str | None]:
    """(kind, version) from a well-formed header naming a known kind, else (None, None)."""
    if not value:
        return None, None
    m = _CLIENT_RE.match(value)
    if not m:
        return None, None
    kind = m.group(1).lower()
    if kind not in KNOWN_KINDS:
        return None, None
    return kind, m.group(2)


def _infer_kind(origin: str | None, headers: Any) -> str:
    if origin:
        lowered = origin.lower()
        if lowered.startswith(_EXTENSION_ORIGIN_PREFIXES):
            return "extension"
        if lowered.startswith(("http://", "https://")):
            return "web"
    if headers.get("sec-fetch-mode"):  # only browsers send Sec-Fetch-*
        return "web"
    return "unknown"


def describe(headers: Any) -> dict[str, str]:
    """Identity of the caller as a flat dict of short strings. Never raises.

    Always has `client` (extension | android | web | unknown). Optional:
    `client_version`, `device`, `origin`, `user_agent`.
    """
    try:
        origin = _clean(headers.get("origin"), _MAX_ORIGIN)
        kind, version = _parse_client(headers.get(CLIENT_HEADER))
        if kind is None:
            kind = _infer_kind(headers.get("origin"), headers)
        out: dict[str, str] = {"client": kind}
        if version:
            out["client_version"] = version
        raw_device = headers.get(DEVICE_HEADER)
        device = _clean(unquote(raw_device, errors="replace") if raw_device else None, _MAX_DEVICE)
        if device:
            out["device"] = device
        if origin:
            out["origin"] = origin
        user_agent = _clean(headers.get("user-agent"), _MAX_USER_AGENT)
        if user_agent:
            out["user_agent"] = user_agent
        return out
    except Exception:  # noqa: BLE001 - naming a client must never break a request
        return {"client": "unknown"}


def rejection_log_fields(
    *,
    method: str,
    status_code: int,
    headers: Any,
    allowed_origins: Iterable[str] | Mapping[str, Any],
) -> dict[str, Any]:
    """Extra fields for the request-completed line of a 4xx response.

    Adds the CORS preflight facts when the response is a refused preflight:
    CORSMiddleware answers a disallowed preflight (OPTIONS + Origin +
    Access-Control-Request-Method) with a bare 400 and no other record.
    """
    fields: dict[str, Any] = dict(describe(headers))
    try:
        if (
            method == "OPTIONS"
            and status_code == 400
            and headers.get("origin")
            and headers.get("access-control-request-method")
        ):
            allowed = list(allowed_origins)
            fields["cors_preflight_rejected"] = True
            fields["cors_origin_allowed"] = "*" in allowed or headers.get("origin") in allowed
            requested_method = _clean(headers.get("access-control-request-method"), 16)
            if requested_method:
                fields["cors_request_method"] = requested_method
            requested_headers = _clean(
                headers.get("access-control-request-headers"), _MAX_CORS_HEADERS
            )
            if requested_headers:
                fields["cors_request_headers"] = requested_headers
    except Exception:  # a log line must never break a response
        logger.debug("cors preflight fields unavailable", exc_info=True)
    return fields
