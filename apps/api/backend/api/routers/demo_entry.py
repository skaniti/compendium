"""One-click public demo entry (demo-one-click-entry, 2026-10-09).

POST /api/auth/demo mints a 24-hour, never-remembered session for the single
``demo`` account after Cloudflare Turnstile confirms the visitor passed the
challenge. The route answers 404 unless DEMO_PUBLIC_ENTRY is set, which only
the public demo stack does (settings refuse it alongside
TAILNET_ONLY_DEPLOYMENT). Tokens and the secret never reach logs or audit
rows; the audit detail carries a reason and Cloudflare's error codes only.
"""

from __future__ import annotations

from datetime import timedelta

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api import audit_ctx as _audit_ctx
from backend.api.main import limiter
from backend.api.rate_limit_key import client_key
from backend.config.settings import settings
from backend.db import audit_repo, auth_repo
from backend.services import auth_service

router = APIRouter(prefix="/api/auth", tags=["Auth"])

VERIFY_TIMEOUT_SECONDS = 3.0
DEMO_SESSION_HOURS = 24


class DemoEntryRequest(BaseModel):
    turnstile_token: str = Field(..., min_length=1, max_length=2048)


async def verify_turnstile(token: str, remoteip: str) -> tuple[bool, list[str]] | None:
    """Ask Cloudflare whether ``token`` is a passed challenge.

    Returns (success, error_codes), or None when siteverify could not be
    reached or answered with a non-200 status (the caller maps None to 503).
    """
    try:
        async with httpx.AsyncClient(timeout=VERIFY_TIMEOUT_SECONDS) as http:
            res = await http.post(
                settings.turnstile_verify_url,
                data={"secret": settings.turnstile_secret_key, "response": token, "remoteip": remoteip},
            )
    except httpx.HTTPError:
        return None
    if res.status_code != 200:
        return None
    try:
        body = res.json()
    except ValueError:
        return None
    codes = body.get("error-codes") or []
    return bool(body.get("success")), [str(c) for c in codes][:10]


def _fail(request: Request, status: int, detail: str, reason: str, error_codes: list[str] | None = None):
    ctx = _audit_ctx.from_request(request)
    audit_detail: dict = {"reason": reason}
    if error_codes:
        audit_detail["error_codes"] = error_codes
    audit_repo.record(
        "auth.demo_entry.failed",
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail=audit_detail,
    )
    return HTTPException(status_code=status, detail=detail)


@router.post("/demo")
@limiter.limit("5/minute")
async def demo_entry(request: Request, body: DemoEntryRequest):
    if not settings.demo_public_entry:
        raise HTTPException(status_code=404, detail="Not Found")

    verdict = await verify_turnstile(body.turnstile_token, client_key(request))
    if verdict is None:
        raise _fail(request, 503, "Challenge service unavailable", "verify_unavailable")
    ok, codes = verdict
    if not ok:
        raise _fail(request, 403, "Challenge failed", "challenge", codes)

    try:
        user = auth_repo.get_user_by_role("demo")
    except RuntimeError:
        user = None
    if user is None:
        raise _fail(request, 503, "Demo account unavailable", "no_demo_account")

    access_token = auth_service.create_access_token(user["id"], user["email"])
    refresh_token = auth_service.create_refresh_token(
        user["id"], remembered=False, expires_in=timedelta(hours=DEMO_SESSION_HOURS)
    )
    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        "auth.demo_entry.ok",
        actor_user_id=user["id"],
        subject_user_id=user["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail={"refresh_hours": DEMO_SESSION_HOURS},
    )
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {"id": user["id"], "email": user["email"], "name": user["name"]},
        "session_policy": auth_service.session_policy("demo", False),
    }
