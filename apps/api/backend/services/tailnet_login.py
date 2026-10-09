"""Passwordless owner sign-in over the tailnet (tailnet-passwordless-login).

The owner web container asserts the Tailscale login `tailscale serve` put on
the request, presenting TAILNET_ASSERT_SECRET; the API maps the login to an
account (TAILNET_LOGIN_MAP) and checks a trusted-browser token. See
backend/api/routers/tailnet_auth.py for the endpoints.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from backend.config.settings import parse_tailnet_login_map, settings
from backend.db import auth_repo

TAILNET_ASSERT_HEADER = "X-Compendium-Tailnet-Assert"


def enabled() -> bool:
    return bool(
        settings.tailnet_only_deployment
        and settings.tailnet_assert_secret
        and parse_tailnet_login_map(settings.tailnet_login_map)
    )


def assert_ok(presented: str | None) -> bool:
    secret = settings.tailnet_assert_secret
    if not secret or not presented:
        return False
    return hmac.compare_digest(presented.encode(), secret.encode())


def resolve_account(tailnet_login: str) -> dict | None:
    """The mapped, existing, non-demo account for this Tailscale login."""
    account = parse_tailnet_login_map(settings.tailnet_login_map).get(
        tailnet_login.strip().lower()
    )
    if not account:
        return None
    user = auth_repo.get_user_by_login(account)
    if user is None or auth_repo.get_role(user["id"]) == "demo":
        return None
    return user


def hash_browser_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_browser_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(32)
    return raw, hash_browser_token(raw)
