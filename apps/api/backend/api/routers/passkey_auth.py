"""Passkey sign-in and enrollment for the owner (owner-passkeys).

Only the owner web container reaches these paths: every request carries the
tailnet assert secret (proxyToBackend strips that header, so the /api/*
catch-all cannot), and they 404 unless passkeys are on (WEBAUTHN_RP_ID with
the tailnet login) and for any Cloudflare-borne request. The Tailscale login
must map to the account the passkey or enrollment link belongs to.
Statuses: 401 refused, 409 no passkey yet, 410 enrollment link unusable.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api import audit_ctx as _audit_ctx
from backend.api.main import limiter
from backend.api.routers.tailnet_auth import trust_browser
from backend.db import audit_repo, auth_repo
from backend.services import auth_service, passkeys, tailnet_login

router = APIRouter(prefix="/api/auth/passkey", tags=["Auth"])

_LINK_REASONS = frozenset({"unknown", "expired", "used", "identity"})


class LoginOptionsRequest(BaseModel):
    tailnet_login: str = Field(..., min_length=1, max_length=320)


class LoginVerifyRequest(LoginOptionsRequest):
    response: dict
    trust_browser: bool = False


class EnrollOptionsRequest(LoginOptionsRequest):
    enrollment_token: str = Field(..., min_length=1, max_length=200)


class EnrollVerifyRequest(EnrollOptionsRequest):
    response: dict
    trust_browser: bool = False


def _guard(request: Request) -> None:
    if not passkeys.enabled() or request.headers.get("cf-connecting-ip") is not None:
        raise HTTPException(status_code=404, detail="Not Found")


def _record(request: Request, event: str, user_id: int | None, detail: dict, *, actor: bool = False) -> None:
    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        event,
        actor_user_id=user_id if actor else None,
        subject_user_id=user_id,
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail=detail,
    )


def _login_failed(request: Request, reason: str, user_id: int | None = None) -> HTTPException:
    _record(request, "auth.login.failed", user_id, {"method": "passkey", "reason": reason})
    if reason == "no_passkey":
        return HTTPException(status_code=409, detail="no_passkey")
    return HTTPException(status_code=401, detail="Invalid credentials")


def _enroll_failed(request: Request, reason: str, user_id: int | None = None) -> HTTPException:
    _record(request, "auth.passkey.register_failed", user_id, {"reason": reason})
    if reason in _LINK_REASONS:
        return HTTPException(status_code=410, detail="enrollment_unusable")
    return HTTPException(status_code=401, detail="Invalid credentials")


def _mapped_account(request: Request, login: str) -> tuple[dict | None, str]:
    if not tailnet_login.assert_ok(request.headers.get(tailnet_login.TAILNET_ASSERT_HEADER)):
        return None, "assert"
    user = tailnet_login.resolve_account(login)
    return (user, "") if user else (None, "login")


def _session(request: Request, user: dict, *, trust: bool, passkey_id: int) -> dict:
    role = auth_repo.get_role(user["id"])
    remembered = role != "demo" and auth_service.ingress_trusted(request.headers)
    access_token = auth_service.create_access_token(user["id"], user["email"])
    refresh_token = auth_service.create_refresh_token(user["id"], remembered=remembered)
    browser = trust_browser(request, user) if trust else None
    detail = {"role": role, "remembered": remembered, "method": "passkey", "passkey_id": passkey_id}
    if browser:
        detail["trusted_browser_id"] = browser[1]
    _record(request, "auth.login.ok", user["id"], detail, actor=True)
    body = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {"id": user["id"], "email": user["email"], "name": user["name"]},
        "session_policy": auth_service.session_policy(role, remembered),
    }
    if browser:
        body["browser_token"] = browser[0]
    return body


@router.post("/login/options")
@limiter.limit("20/minute")
async def login_options(request: Request, body: LoginOptionsRequest):
    _guard(request)
    user, reason = _mapped_account(request, body.tailnet_login)
    if user is None:
        raise _login_failed(request, reason)
    try:
        return {"options": passkeys.login_options(user)}
    except passkeys.PasskeyFailure as failure:
        raise _login_failed(request, failure.reason, user["id"]) from None


@router.post("/login/verify")
@limiter.limit("10/minute")
async def login_verify(request: Request, body: LoginVerifyRequest):
    _guard(request)
    user, reason = _mapped_account(request, body.tailnet_login)
    if user is None:
        raise _login_failed(request, reason)
    try:
        cred = passkeys.login_verify(user, body.response)
    except passkeys.PasskeyFailure as failure:
        raise _login_failed(request, failure.reason, user["id"]) from None
    return _session(request, user, trust=body.trust_browser, passkey_id=cred["id"])


@router.post("/enroll/options")
@limiter.limit("20/minute")
async def enroll_options(request: Request, body: EnrollOptionsRequest):
    _guard(request)
    user, _ = _mapped_account(request, body.tailnet_login)
    if user is None:
        raise _enroll_failed(request, "identity")
    try:
        return {"options": passkeys.enroll_options(user, body.enrollment_token)}
    except passkeys.PasskeyFailure as failure:
        raise _enroll_failed(request, failure.reason, user["id"]) from None


@router.post("/enroll/verify")
@limiter.limit("10/minute")
async def enroll_verify(request: Request, body: EnrollVerifyRequest):
    _guard(request)
    user, _ = _mapped_account(request, body.tailnet_login)
    if user is None:
        raise _enroll_failed(request, "identity")
    try:
        cred_id, label, backup_eligible = passkeys.enroll_verify(user, body.enrollment_token, body.response)
    except passkeys.PasskeyFailure as failure:
        raise _enroll_failed(request, failure.reason, user["id"]) from None
    _record(
        request,
        "auth.passkey.registered",
        user["id"],
        {"passkey_id": cred_id, "label": label, "backup_eligible": backup_eligible},
        actor=True,
    )
    return _session(request, user, trust=body.trust_browser, passkey_id=cred_id)
