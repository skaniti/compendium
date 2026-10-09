"""Passwordless owner sign-in over the tailnet (tailnet-passwordless-login).

Only the owner web container can call these: every request must carry the
shared TAILNET_ASSERT_SECRET (header X-Compendium-Tailnet-Assert). Both
endpoints 404 unless tailnet login is fully configured on a tailnet-only
deployment, and for any request that came through Cloudflare. A session
also needs a trusted-browser token, created only by a password sign-in
(/trust takes that sign-in's bearer token).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api import audit_ctx as _audit_ctx
from backend.api.main import limiter
from backend.db import audit_repo, auth_repo, trusted_browser_repo
from backend.services import auth_service, tailnet_login

router = APIRouter(prefix="/api/auth/tailnet", tags=["Auth"])


class TrustRequest(BaseModel):
    tailnet_login: str = Field(..., min_length=1, max_length=320)
    label: str | None = Field(None, max_length=1000)


class TailnetLoginRequest(BaseModel):
    tailnet_login: str = Field(..., min_length=1, max_length=320)
    browser_token: str = Field(..., min_length=1, max_length=200)


def _guard(request: Request) -> None:
    if not tailnet_login.enabled() or request.headers.get("cf-connecting-ip") is not None:
        raise HTTPException(status_code=404, detail="Not Found")


def _fail(request: Request, reason: str, subject_user_id: int | None = None) -> HTTPException:
    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        "auth.login.failed",
        subject_user_id=subject_user_id,
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail={"method": "tailnet", "reason": reason},
    )
    return HTTPException(status_code=401, detail="Invalid credentials")


def _account(request: Request, login: str) -> dict:
    if not tailnet_login.assert_ok(request.headers.get(tailnet_login.TAILNET_ASSERT_HEADER)):
        raise _fail(request, "assert")
    user = tailnet_login.resolve_account(login)
    if user is None:
        raise _fail(request, "login")
    return user


def _bearer_claims(request: Request) -> dict | None:
    # Decoded here, not via verify_api_key: no dev-mode bypass and no
    # API-key fallback -- registering a browser needs a real sign-in token.
    authorization = request.headers.get("authorization") or ""
    if not authorization.startswith("Bearer "):
        return None
    return auth_service.decode_access_token(authorization[7:])


@router.post("/trust")
@limiter.limit("10/minute")
async def trust_browser(request: Request, body: TrustRequest):
    """Register the calling browser as trusted for the mapped account."""
    _guard(request)
    user = _account(request, body.tailnet_login)
    claims = _bearer_claims(request)
    if not claims or not claims.get("sub"):
        raise _fail(request, "bearer", user["id"])
    if claims.get("acting_as_demo"):
        raise _fail(request, "acting", user["id"])
    if int(claims["sub"]) != user["id"]:
        raise _fail(request, "user", user["id"])

    raw, token_hash = tailnet_login.new_browser_token()
    label = (body.label or "").strip()[:200] or None
    browser_id = trusted_browser_repo.create(user["id"], token_hash, label)
    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        "auth.trusted_browser.added",
        actor_user_id=user["id"],
        subject_user_id=user["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail={"trusted_browser_id": browser_id},
    )
    return {"browser_token": raw, "browser_id": browser_id}


@router.post("/login")
@limiter.limit("10/minute")
async def tailnet_sign_in(request: Request, body: TailnetLoginRequest):
    """Sign in a trusted browser of the mapped account; remembered session."""
    _guard(request)
    user = _account(request, body.tailnet_login)
    row = trusted_browser_repo.get_active(tailnet_login.hash_browser_token(body.browser_token))
    if row is None or row["user_id"] != user["id"]:
        raise _fail(request, "token", user["id"])
    trusted_browser_repo.touch(row["id"])

    role = auth_repo.get_role(user["id"])
    access_token = auth_service.create_access_token(user["id"], user["email"])
    refresh_token = auth_service.create_refresh_token(user["id"], remembered=True)
    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        "auth.login.ok",
        actor_user_id=user["id"],
        subject_user_id=user["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail={"role": role, "remembered": True, "method": "tailnet", "trusted_browser_id": row["id"]},
    )
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {"id": user["id"], "email": user["email"], "name": user["name"]},
        "session_policy": auth_service.session_policy(role, True),
    }
