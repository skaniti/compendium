"""Signed URLs for ``GET /captured-assets/{rel}``.

Archived page previews render in a sandboxed iframe (opaque origin), so the
browser treats its subresource requests as cross-site and withholds the
``SameSite=Lax`` session cookie; the Next.js proxy then has no bearer token
to inject and the asset route would 401. Instead the preview renderer signs
each asset URL for the viewing user: ``?u=<user_id>&exp=<unix>&sig=<sig>``.

``sig`` is base64url (no padding) HMAC-SHA256 over
``"<user_id>\\n<file_path>\\n<exp>"``, keyed by a subkey derived from the
JWT secret (no new secret to manage; the subkey keeps signatures from ever
being valid as anything else). ``exp`` is the end of the NEXT UTC day, so a
URL is valid for 24-48 h and is identical for every render within a UTC
day (the browser cache still hits).

The signature authorizes reading exactly that one file as that user; the
route still applies its ownership check to the signed user id.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from collections.abc import Callable

from backend.config.settings import settings

_DAY_SECONDS = 86400
_SUBKEY_LABEL = b"captured-assets-url-v1"
_ASCII_DIGITS = re.compile(r"[0-9]+")


def _subkey() -> bytes:
    return hmac.new(settings.jwt_secret_key.encode(), _SUBKEY_LABEL, hashlib.sha256).digest()


def _sign(user_id: int, file_path: str, exp: int) -> str:
    msg = f"{user_id}\n{file_path}\n{exp}".encode()
    digest = hmac.new(_subkey(), msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def asset_url_signer(user_id: int, *, now: float | None = None) -> Callable[[str], str]:
    """Return ``file_path -> signed /captured-assets URL`` for ``user_id``.

    ``exp`` is computed once, so every URL from one signer shares it.
    """
    current = time.time() if now is None else now
    exp = (int(current // _DAY_SECONDS) + 2) * _DAY_SECONDS

    def sign(file_path: str) -> str:
        sig = _sign(user_id, file_path, exp)
        return f"/captured-assets/{file_path}?u={user_id}&exp={exp}&sig={sig}"

    return sign


def verify_asset_signature(
    rel: str,
    u: str | None,
    exp: str | None,
    sig: str | None,
    *,
    now: float | None = None,
) -> int | None:
    """Return the signed user id if ``sig`` is valid for ``rel`` and unexpired."""
    try:
        if not rel or u is None or exp is None or not sig:
            return None
        if not _ASCII_DIGITS.fullmatch(u) or not _ASCII_DIGITS.fullmatch(exp):
            return None
        user_id = int(u)
        exp_i = int(exp)
        current = time.time() if now is None else now
        if exp_i <= current:
            return None
        expected = _sign(user_id, rel, exp_i)
        if not hmac.compare_digest(expected.encode(), sig.encode("ascii")):
            return None
        return user_id
    except (ValueError, TypeError, UnicodeError):
        return None
