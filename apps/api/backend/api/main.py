"""FastAPI application entry point."""

import asyncio
import json
import logging
import os
import time
import uuid
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

from fastapi import BackgroundTasks, Depends, FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pythonjsonlogger import json as json_log
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from backend.api import audit_ctx as _audit_ctx
from backend.api.rate_limit_key import client_key
from backend.config.settings import settings
from backend.db import (
    annotation_repo,
    audit_repo,
    capture_repo,
    page_repo,
    tag_repo,
    user_repo,
)
from backend.db.connection import close_pool, set_current_user_id
from backend.db.page_repo import get_pending_captures

# Lazy-loaded to avoid circular import (process_captures -> main -> process_captures).
# Assigned to module scope so sweep_pending_once can call them by bare name and
# tests can patch them via patch.object(main, "<name>", ...).
# Populated on first call of sweep_pending_once; replaced by mocks during tests.
build_capture_input_from_db = None  # type: ignore[assignment]
update_pages_from_response = None  # type: ignore[assignment]

# LangSmith tracing — graceful no-op if not configured.
# Note: os.environ sync for the LangSmith SDK happens in backend.config.settings
# on import, which has already run by this point.
try:
    from langsmith import traceable as langsmith_traceable
except ImportError:

    def langsmith_traceable(**kwargs):  # type: ignore[misc]
        """No-op decorator when langsmith is not installed."""

        def decorator(fn):
            return fn

        return decorator


# Configure structured JSON logging
_log_formatter = json_log.JsonFormatter(
    fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"},
)
_log_handler = logging.StreamHandler()
_log_handler.setFormatter(_log_formatter)

# In-process ring buffer for the Live Log Stream dev page (see log_buffer.py).
# Attached at root so every logger.info/.warning/.error in the codebase flows
# through it without producer changes. Keeps the JSON stdout handler intact
# for log aggregators in production.
from backend.api.log_buffer import get_buffer  # noqa: E402

_log_ring_buffer = get_buffer()
_log_ring_buffer.setLevel(logging.DEBUG)  # capture finer than stdout for browser viewer

logging.root.handlers = [_log_handler, _log_ring_buffer]
logging.root.setLevel(getattr(logging, settings.log_level))
logger = logging.getLogger(__name__)

# Optional JSON file log (LOG_FILE_PATH), same formatter/level as stdout.
# Failure to open logs a WARNING and continues on stdout only.
from backend.api.log_file import attach_file_handler  # noqa: E402

attach_file_handler(
    logging.root,
    settings.log_file_path,
    _log_formatter,
    logging.root.level,
    warn_logger=logger,
)

# ---------------------------------------------------------------------------
# Application metrics (in-memory counters for /metrics endpoint)
# ---------------------------------------------------------------------------
_app_start_time = time.time()
_metrics_lock = Lock()
_request_counts: Counter = Counter()
_error_counts: Counter = Counter()
_captures_processed = 0

# Semaphore limits concurrent background processing to 1 at a time.
# Shared by endpoint-triggered processing and startup sweep.
_capture_processing_semaphore = asyncio.Semaphore(1)


def get_default_user_id() -> int:
    """Resolve the active user_id for an in-process call site.

    Resolution order:
        1. Flask session ``user_id`` (set by Dash's ``/__login`` route after
           a successful password verify) -- used both in dev and prod once
           the user is logged in.
        2. ``DEV_DEFAULT_USER_EMAIL`` env var, then ``BOOTSTRAP_EMAIL``, then
           the legacy ``dev@localhost`` -- looked up in DB.
        3. Auto-create the legacy ``dev@localhost`` row (fresh-checkout safety).

    The security boundary lives elsewhere:
        - HTTP API endpoints use ``Depends(verify_api_key)``, which in
          production rejects unauthenticated requests with 401 regardless of
          what this resolver returns.
        - Dash UI is gated by the layout dispatcher in ``frontend/dash/app.py``,
          which serves the login form pre-auth so the full layout's callbacks
          never fire without a session.

    This function is therefore safe to call at module-load (no request context)
    and from any callback. Production module-load still resolves a sensible
    user via path (2) -- typically the bootstrap user -- so global state
    initialization works before anyone logs in.
    """
    import os

    from backend.db.connection import get_conn

    # 1. Flask session (authenticated request context).
    try:
        from flask import has_request_context, session

        if has_request_context() and session.get("user_id"):
            return int(session["user_id"])
    except Exception:
        pass

    # 2. Env-driven email lookup.
    # Read both os.environ AND settings (which pydantic loads from .env).
    # The os.environ path catches shell-exported vars (e.g. CI/prod);
    # the settings path catches the common case where .env was loaded by
    # pydantic but never pushed back to os.environ. Without the settings
    # fallback, a developer with .env correctly populated but no shell
    # exports would silently resolve to ``dev@localhost`` (bug observed
    # 2026-04-27 -- the "loading compendium..." overlay never resolved
    # because the FE callback queried user 157 instead of user 152).
    candidate_emails: list[str] = []
    for var in ("DEV_DEFAULT_USER_EMAIL", "BOOTSTRAP_EMAIL"):
        val = os.environ.get(var)
        if val and val not in candidate_emails:
            candidate_emails.append(val)
    for settings_email in (
        settings.dev_default_user_email,
        settings.bootstrap_email,
    ):
        if settings_email and settings_email not in candidate_emails:
            candidate_emails.append(settings_email)
    candidate_emails.append("dev@localhost")  # legacy fallback

    for email in candidate_emails:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE email = %s LIMIT 1", (email,))
                row = cur.fetchone()
                if row:
                    return row[0]

    # 3. Final fallback: create the legacy dev user (preserves old behaviour
    # for fresh checkouts that haven't run the bootstrap script yet).
    result = user_repo.create_user("dev@localhost", name="Local Developer")
    return result["id"]


def _record_learning_gate_cost(lg_response, page_url: str | None = None) -> None:
    """Emit a learning_gate cost_event, mirroring the skip_gate pattern.
    Best-effort: never raises into the capture pipeline."""
    try:
        from backend.db import trends_repo

        trends_repo.insert_cost_event(
            user_id=get_default_user_id(),
            event_type="learning_gate",
            model=LEARNING_GATE_MODEL,
            input_tokens=lg_response.input_tokens,
            output_tokens=lg_response.output_tokens,
            cost_usd=lg_response.cost_usd,
            latency_ms=getattr(lg_response, "latency_ms", None),
            metadata={"page_url": page_url} if page_url else None,
        )
    except Exception:
        logger.debug("trends learning_gate cost event insert failed", exc_info=True)


async def verify_api_key(
    request: Request,
    x_api_key: str | None = Header(None),
    authorization: str | None = Header(None),
) -> int:
    """FastAPI dependency: authenticates via JWT Bearer token or X-API-Key.

    A present, successfully-decoding Bearer token wins in every mode. The
    development-mode bypass (resolve to the default dev user) applies only
    when no usable token was sent — it must NOT preempt a real token, or
    the demo JWT minted by /api/auth/view-as gets discarded and the view-as
    round trip is inert in local dev. Dev mode still never 401s: a
    stale/expired token degrades to the dev-default identity, preserving
    anonymous local-dev ergonomics.
    In production, tries JWT first (Authorization: Bearer <token>),
    then falls back to API key (X-API-Key header).
    Sets user_id for row-level security via set_current_user_id().

    X-API-Key contract is a three-way twin: this dependency, the header set
    in apps/extension/modules/config.js::buildHeaders, and the request in
    apps/android/.../SessionExporter.kt.
    """
    # Try JWT Bearer token first (all modes)
    if authorization and authorization.startswith("Bearer "):
        from backend.services.auth_service import decode_access_token

        token = authorization[7:]
        claims = decode_access_token(token)
        if claims and claims.get("sub"):
            uid = int(claims["sub"])
            set_current_user_id(uid)
            return uid

    if settings.is_development and settings.dev_auth_bypass:
        uid = get_default_user_id()
        set_current_user_id(uid)
        return uid

    # Fall back to API key
    if x_api_key:
        user = user_repo.get_user_by_api_key(x_api_key)
        if user is not None:
            set_current_user_id(user["id"])
            return user["id"]
        ctx = _audit_ctx.from_request(request)
        audit_repo.record(
            "api_key.auth_failed",
            origin_class=ctx.origin_class,
            client_key=ctx.client_key,
            detail={"prefix": x_api_key[:8]},
        )

    from fastapi import HTTPException

    raise HTTPException(status_code=401, detail="Missing or invalid authentication")


async def get_current_claims(
    authorization: str | None = Header(None),
) -> dict:
    """FastAPI dependency: returns the current request's decoded JWT claims.

    Deliberately separate from ``verify_api_key`` rather than threading a
    new return value through it — this reads the same Bearer token
    independently and returns ``{}`` wherever there is no decodable JWT:
    an anonymous development-mode request (dev bypass), or a request
    authenticated via X-API-Key instead of a Bearer token. Like
    ``verify_api_key``, a present, successfully-decoding token wins in
    every mode — dev included — so the acting claims on a view-as demo
    token round-trip in local dev. Never raises — callers treat a
    missing/invalid claim as "not set", not an auth failure (that's still
    verify_api_key's job).

    Used by the view-as no-nest check, return-to-admin's marker check,
    ``/api/auth/me``'s ``acting_as_demo``/``admin_origin_email`` fields, and
    the preferences write gate for plain-demo accounts.
    """
    if authorization and authorization.startswith("Bearer "):
        from backend.services.auth_service import decode_access_token

        token = authorization[7:]
        claims = decode_access_token(token)
        if claims:
            return claims

    return {}


async def verify_not_plain_demo(
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
) -> int:
    """Reject direct-demo sessions for mutation endpoints.

    Mirrors Dash's role_guard.is_plain_demo(): a DIRECT demo login (role ==
    "demo", no acting_as_demo claim) may not perform structural mutations;
    an admin-launched view-as-demo session may. Same rule as the
    PATCH /api/auth/preferences gate in this module.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) == "demo" and not claims.get("acting_as_demo"):
        raise HTTPException(status_code=403, detail="Demo account is read-only")
    return user_id


async def verify_not_demo_identity(
    user_id: int = Depends(verify_api_key),
) -> int:
    """Reject ANY demo-role identity for collector-data ingest.

    Stricter than ``verify_not_plain_demo``: that gate deliberately lets an
    admin's view-as-demo token (``acting_as_demo`` claim) through so view-as
    can exercise write paths. Ingest must not -- a view-as session routed
    through the web proxy would otherwise file the admin's real browsing
    under the public demo account. The claim is intentionally ignored here.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) == "demo":
        raise HTTPException(status_code=403, detail="Demo account cannot ingest captures")
    return user_id


async def verify_admin_context(
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
) -> int:
    """Require an admin-context session for operator-only endpoints.

    Same predicate as the view-as/return-to-admin pair: a real admin role (re-checked from the
    DB via ``ar.get_role``, never trusted from the client) OR a token
    carrying ``acting_as_demo`` (an admin currently viewing as demo). A
    plain demo or regular-user login satisfies neither and gets 403.

    Used for endpoints that expose cross-user operational internals --
    application logs, dqBot findings -- which carry inferences about the
    real corpus and must not be readable from the public demo credential.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) != "admin" and not claims.get("acting_as_demo"):
        raise HTTPException(status_code=403, detail="Admin context required")
    return user_id


async def require_admin_not_viewing(
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
) -> int:
    """Admin role required, and not inside a view-as-demo session.

    Stricter than ``verify_admin_context``: a token carrying
    ``acting_as_demo`` is an admin viewing as demo and must not see
    admin-only tables such as the audit log.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) != "admin" or claims.get("acting_as_demo"):
        raise HTTPException(status_code=403, detail="Forbidden")
    return user_id


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown events."""
    # Startup
    logger.info("Starting Compendium API...")
    logger.info(f"Environment: {settings.environment}")
    logger.info(f"OpenAI configured: {settings.has_openai}")
    logger.info(f"Anthropic configured: {settings.has_anthropic}")

    # Start the persistent log writer (drains the ring buffer's queue
    # to the app_logs table in the background). Must come after the
    # logger setup at module top so the buffer already exists.
    _log_ring_buffer.start_db_writer()

    # Housekeeping: clean up expired/revoked refresh tokens
    try:
        from backend.db.auth_repo import cleanup_expired_tokens

        cleaned = cleanup_expired_tokens()
        if cleaned:
            logger.info(f"Startup: cleaned {cleaned} expired/revoked refresh tokens")
    except Exception:
        logger.debug("Startup: refresh token cleanup skipped", exc_info=True)

    # Sweep any pending captures left over from a previous run
    asyncio.create_task(_sweep_pending_captures())

    # Daily TTL: keep app_logs bounded
    asyncio.create_task(_prune_app_logs_loop())
    # Daily refresh-token sweep (demo-one-click-entry)
    app.state._token_cleanup_task = asyncio.create_task(_token_cleanup_loop())

    # Nightly scheduler for deferred-maintenance jobs (Milestone 14).
    # Off by default; enabled via ENABLE_NIGHTLY_MAINT=1. Runs registered
    # jobs once per day at local 03:00 (override with SCHEDULER_OVERRIDE_SECONDS
    # for smoke tests). Job registration is the responsibility of individual
    # services — this just starts the loop.
    from backend.services.scheduler import start_nightly_scheduler

    app.state._nightly_scheduler_task = start_nightly_scheduler()
    app.state._pending_sweep_task = asyncio.create_task(_pending_sweep_loop())

    # Preload SBERT + cross-encoder reranker so the first agent query
    # doesn't pay the model-load tax. The reranker (BAAI/bge-reranker-v2-m3,
    # ~1.5GB) downloads on first use which historically caused 144-169s
    # cold-start latency on the first chat after a process restart.
    #
    # Background task: doesn't block startup or healthcheck. If a query
    # lands during the load, the existing lazy-load paths in
    # sbert_loader.get_sbert_model and reranker.get_reranker are still
    # the gate -- so the worst case is "first query is slow once, like
    # before this change." Failure of preload is logged but doesn't kill
    # the app. run_in_executor offloads the synchronous SentenceTransformer
    # and FlagReranker constructors to the default thread pool so the
    # event loop stays responsive.
    async def _preload_encoders():
        try:
            loop = asyncio.get_running_loop()
            from backend.services.sbert_loader import get_sbert_model

            await loop.run_in_executor(None, get_sbert_model)
            logger.info("Preloaded SBERT encoder")
            from backend.services.reranker import get_reranker

            await loop.run_in_executor(None, get_reranker)
            logger.info("Preloaded cross-encoder reranker")
        except Exception:
            logger.exception(
                "Encoder preload failed; lazy-load fallback will still work"
            )

    app.state._preload_task = asyncio.create_task(_preload_encoders())

    yield

    # Shutdown
    logger.info("Shutting down Compendium API...")
    _log_ring_buffer.stop_db_writer(timeout=5.0)
    close_pool()


async def _prune_app_logs_loop(retention_days: int = 14, interval_hours: int = 24) -> None:
    """Background task: delete app_logs rows older than ``retention_days``.

    Runs once shortly after startup, then every ``interval_hours``.
    Failures are logged but never crash the loop — log table maintenance
    must not be load-bearing for the app.
    """
    await asyncio.sleep(60)  # let startup settle
    from backend.db import log_repo

    while True:
        try:
            deleted = await asyncio.to_thread(log_repo.prune_older_than, retention_days)
            if deleted:
                logger.info(f"app_logs prune: removed {deleted} rows older than {retention_days}d")
        except Exception:
            logger.exception("app_logs prune failed")
        await asyncio.sleep(interval_hours * 3600)


def cleanup_tokens_once() -> int:
    """Delete expired/revoked refresh tokens; never raises (housekeeping)."""
    try:
        from backend.db import auth_repo

        cleaned = auth_repo.cleanup_expired_tokens()
        if cleaned:
            logger.info(f"refresh token sweep: removed {cleaned} expired/revoked rows")
        return cleaned
    except Exception:
        logger.exception("refresh token sweep failed")
        return 0


async def _token_cleanup_loop(interval_hours: int = 24, *, initial_delay_seconds: int = 300) -> None:
    """Background task (demo-one-click-entry): the one-click demo mints a
    refresh row per visit, so expired rows are swept daily instead of only
    at startup."""
    await asyncio.sleep(initial_delay_seconds)
    while True:
        await asyncio.to_thread(cleanup_tokens_once)
        await asyncio.sleep(interval_hours * 3600)


async def sweep_pending_once(user_id: int | None = None) -> dict:
    """Process every capture that still has pending pages, once.

    Reused by the startup sweep, the periodic sweep loop, and nightly
    maintenance. Acquires the capture-processing semaphore per capture so it
    never overlaps live capture processing. Never raises -- per-capture errors
    are counted and logged. Returns a summary dict.
    """
    global build_capture_input_from_db, update_pages_from_response
    if build_capture_input_from_db is None:
        from backend.process_captures import (
            build_capture_input_from_db as _bicfdb,
            update_pages_from_response as _upfr,
        )
        build_capture_input_from_db = _bicfdb
        update_pages_from_response = _upfr

    if user_id is None:
        user_id = get_default_user_id()
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) == "demo":
        # The demo stack's default user is the demo account; its seed holds
        # deliberate pending pages that must never be re-processed.
        logger.info("pending-sweep: user %s is the demo account -- skipped", user_id)
        return {"captures_seen": 0, "processed": 0, "failed": 0, "cost_usd": 0.0, "skipped": "demo"}
    pending = get_pending_captures(user_id)
    processed = failed = 0
    cost = 0.0
    for cap in pending:
        async with _capture_processing_semaphore:
            try:
                capture_input = build_capture_input_from_db(cap)
                response = await process_capture(capture_input)
                update_pages_from_response(cap["id"], response)
                cost += float(response.total_llm_cost_usd or 0.0)
                processed += 1
            except Exception:
                logger.exception("pending-sweep failed: %s", cap.get("capture_id"))
                failed += 1
    return {"captures_seen": len(pending), "processed": processed, "failed": failed, "cost_usd": cost}


async def _sweep_pending_captures() -> None:
    """Startup pending drain (runs once, after a short grace)."""
    await asyncio.sleep(5)
    try:
        user_id = get_default_user_id()
        summary = await sweep_pending_once(user_id)
        logger.info(
            "Startup sweep: %d seen, %d processed, %d failed",
            summary["captures_seen"],
            summary["processed"],
            summary["failed"],
        )
        if summary.get("skipped"):
            return
        await _maybe_recluster(user_id)
    except Exception:
        logger.exception("Startup sweep aborted")


async def _pending_sweep_loop() -> None:
    """Periodic safety net: re-process stranded 'pending' captures on an
    interval so a missed per-capture background task can't strand data until
    nightly. No-op unless PENDING_SWEEP_INTERVAL_SECONDS is set (floor 60s).
    The startup sweep already covers t0, so the first tick waits one interval.
    """
    raw = os.getenv("PENDING_SWEEP_INTERVAL_SECONDS")
    if not raw:
        logger.info("pending-sweep loop: PENDING_SWEEP_INTERVAL_SECONDS unset -- off")
        return
    try:
        seconds = max(60.0, float(raw))
    except ValueError:
        logger.warning("pending-sweep loop: invalid PENDING_SWEEP_INTERVAL_SECONDS=%r -- off", raw)
        return
    logger.info("pending-sweep loop: every %.0fs", seconds)
    while True:
        await asyncio.sleep(seconds)
        try:
            summary = await sweep_pending_once()
            if summary["processed"]:
                logger.info("pending-sweep loop: processed %d capture(s)", summary["processed"])
                await _maybe_recluster(get_default_user_id())
        except Exception:
            logger.exception("pending-sweep loop: iteration failed")


# Create FastAPI app
# Interactive docs stay on in development only (mig-06 Task 2, user ruling,
# 2026-09-26): once the API gets its own public hostname (Cloudflare Tunnel
# straight to FastAPI, no Dash proxy filtering the path space in front) these
# three become directly reachable for the first time. Gating them here means
# they're never mounted outside development, not merely 404'd after the fact.
app = FastAPI(
    title="Compendium API",
    description="Generate journey summaries from browsing captures",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.is_development else None,
    redoc_url="/redoc" if settings.is_development else None,
    openapi_url="/openapi.json" if settings.is_development else None,
)

# Configure CORS — uses settings.cors_origins (comma-separated or "*")
# In production, auto-restrict wildcard origins to the frontend URL.
_cors_origins = [o.strip() for o in settings.cors_origins.split(",")]
if not settings.is_development and "*" in _cors_origins:
    logger.warning("CORS wildcard in production — restricting to frontend_url only")
    _cors_origins = [settings.frontend_url]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Rate limiting (slowapi) — protects auth, agent, and capture endpoints
#
# Task 7e (post-flip-closeout): keyed on client_key rather than the raw
# peer address -- behind the docker port map, every peer is the bridge
# gateway, so get_remote_address alone puts every caller in one shared
# bucket. client_key falls back to get_remote_address (today's behavior)
# until RATE_LIMIT_TRUST_CF_HEADER / PROXY_SHARED_SECRET are configured --
# see backend/api/rate_limit_key.py.
# ---------------------------------------------------------------------------
limiter = Limiter(key_func=client_key)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )


# ---------------------------------------------------------------------------
# Security middleware — response headers + request size limit
# ---------------------------------------------------------------------------
_MAX_REQUEST_BYTES = 10 * 1024 * 1024  # 10 MB

# Internal-only marker header: GET /api/pages/{pid}/preview sets this on its
# response (both the 200 and the 404 ownership-gate branches -- see
# get_archived_preview) to opt itself out of the default framing lockdown.
# It's the one route designed to be embedded in the Next.js topic-detail
# iframe (same-origin, via the Next proxy -- apps/web/components/
# TopicDetail.tsx). security_middleware below recognizes the marker, swaps
# in SAMEORIGIN + a matching CSP frame-ancestors directive, and strips the
# marker itself so it never reaches the client. Every other route is
# untouched and keeps DENY.
_PREVIEW_FRAME_MARKER = "X-Preview-Allow-Frame"


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    # Reject oversized requests before they hit endpoint logic
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _MAX_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large"})

    response = await call_next(request)

    # Standard security headers (API server — no CSP needed, except the
    # archived-page preview route, handled below)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    if _PREVIEW_FRAME_MARKER in response.headers:
        del response.headers[_PREVIEW_FRAME_MARKER]
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        existing_csp = response.headers.get("Content-Security-Policy")
        if not existing_csp:
            response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
        elif "frame-ancestors" not in existing_csp:
            # Merge rather than clobber, in case the handler ever grows its
            # own CSP directives.
            response.headers["Content-Security-Policy"] = f"{existing_csp}; frame-ancestors 'self'"
    else:
        response.headers["X-Frame-Options"] = "DENY"
    return response


# Endpoints that the dev UI polls every second. Logging them at INFO
# creates a self-feedback loop in the Live Log Stream view; demote to
# DEBUG so they're still captured (and queryable in the DB history)
# without flooding the live tail.
_QUIET_ACCESS_PATHS = frozenset({"/api/logs", "/health", "/metrics"})


# ---------------------------------------------------------------------------
# Observability middleware — request ID, timing, structured access log
# ---------------------------------------------------------------------------
@app.middleware("http")
async def observability_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    start = time.perf_counter()

    response = await call_next(request)

    duration_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Response-Time-Ms"] = f"{duration_ms:.1f}"

    path = request.url.path
    with _metrics_lock:
        _request_counts[path] += 1
        if response.status_code >= 400:
            _error_counts[path] += 1

    # Quiet polling endpoints unless they error. Any 4xx/5xx still gets INFO
    # so failures of even the quiet endpoints surface in the live tail.
    log_method = (
        logger.debug
        if path in _QUIET_ACCESS_PATHS and response.status_code < 400
        else logger.info
    )
    log_method(
        "request completed",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": path,
            "status_code": response.status_code,
            "duration_ms": round(duration_ms, 1),
        },
    )
    return response


# =============================================================================
# Health Check
# =============================================================================
@app.api_route("/health", methods=["GET", "HEAD"], tags=["Health"])  # HEAD: uptime pingers
async def health_check():
    """Health check endpoint with DB connectivity verification."""
    from backend.db.connection import get_conn

    db_ok = False
    db_latency_ms = None
    try:
        start = time.perf_counter()
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                db_ok = True
        db_latency_ms = round((time.perf_counter() - start) * 1000, 1)
    except Exception:
        pass

    return {
        "status": "healthy" if db_ok else "degraded",
        "version": "0.1.0",
        "environment": settings.environment,
        "db_connected": db_ok,
        "db_latency_ms": db_latency_ms,
        "uptime_seconds": round(time.time() - _app_start_time, 1),
    }


@app.get("/", tags=["Health"])
async def root():
    """Root endpoint."""
    return {
        "name": "Compendium API",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.get("/metrics", tags=["Observability"])
async def get_metrics():
    """Application metrics for monitoring dashboards."""
    return {
        "requests_by_path": dict(_request_counts),
        "errors_by_path": dict(_error_counts),
        "captures_processed": _captures_processed,
        "uptime_seconds": round(time.time() - _app_start_time, 1),
    }


@app.get("/api/admin/audit-events", tags=["Admin"])
async def list_audit_events(
    limit: int = 100,
    before_id: int | None = None,
    event: str | None = None,
    subject_user_id: int | None = None,
    user_id: int = Depends(require_admin_not_viewing),
):
    """Audit rows newest first. Admin only, not available in view-as sessions.

    ``limit`` is clamped to 1..500; page with ``before_id`` (the smallest id
    already seen).
    """
    rows = audit_repo.list_events(
        limit=limit, before_id=before_id, event=event, subject_user_id=subject_user_id
    )
    for row in rows:
        if row.get("at") is not None:
            row["at"] = row["at"].isoformat()
    return {"events": rows}


@app.get("/api/logs", tags=["Observability"])
async def get_logs(
    since: int = 0,
    limit: int = 500,
    level: str | None = None,
    source: str = "buffer",
    since_minutes: int | None = None,
    capture_id: str | None = None,
    component: str | None = None,
    search: str | None = None,
    user_id: int = Depends(verify_admin_context),
):
    """Tail of recent log records.

    Admin-context only. This route was previously unauthenticated, which --
    because Dash's ``/api/<path>`` proxy forwards it verbatim -- made the
    whole log stream readable from the public ``compendium.example.com``
    origin with no credential at all. The records carry cross-user
    operational detail (cluster/topic names inferred from the real corpus,
    captured domains, page counts), so the gate is admin rather than merely
    authenticated. The Dash Logs view is unaffected: its callbacks fetch
    through ``authed_client``, which attaches the session JWT.

    Two backing stores, selectable via ``source``:

    - ``buffer`` (default): the in-process ring buffer. Cursor-based;
      ``since`` is the last id the client saw. Cheapest path; covers
      live tail and the last few minutes.
    - ``db``: persisted ``app_logs`` table. Time-range and facet
      filters apply server-side. Use for "what happened earlier" queries.

    Restarting the server resets buffer ids, which clients detect by
    seeing a returned ``latest`` < the cursor they sent.

    Query params:
        since: (buffer) records with id > this. Default 0 = all.
        limit: cap on records (default 500, max 5000 for db / 2000 buffer).
        level: minimum level (DEBUG/INFO/WARNING/ERROR).
        source: ``buffer`` or ``db``.
        since_minutes: (db) limit to records from the last N minutes.
        capture_id: (db) exact-match capture id.
        component: (db) exact-match component badge.
        search: (db) substring against message/logger.
    """
    if source == "db":
        from datetime import datetime, timedelta, timezone

        from backend.db import log_repo

        since_ts = None
        if since_minutes:
            since_ts = datetime.now(tz=timezone.utc) - timedelta(minutes=since_minutes)
        limit = max(1, min(limit, log_repo.QUERY_HARD_LIMIT))
        records = log_repo.query(
            since_ts=since_ts,
            level=level,
            component=component,
            capture_id=capture_id,
            search=search,
            limit=limit,
        )
        return {
            "records": records,
            "latest": records[-1]["id"] if records else 0,
            "source": "db",
            "dropped_writes": _log_ring_buffer.dropped_writes(),
        }

    # Default: ring buffer (live tail)
    limit = max(1, min(limit, 2000))
    records = _log_ring_buffer.snapshot(since=since, limit=limit)
    if level:
        wanted = level.upper()
        order = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
        threshold = order.get(wanted, 20)
        records = [r for r in records if order.get(r.get("level", "INFO"), 20) >= threshold]
    return {
        "records": records,
        "latest": _log_ring_buffer.latest_id(),
        "source": "buffer",
        "dropped_writes": _log_ring_buffer.dropped_writes(),
    }


# =============================================================================
# API Routes (will be added as milestones progress)
# =============================================================================
# from backend.api.routes import captures
# app.include_router(captures.router, prefix="/api/captures", tags=["Captures"])


# =============================================================================
# Capture processing endpoint (Milestone 5: tool-calling smoke test)
# =============================================================================
from backend.models.capture import (
    CaptureInput,
    PageVisit,
    PageProcessingResult,
    TopicCluster,
    CaptureProcessingResponse,
    CaptureReceivedResponse,
)
from backend.services.llm_service import (
    LLMService,
    PAGE_PROCESSING_TOOLS,
)
from backend.services.content_fetcher import (
    fetch_wikipedia_content,
    fetch_youtube_metadata,
    fetch_stackoverflow_question,
    fetch_arxiv_paper,
    fetch_reddit_content,
    fetch_github_content,
    fetch_generic_content,
)
from backend.services.graph_service import load_graph
from backend.services.skip_categories import normalize_category
from fastapi import HTTPException

TOOL_SELECTION_MODEL = "gpt-4o-mini"

# Registry prompts the capture path calls, and the learning gate's model.
# Named so the Prompts dev view shows what the pipeline actually runs.
SKIP_GATE_PROMPT = "skip_gate_v2_3"
LEARNING_GATE_PROMPT = "learning_gate_v1"
LEARNING_GATE_MODEL = "gpt-4o-mini"

# Domains that should always be skipped — no content fetching, no LLM calls.
# Auth/SSO, financial portals, healthcare, search engines, AI chat UIs,
# social media SPAs, enterprise SaaS, and utility/non-content domains.
SKIP_DOMAINS: set[str] = {
    # Auth / SSO
    "accounts.google.com",
    "login.live.com",
    "login.microsoftonline.com",
    "auth.wikimedia.org",
    "account.samsung.com",
    "account.microsoft.com",
    "myaccount.microsoft.com",
    # Financial (privacy + no content)
    "www.paypal.com",
    # Search engines
    "duckduckgo.com",
    # AI tool auxiliary pages (not chat UIs — chat content is valuable)
    "code.claude.com",
    "platform.claude.com",
    "status.claude.com",
    "support.claude.com",
    "privacy.claude.com",
    # Social media SPAs
    "www.instagram.com",
    "www.facebook.com",
    "x.com",
    # Enterprise SaaS
    "www.myworkday.com",
    "app.zoom.us",
    "portal.azure.com",
    # Utility / non-content
    "mail.google.com",
    "calendar.google.com",
    "drive.google.com",
    "play.google.com",
    "chromewebstore.google.com",
    "analytics.google.com",
    "s3.amazonaws.com",
    "www.awesomescreenshot.com",
    "app.adjust.com",
    "localhost",
    "127.0.0.1",
    "wsl.localhost",
}

# Wildcard domain suffixes — any hostname ending with these is skipped.
# Empty by default; add your own institution-specific suffixes here (bank,
# brokerage, healthcare portal, SSO tenant, etc.) — this list is meant to be
# personalized per deployment, not shared across users.
SKIP_DOMAIN_SUFFIXES: tuple[str, ...] = ()


def _is_skip_domain(hostname: str) -> bool:
    """Check if a hostname should be auto-skipped."""
    if hostname in SKIP_DOMAINS:
        return True
    return any(hostname.endswith(suffix) for suffix in SKIP_DOMAIN_SUFFIXES)


# URL path patterns that should be skipped on otherwise-useful domains.
# Each entry: (domain_substring, path_substring_or_test)
SKIP_URL_PATTERNS: list[tuple[str, str]] = [
    # Google: maps and search result pages
    ("www.google.com", "/maps/"),
    ("www.google.com", "/maps?"),
    ("www.google.com", "/search?"),
    # YouTube: non-video pages
    ("www.youtube.com", "/results"),
    ("www.youtube.com", "/feed/"),
    # Reddit: listings, search, profiles (not /comments/ posts)
    ("www.reddit.com", "/search"),
    # GitHub: code views
    ("github.com", "/blob/"),
    ("github.com", "/tree/"),
]


# One line per special-case rule in _is_skip_url below (shown in the Pipeline rule-filter panel). TWIN: keep in step with the function.
SKIP_URL_PATH_RULES: tuple[str, ...] = (
    "reddit.com subreddit listings (/r/<name>), not posts",
    "youtube.com channel pages (/@<handle>)",
    "instructure.com module listings (/modules), not module items",
    "claude.ai app chrome (root, /new, /recents, /settings, /projects, /downloads, sign-in pages), never /chat/<id> transcripts",
)


def _is_skip_url(hostname: str, url: str) -> bool:
    """Check if a URL matches a path-based skip pattern."""
    for domain_sub, path_sub in SKIP_URL_PATTERNS:
        if domain_sub in hostname and path_sub in url:
            return True
    # Reddit subreddit listings: /r/name or /r/name/ but NOT /r/name/comments/
    if "reddit.com" in hostname and "/r/" in url and "/comments/" not in url:
        # Allow /r/sub/comments/ (posts), skip /r/sub (listing)
        import re

        if re.match(r"https?://[^/]+/r/[^/]+/?$", url):
            return True
    # YouTube: channel pages and other non-watch pages
    if "youtube.com" in hostname and "/@" in url:
        return True
    # Canvas /modules listing (but not /modules/items/)
    if "instructure.com" in hostname and "/modules" in url and "/items/" not in url:
        return True
    # claude.ai app chrome: composer/sidebar/settings/auth shells carry no
    # transcript content and shouldn't burn a Stage-1 LLM call. Real content
    # lives at /chat/<uuid>, which must stay capturable -- so this matches
    # only the known chrome-path prefixes (plus bare root), never the whole
    # domain. "/settings" must also catch "/settings/appearance" etc., so
    # this needs path-prefix semantics (regex + anchoring) rather than the
    # plain-substring SKIP_URL_PATTERNS list above.
    if hostname in ("claude.ai", "www.claude.ai"):
        import re

        path = urlparse(url).path or "/"
        if path == "/" or re.match(
            r"^/(new|recents|settings|projects|downloads|login|logout|oauth|magic-link)(/|$)",
            path,
        ):
            return True
    return False


# Deterministic domain → fetcher dispatch (replaces LLM URL routing)
DOMAIN_TO_FETCHER: dict[str, tuple[str, Any]] = {
    "wikipedia.org": ("fetch_wikipedia_content", fetch_wikipedia_content),
    "youtube.com": ("fetch_youtube_metadata", fetch_youtube_metadata),
    "youtu.be": ("fetch_youtube_metadata", fetch_youtube_metadata),
    # SE family (all routed through fetch_stackoverflow_question; the
    # SE API site-id is resolved per-URL inside the fetcher via
    # `_extract_se_site` so electronics.stackexchange.com / serverfault /
    # superuser / askubuntu / *.stackexchange.com all work uniformly).
    "stackoverflow.com": ("fetch_stackoverflow_question", fetch_stackoverflow_question),
    "stackexchange.com": ("fetch_stackoverflow_question", fetch_stackoverflow_question),
    "serverfault.com": ("fetch_stackoverflow_question", fetch_stackoverflow_question),
    "superuser.com": ("fetch_stackoverflow_question", fetch_stackoverflow_question),
    "askubuntu.com": ("fetch_stackoverflow_question", fetch_stackoverflow_question),
    "arxiv.org": ("fetch_arxiv_paper", fetch_arxiv_paper),
    "reddit.com": ("fetch_reddit_content", fetch_reddit_content),
    "github.com": ("fetch_github_content", fetch_github_content),
    # BGG: Cloudflare-protected, no API access — falls back to Readability
}

# Domain-agnostic fallback. Returned by `_match_fetcher` when no entry in
# DOMAIN_TO_FETCHER matches; runs trafilatura on the page HTML so curated
# URLs from blog posts, primary-source text dumps (Gutenberg), and product
# documentation pages can pass through Stage 0 without requiring a per-
# domain fetcher entry. Added 2026-05-08 after the demo-curation skip-gate
# dry-run surfaced 8 NO_FETCHER URLs across the v1 demo set.
_GENERIC_FETCHER: tuple[str, Any] = ("fetch_generic_content", fetch_generic_content)


def _match_fetcher(hostname: str) -> tuple[str, Any] | None:
    """Match a hostname to its content fetcher via substring lookup.

    Falls back to the generic trafilatura-based fetcher when no domain
    rule matches, so pages from arbitrary domains can still pass through
    Stage 0 without a per-domain integration.
    """
    for domain_key, fetcher_pair in DOMAIN_TO_FETCHER.items():
        if domain_key in hostname:
            return fetcher_pair
    if hostname:
        return _GENERIC_FETCHER
    return None


CAPTURES_DIR = Path(__file__).resolve().parents[2] / "data" / "captures"

# Guard against duplicate capture submissions (e.g., rapid stop-button clicks)
_processing_captures: set[str] = set()

# Recluster when this many active pages are unclustered
RECLUSTER_THRESHOLD = 50


def _count_unclustered_pages(user_id: int) -> int:
    """Count active pages added since the last completed recluster run.

    If no recluster has ever run, counts all active pages (bootstrap case).
    """
    from backend.db.connection import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Find when the last completed recluster started
            cur.execute(
                """
                SELECT started_at FROM recluster_runs
                WHERE user_id = %s AND status = 'completed'
                ORDER BY completed_at DESC LIMIT 1
            """,
                (user_id,),
            )
            row = cur.fetchone()

            if row is None:
                # No recluster has ever run — count all active pages
                cur.execute(
                    """
                    SELECT COUNT(*) FROM pages p
                    WHERE p.status = 'active' AND p.user_id = %s
                """,
                    (user_id,),
                )
            else:
                cur.execute(
                    """
                    SELECT COUNT(*) FROM pages p
                    WHERE p.status = 'active'
                      AND p.user_id = %s
                      AND p.created_at > %s
                """,
                    (user_id, row[0]),
                )

            return cur.fetchone()[0]


async def _maybe_recluster(user_id: int) -> None:
    """Trigger a recluster + graph rebuild if enough new pages have arrived."""
    from backend.services.clustering_service import ClusteringService as _CS
    from backend.services.graph_builder import build_graph_from_db as _build_graph
    from backend.services.graph_service import save_graph as _save_graph

    try:
        unclustered = _count_unclustered_pages(user_id)
        if unclustered < RECLUSTER_THRESHOLD:
            return

        logger.info(
            f"Auto-recluster: {unclustered} new pages since last run (threshold={RECLUSTER_THRESHOLD})"
        )
        svc = _CS(user_id=user_id)
        result = await svc.recluster_all()

        graph = _build_graph(user_id)
        _save_graph(graph, user_id)

        logger.info(
            f"Auto-recluster done: {result.get('cluster_count', '?')} clusters, "
            f"{len(graph.nodes)} nodes, {len(graph.edges)} edges"
        )
    except Exception:
        logger.exception("Auto-recluster failed")


async def _process_capture_background(
    cap_db_id: int, capture_input: "CaptureInput", user_id: int
) -> None:
    """Process a capture through the LLM pipeline in the background.

    Acquires the semaphore so only one capture processes at a time.
    Errors are logged but never propagate — the capture stays in
    'pending' status and can be retried via process_captures.py.

    ``user_id`` is captured from the originating request and threaded
    explicitly through to the asset archiver because the RLS thread-
    local (set by ``verify_api_key``) can be overwritten by later
    requests by the time this background task runs.
    """
    from backend.process_captures import update_pages_from_response

    async with _capture_processing_semaphore:
        try:
            logger.info(f"Background processing: {capture_input.capture_id}")
            response = await process_capture(capture_input)
            page_errors = update_pages_from_response(cap_db_id, response)
            if page_errors:
                logger.warning(
                    f"Background processing {capture_input.capture_id}: "
                    f"{page_errors} page(s) failed to persist"
                )
            # Archive referenced images now that content_ids are known.
            # Best-effort; failures never abort the background task.
            await _archive_assets_for_response(response, user_id)
            logger.info(
                f"Background processing done: {capture_input.capture_id} "
                f"(${response.total_llm_cost_usd or 0:.4f})"
            )
        except Exception:
            logger.exception(f"Background processing failed: {capture_input.capture_id}")

    # Check recluster threshold after processing (outside the semaphore)
    await _maybe_recluster(get_default_user_id())


async def _archive_assets_for_response(response, user_id: int) -> None:
    """Download + link image assets for every page whose raw_html was stored.

    Iterates `response.results` for entries that have both a populated
    `page_content_id` (set by `_persist_single_page`) and a raw_html
    artifact in `response.raw_html_artifacts`. Pages archived sequentially
    so concurrent DB writes don't contend; per-host rate limiting inside
    the archiver keeps upstream traffic polite.
    """
    from backend.services.asset_archiver import archive_assets_for_page

    candidates = [
        r
        for r in response.results
        if getattr(r, "page_content_id", None) is not None and r.url in response.raw_html_artifacts
    ]
    if not candidates:
        return
    for r in candidates:
        artifact = response.raw_html_artifacts.get(r.url)
        if not artifact or not artifact.get("gzipped"):
            continue
        try:
            await archive_assets_for_page(
                r.page_content_id,
                artifact["gzipped"],
                r.url,
                user_id,
            )
        except Exception:
            logger.exception(f"asset archive failed for pid={r.page_content_id}")


def _save_capture_to_db(
    capture: CaptureInput, user_id: int, source: str = "desktop_active"
) -> dict:
    """Persist capture + pages to PostgreSQL.

    Returns the capture dict with its DB id.
    """

    # Determine if trivial (< 3 tracked pages)
    tracked = [p for p in capture.pages if p.is_tracked_domain]
    is_trivial = len(tracked) < 3

    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture.capture_id,
        source=source,
        started_at=capture.started_at,
        ended_at=capture.ended_at,
        is_trivial=is_trivial,
        events=capture.model_dump(by_alias=True).get("events", []),
        device_label=capture.device_label,
        client_meta=capture.client_meta,
    )

    # Insert pages
    page_dicts = []
    for p in capture.pages:
        domain = urlparse(p.url).hostname or None
        page_dicts.append(
            {
                "url": p.url,
                "title": p.title,
                "domain": domain,
                "dwell_time_seconds": p.dwell_time_seconds,
                "visited_at": p.timestamp,
                "transition_type": p.transition_type,
                "transition_qualifiers": p.transition_qualifiers,
                "is_tracked_domain": p.is_tracked_domain,
                "extracted_text": p.extracted_text,
            }
        )
    page_ids = page_repo.insert_pages(cap["id"], page_dicts)
    cap["page_ids"] = page_ids

    logger.info(
        f"Saved capture {capture.capture_id} to DB: "
        f"capture_id={cap['id']}, {len(page_ids)} pages"
    )
    return cap


@app.post("/api/captures", tags=["Captures"], response_model=CaptureReceivedResponse)
@limiter.limit("20/minute")
async def create_capture(
    request: Request,
    capture: CaptureInput,
    background_tasks: BackgroundTasks,
    user_id: int = Depends(verify_not_demo_identity),
):
    """Receive a browsing capture, persist to PostgreSQL, and queue processing.

    Pages are saved with status='pending', then processed in the background
    through the LLM pipeline (content fetch + skip gate).
    """
    logger.info(f"Received capture: {capture.capture_id} ({len(capture.pages)} pages)")

    # Reject duplicate submissions
    if capture.capture_id in _processing_captures:
        logger.warning(f"Duplicate capture rejected: {capture.capture_id}")
        raise HTTPException(status_code=409, detail="Capture already being processed")

    # Check if already exists in DB
    existing = capture_repo.get_capture(capture.capture_id)
    if existing:
        raise HTTPException(status_code=409, detail="Capture already exists")

    _processing_captures.add(capture.capture_id)
    try:
        cap = _save_capture_to_db(capture, user_id)
    finally:
        _processing_captures.discard(capture.capture_id)

    # Queue background LLM processing (semaphore ensures sequential execution)
    background_tasks.add_task(_process_capture_background, cap["id"], capture, user_id)

    return CaptureReceivedResponse(
        capture_id=capture.capture_id,
        page_count=len(capture.pages),
        raw_dump_path=None,
        journey_url=f"{settings.frontend_url}?capture_id={capture.capture_id}",
    ).model_dump(by_alias=True)


def _apply_gate_tool_call(result, tool_name: str, arguments: dict) -> str:
    """Apply a skip-gate tool call to ``result``; return the free-text reasoning.

    A skip stores a normalized category (out-of-enum or missing -> ``other``);
    a process verdict leaves ``skip_category`` unset.
    """
    reasoning = str(arguments.get("reasoning") or arguments.get("reason") or "")
    if tool_name == "skip_page":
        result.processing_depth = "skipped"
        result.status = "skipped"
        result.skip_category = normalize_category(arguments.get("category"))
    else:
        result.processing_depth = "processed"
    result.processing_depth_reasoning = reasoning
    return reasoning


@langsmith_traceable(name="process_capture", run_type="chain")
async def process_capture(
    capture: CaptureInput,
    raw_path: Path | None = None,
    content_cache: dict[str, dict] | None = None,
):
    """Process a capture through the pipeline.

    Stage 0: Deterministic content fetching (dict lookup, no LLM)
    RAG:     Index fetched content into ChromaDB (optional)
    Stage 1: Binary skip gate (LLM tool call per page)
    Stage 4d: Capture title + mini-summary (no LLM)
    Persist: Full fetched content + processed results to JSON

    Args:
        capture: Parsed capture input (from extension or loaded from raw dump).
        raw_path: If provided, the processed dump filename will match the raw
                  dump filename. Otherwise a timestamp-based name is generated.
        content_cache: Pre-fetched URL→content dict from prior processed captures.
                       Pages found in the cache skip Stage 0 fetching.
    """
    llm = LLMService()
    results: list[PageProcessingResult] = []
    total_cost = 0.0
    capture_start = time.perf_counter()

    # Store fetched content for use in later stages
    fetched_content: dict[str, dict] = {}  # url -> content_dict

    # =========================================================================
    # Stage 0: Deterministic content fetching
    # =========================================================================
    logger.info(f"Stage 0: Fetching content for {len(capture.pages)} pages")

    cache_hits = 0
    domain_skips = 0
    for page in capture.pages:
        domain = urlparse(page.url).hostname or "unknown"

        # Pre-filter: skip domains that never yield useful content
        if _is_skip_domain(domain):
            dwell = page.dwell_time_seconds or 0
            results.append(
                PageProcessingResult(
                    url=page.url,
                    title=page.title,
                    domain=domain,
                    tool_selected=None,
                    status="catchall",
                    content_summary=f"Domain skipped (no extractable content): {domain} ({dwell}s)",
                    processing_depth="skipped",
                )
            )
            domain_skips += 1
            logger.debug(f"  [domain-skip] {domain}: {page.title}")
            continue

        # Pre-filter: skip URL patterns on otherwise-useful domains
        if _is_skip_url(domain, page.url):
            dwell = page.dwell_time_seconds or 0
            results.append(
                PageProcessingResult(
                    url=page.url,
                    title=page.title,
                    domain=domain,
                    tool_selected=None,
                    status="catchall",
                    content_summary=f"URL pattern skipped: {domain} ({dwell}s)",
                    processing_depth="skipped",
                )
            )
            domain_skips += 1
            logger.debug(f"  [url-skip] {domain}: {page.title}")
            continue

        # Dedup: reuse content from prior processed captures
        if content_cache and page.url in content_cache:
            cached = content_cache[page.url]
            fetched_content[page.url] = cached
            summary_parts = []
            for key in ("title", "summary", "abstract", "description"):
                if key in cached and cached[key]:
                    summary_parts.append(str(cached[key]))
            content_summary = " | ".join(summary_parts)[:300] if summary_parts else "Cached"
            results.append(
                PageProcessingResult(
                    url=page.url,
                    title=page.title,
                    domain=domain,
                    tool_selected="cache_hit",
                    status="success",
                    content_summary=content_summary,
                )
            )
            cache_hits += 1
            logger.info(f"  [cached] {domain}: {page.title}")
            continue

        # Non-tracked domains: use extracted text if available, else catchall
        if not page.is_tracked_domain:
            if page.extracted_text and len(page.extracted_text) > 50:
                content_dict = {
                    "url": page.url,
                    "title": page.title,
                    "text": page.extracted_text,
                    "source": "content_script",
                    "char_count": len(page.extracted_text),
                }
                fetched_content[page.url] = content_dict
                results.append(
                    PageProcessingResult(
                        url=page.url,
                        title=page.title,
                        domain=domain,
                        tool_selected="get_extracted_content",
                        status="success",
                        content_summary=page.extracted_text[:300],
                    )
                )
                logger.info(
                    f"  [extracted] {domain}: {page.title} ({len(page.extracted_text)} chars)"
                )
            else:
                dwell = page.dwell_time_seconds or 0
                results.append(
                    PageProcessingResult(
                        url=page.url,
                        title=page.title,
                        domain=domain,
                        tool_selected=None,
                        status="catchall",
                        content_summary=f"Page browsed outside API tool scope for {dwell} seconds",
                    )
                )
                logger.debug(f"  [catchall] {domain}: {page.title}")
            continue

        # Deterministic fetcher dispatch
        fetcher_match = _match_fetcher(domain)
        if fetcher_match is None:
            # Fallback: use extracted_text if available (resilience for tracked
            # domains that don't have a dedicated fetcher yet)
            if page.extracted_text and len(page.extracted_text) > 50:
                content_dict = {
                    "url": page.url,
                    "title": page.title,
                    "text": page.extracted_text,
                    "source": "content_script",
                    "char_count": len(page.extracted_text),
                }
                fetched_content[page.url] = content_dict
                results.append(
                    PageProcessingResult(
                        url=page.url,
                        title=page.title,
                        domain=domain,
                        tool_selected="get_extracted_content",
                        status="success",
                        content_summary=page.extracted_text[:300],
                    )
                )
                logger.info(
                    f"  [extracted fallback] {domain}: {page.title} ({len(page.extracted_text)} chars)"
                )
            else:
                dwell = page.dwell_time_seconds or 0
                results.append(
                    PageProcessingResult(
                        url=page.url,
                        title=page.title,
                        domain=domain,
                        tool_selected=None,
                        status="catchall",
                        content_summary=f"Tracked domain, no fetcher or extracted text: {domain} ({dwell}s)",
                    )
                )
                logger.debug(f"  [catchall] {domain}: no fetcher matched, no extracted text")
            continue

        tool_name, func = fetcher_match
        tool_args: dict[str, Any] = {"url": page.url}
        # M8: Wikipedia fetcher accepts an optional LLMService for vision-based
        # image descriptions. Other fetchers ignore the llm kwarg, so scope the
        # branch tightly to avoid silent behavioral drift on additions.
        if tool_name == "fetch_wikipedia_content":
            tool_args["llm"] = llm

        fetch_start = time.perf_counter()
        try:
            content = await func(**tool_args)
            fetch_ms = (time.perf_counter() - fetch_start) * 1000

            content_dict = content.model_dump()
            fetched_content[page.url] = content_dict

            # Use the fetcher-owned primary text contract so Reddit and any
            # future fetcher produce a meaningful content_summary instead of
            # falling through to the legacy key-guessing loop. See
            # backend/services/content_fetcher.py::get_primary_text_from_dict.
            from backend.services.content_fetcher import get_primary_text_from_dict

            primary_text, primary_source = get_primary_text_from_dict(tool_name, content_dict)
            content_summary = primary_text[:300] if primary_text else "Content fetched successfully"
            logger.debug(f"content_summary: tool={tool_name} source={primary_source}")

            results.append(
                PageProcessingResult(
                    url=page.url,
                    title=page.title,
                    domain=domain,
                    tool_selected=tool_name,
                    tool_arguments=tool_args,
                    status="success",
                    content_summary=content_summary,
                    latency_ms=fetch_ms,
                )
            )
            logger.info(f"  [fetched] {domain}: {content_summary[:80]}...")

        except Exception as e:
            results.append(
                PageProcessingResult(
                    url=page.url,
                    title=page.title,
                    domain=domain,
                    tool_selected=tool_name,
                    tool_arguments=tool_args,
                    status="error",
                    error_message=str(e),
                    latency_ms=(time.perf_counter() - fetch_start) * 1000,
                )
            )
            logger.error(f"  [error] {domain}: {e}")

    # =========================================================================
    # Raw HTML archival: store gzipped source HTML for iframe-previews.
    # Best-effort — failures here never block structured extraction.
    # Skip cache hits (the original capture already archived) and skip
    # non-success results. The backfill script at
    # scripts/migrations/backfill_raw_html.py handles any gaps.
    # =========================================================================
    from backend.services.raw_html_archiver import archive_raw_html

    raw_html_artifacts: dict[str, dict] = {}
    archivable_urls = [
        r.url
        for r in results
        if r.status == "success" and r.tool_selected != "cache_hit" and r.url in fetched_content
    ]
    if archivable_urls:
        archive_start = time.perf_counter()
        archive_tasks = [archive_raw_html(u) for u in archivable_urls]
        archive_results = await asyncio.gather(*archive_tasks, return_exceptions=True)
        for url, artifact in zip(archivable_urls, archive_results):
            if isinstance(artifact, BaseException):
                logger.warning("raw_html archive raised for %s: %s", url, artifact)
                continue
            if artifact is None:
                continue
            raw_html_artifacts[url] = {
                "gzipped": artifact.gzipped,
                "content_type": artifact.content_type,
            }
        archive_ms = (time.perf_counter() - archive_start) * 1000
        logger.info(
            "Raw HTML archived: %d/%d pages (%dms)",
            len(raw_html_artifacts),
            len(archivable_urls),
            archive_ms,
        )

    # =========================================================================
    # RAG: Index fetched content into vector store
    # =========================================================================
    rag = None
    try:
        from backend.services.rag_pipeline import RAGPipeline

        rag = RAGPipeline(collection_name=f"capture_{capture.capture_id}")
    except Exception as e:
        logger.warning(f"RAG init failed, will fall back to previews: {e}")
        rag = None

    if rag is not None:
        # Index each fetched page independently: one page that fails to
        # chunk/embed must NOT abort the rest of the capture's indexing. A
        # capture-wide try/except here was the April-2026 failure mode -- a
        # single error left most of an 86-page capture unindexed (see the
        # two-tier-rag-search / chunk-backfill plan folders).
        indexed = failed = 0
        for url, content_dict in fetched_content.items():
            try:
                await rag.add_document(url, content_dict, {"title": content_dict.get("title", "")})
                indexed += 1
            except Exception as e:
                failed += 1
                logger.warning(f"RAG indexing failed for {url}, skipping: {e}")
        logger.info(
            f"RAG: Indexed {rag.store.count} chunks from {indexed}/{len(fetched_content)} pages"
            + (f" ({failed} failed)" if failed else "")
        )

    # =========================================================================
    # Stage 1: Binary skip gate (skip junk pages, process everything else)
    # =========================================================================
    logger.info("Stage 1: Binary skip gate")

    for i, result in enumerate(results):
        # Only run skip gate on successfully fetched tracked pages
        if result.status != "success":
            continue

        page = capture.pages[i]
        content_dict = fetched_content.get(page.url, {})
        # Use the fetcher-owned primary-text contract so rich fields like
        # YouTube transcripts (description often empty) and GitHub READMEs
        # (full_text, not description) reach the gate. Without this, the
        # gate runs on title-only for any fetcher whose 'description' is
        # empty, which forces a category-prior decision (observed
        # 2026-05-08: false-negative on the Q3.1 ★ PWM-tutorial video).
        from backend.services.content_fetcher import get_primary_text_from_dict

        primary_text, _ = get_primary_text_from_dict(result.tool_selected, content_dict)
        content_snippet = (primary_text or "")[:500]

        from backend.prompts.templates import get_prompt

        skip_prompt = get_prompt(
            SKIP_GATE_PROMPT,
            title=page.title or "Unknown",
            url=page.url,
            domain=urlparse(page.url).hostname or "unknown",
            snippet_len=str(len(content_snippet)),
            snippet=content_snippet,
        )

        try:
            llm_response, tool_calls = await llm.select_tool(
                prompt=skip_prompt,
                tools=PAGE_PROCESSING_TOOLS,
                model=TOOL_SELECTION_MODEL,
                temperature=0.0,
            )
            total_cost += llm_response.cost_usd

            if tool_calls:
                tc = tool_calls[0]
                tool_name_dc = tc["name"]
                reasoning = _apply_gate_tool_call(result, tool_name_dc, tc["arguments"])
                result.input_tokens = llm_response.input_tokens
                result.output_tokens = llm_response.output_tokens
                result.cost_usd = llm_response.cost_usd

                # Record cost event for Trends view
                try:
                    from backend.db import trends_repo

                    trends_repo.insert_cost_event(
                        user_id=get_default_user_id(),
                        event_type="skip_gate",
                        model=TOOL_SELECTION_MODEL,
                        input_tokens=llm_response.input_tokens,
                        output_tokens=llm_response.output_tokens,
                        cost_usd=llm_response.cost_usd,
                    )
                except Exception:
                    logger.debug("trends cost event insert failed", exc_info=True)

                logger.info(
                    f"  [skip-gate] {page.title}: {result.processing_depth} "
                    f"({reasoning[:60]}...)"
                )
            else:
                result.processing_depth = "processed"
                logger.warning(f"  [skip-gate] {page.title}: LLM declined, defaulting to processed")

        except Exception as e:
            result.processing_depth = "processed"
            logger.error(f"  [skip-gate] Error for {page.title}: {e}, defaulting to processed")

    # =========================================================================
    # Stage 1b: Learning classification gate (Plan 07)
    # =========================================================================
    logger.info("Stage 1b: Learning classification gate")
    LEARNING_GATE_DOMAINS = {"en.wikipedia.org", "arxiv.org"}

    for i, result in enumerate(results):
        if result.processing_depth == "skipped":
            result.is_learning = False
            continue
        if result.status != "success":
            continue

        page = capture.pages[i]
        domain = urlparse(page.url).hostname or "unknown"

        # Domain shortcut — no LLM needed
        if domain in LEARNING_GATE_DOMAINS:
            result.is_learning = True
            logger.info(f"  [learning-gate] {page.title}: LEARNING (domain shortcut)")
            continue

        # LLM classification
        content_dict = fetched_content.get(page.url, {})
        snippet = (
            content_dict.get("summary")
            or content_dict.get("abstract")
            or content_dict.get("description")
            or content_dict.get("text", "")[:500]
            or ""
        )[:500]

        try:
            from backend.prompts.templates import get_prompt as get_prompt_tpl

            learning_prompt = get_prompt_tpl(
                LEARNING_GATE_PROMPT,
                title=page.title or "Unknown",
                domain=domain,
                snippet=snippet or "(no content preview available)",
            )
            lg_response = await llm.complete(
                prompt=learning_prompt,
                model=LEARNING_GATE_MODEL,
                temperature=0.0,
                max_tokens=5,
            )
            total_cost += lg_response.cost_usd
            _record_learning_gate_cost(lg_response, page_url=page.url)
            answer = lg_response.content.strip().upper()
            result.is_learning = answer != "SKIP"
            logger.info(
                f"  [learning-gate] {page.title}: "
                f"{'LEARNING' if result.is_learning else 'SKIP'}"
            )
        except Exception as e:
            # Default to LEARNING on error (err toward inclusion)
            result.is_learning = True
            logger.error(
                f"  [learning-gate] Error for {page.title}: {e}, " f"defaulting to LEARNING"
            )

    # Stages 2-4c removed — temporal artifacts not used in topic-based model.
    # Pipeline is now: Stage 0 → Stage 1 (skip gate) → Stage 1b (learning gate) → title gen.
    clusters: list[TopicCluster] = []

    # --- 4d: Capture title + mini-summary (derived, no LLM) ---
    from backend.services.title_service import generate_session_title_and_summary

    page_titles_for_title = [p.title for p in capture.pages if p.title]
    active_pages = sum(1 for r in results if r.status not in ("skipped", "catchall"))
    capture_title, mini_summary = generate_session_title_and_summary(
        clusters,
        page_titles_for_title,
        capture.capture_id,
        active_page_count=active_pages,
    )

    # =========================================================================
    # Build response
    # =========================================================================
    total_ms = (time.perf_counter() - capture_start) * 1000
    succeeded = sum(1 for r in results if r.status == "success")
    failed = sum(1 for r in results if r.status == "error")
    catchall = sum(1 for r in results if r.status == "catchall")
    skipped = sum(1 for r in results if r.status == "skipped")

    logger.info(
        f"Capture {capture.capture_id} done: "
        f"{succeeded} success, {skipped} skipped, {failed} error, {catchall} catchall "
        f"({total_ms:.0f}ms, ${total_cost:.5f})"
    )

    response = CaptureProcessingResponse(
        capture_id=capture.capture_id,
        page_count=len(capture.pages),
        pages_succeeded=succeeded,
        pages_failed=failed,
        pages_catchall=catchall,
        pages_skipped=skipped,
        results=results,
        clusters=clusters,
        capture_title=capture_title,
        mini_summary=mini_summary,
        fetched_contents=fetched_content,
        raw_html_artifacts=raw_html_artifacts,
        schema_version=4,
        total_processing_time_ms=total_ms,
        total_llm_cost_usd=total_cost,
        model_used=TOOL_SELECTION_MODEL,
        journey_url=f"{settings.frontend_url}?capture_id={capture.capture_id}",
    )

    # Write processed capture dump
    try:
        processed_dir = CAPTURES_DIR / "processed"
        processed_dir.mkdir(parents=True, exist_ok=True)

        dump = response.model_dump(by_alias=True)
        dump["timestamp"] = datetime.now().astimezone().isoformat()

        # Match the raw dump filename if available, otherwise generate one
        if raw_path:
            dump_path = processed_dir / raw_path.name
        else:
            local_ended = capture.ended_at.astimezone()
            ts = local_ended.strftime("%Y-%m-%d_%H%M%S")
            suffix = capture.capture_id.rsplit("_", 1)[-1]
            dump_path = processed_dir / f"{ts}_{suffix}.json"

        dump_path.write_text(json.dumps(dump, indent=2, default=str))
        logger.info(f"Processed dump written to {dump_path}")
    except Exception as e:
        logger.warning(f"Failed to write processed dump: {e}")

    global _captures_processed
    _captures_processed += 1

    return response


# =============================================================================
# Cross-session clustering endpoint
# =============================================================================
from backend.services.clustering_service import ClusteringService

# graph_builder.build_graph_from_db + graph_service.save_graph are no longer
# called from this endpoint -- ClusteringService.recluster_all now bakes
# the graph_cache rebuild into its tail (so all callers get consistent
# behavior). Imports retained elsewhere via lazy resolution where needed.


@app.post("/api/recluster", tags=["Clustering"])
async def recluster(user_id: int = Depends(verify_api_key)):
    """Run cross-session HDBSCAN clustering and rebuild the knowledge graph.

    The graph_cache rebuild now happens inside ``ClusteringService.recluster_all``
    as its final step, so all callers (this endpoint, trigger_recluster.py CLI,
    nightly_maintenance scheduler) get consistent fresh graph_cache state.

    Demo gate: no demo identity may recluster, neither a direct demo login nor
    an admin viewing as demo, so a click made while viewing as demo never
    rewrites the graph demo visitors get (2026-10-04). Stricter than
    ``verify_not_plain_demo``, which the topic-curation endpoints keep.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) == "demo":
        raise HTTPException(status_code=403, detail="Demo account cannot recluster")
    svc = ClusteringService(user_id=user_id)
    return await svc.recluster_all()


# =============================================================================
# Agent query endpoint (Milestone 10)
# =============================================================================
from backend.services.agent import HistoryTurn


class AgentQueryRequest(BaseModel):
    """Request body for the agent query endpoint."""

    query: str = Field(..., min_length=1, max_length=2000)
    # P4: prior chat turns for follow-up context ("tell me more about
    # that"). None/omitted for a fresh conversation. Invalid role values
    # fail validation here (422); caps (turn count / per-turn length /
    # total length) and injection sanitization are enforced downstream in
    # CompendiumAgent so both agent endpoints share one enforcement point.
    history: list[HistoryTurn] | None = None


@app.post("/api/agent/query", tags=["Agent"])
# Stacked limits: 10/min keeps a single user from burst-rate-hammering;
# 100/hr caps total cost-bursting if auth ever leaks. Each query runs
# multiple LLM completions through the ReAct loop -- 100 queries =
# 100s-of-requests of OpenAI cost. Adjust if a real user actually needs
# > 100 queries/hour (unlikely for one human; agent/automation use would
# require a separate scoped API-key path).
@limiter.limit("10/minute;100/hour")
async def agent_query(
    request: Request, body: AgentQueryRequest, user_id: int = Depends(verify_api_key)
):
    """Query the knowledge compendium using the ReAct search agent."""
    from backend.services.agent import CompendiumAgent
    from backend.utils.sanitize import PromptInjectionError

    try:
        agent = CompendiumAgent(user_id=user_id)
        response = await agent.query(body.query, history=body.history)
        return response.model_dump()
    except PromptInjectionError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/agent/query-stream", tags=["Agent"])
# Same stacked limits as /api/agent/query -- the streaming variant is
# the same cost shape (same ReAct loop, same LLM calls), just with SSE
# transport. Counters are per-IP and shared between the two endpoints
# in slowapi's default config.
@limiter.limit("10/minute;100/hour")
async def agent_query_stream(
    request: Request,
    body: AgentQueryRequest,
    user_id: int = Depends(verify_api_key),
):
    """Stream the agent response as Server-Sent Events.

    No route-level try/except for PromptInjectionError here (P5) -- that
    used to be dead code: CompendiumAgent.query_stream is an async
    generator, so its body (including the sanitize call) only runs once
    StreamingResponse starts iterating it during body-send, which is
    AFTER this handler already returned 200 + SSE headers. An exception
    raised there can never be caught by a try/except wrapped around the
    handler's `return StreamingResponse(...)` line. query_stream now
    catches PromptInjectionError and any other exception itself and
    yields a `{"type": "error", ...}` SSE frame instead. The try/except
    below is the belt-and-suspenders layer for what query_stream's own
    handling can't cover: constructing CompendiumAgent, and json.dumps
    on an event payload -- both happen in this generator, not inside
    query_stream.
    """
    import json as _json
    from fastapi.responses import StreamingResponse

    async def event_generator():
        try:
            from backend.services.agent import CompendiumAgent

            agent = CompendiumAgent(user_id=user_id)
            async for event in agent.query_stream(body.query, history=body.history):
                yield f"data: {_json.dumps(event)}\n\n"
        except Exception as e:
            logger.exception("agent_query_stream: event_generator failed")
            fallback = {
                "type": "error",
                "error_class": "internal",
                "message": (
                    f"An internal error occurred while streaming your query "
                    f"({type(e).__name__})."
                ),
            }
            yield f"data: {_json.dumps(fallback)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/agent/internals", tags=["Agent"])
async def agent_internals(
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
):
    """Admins only: the agent system prompt + tool definitions, for the
    "Agent Internals" debug panel (REST port of the Dash gear-button panel --
    frontend/dash/layouts/graph_canvas.py imports the same
    ``AGENT_TOOLS``/``SYSTEM_PROMPT`` and renders them server-side; here the
    Next.js app fetches them instead).

    A real admin role (``ar.get_role``, re-checked from the DB, never trusted
    from the client), NOT viewing as demo: the system prompt can carry a
    deployment-local prompt override, and an admin viewing as demo gets
    exactly what a plain demo gets (2026-10-04, the Prompts view's rule;
    Dash treated view-as as admin context here). A plain demo or regular-user
    login gets 403 too.
    """
    from backend.db import auth_repo as ar

    if claims.get("acting_as_demo"):
        raise HTTPException(status_code=403, detail="Disabled in demo view")
    if ar.get_role(user_id) != "admin":
        raise HTTPException(status_code=403, detail="Admin context required")

    from backend.services.agent import AGENT_TOOLS, SYSTEM_PROMPT

    return {"system_prompt": SYSTEM_PROMPT, "tools": AGENT_TOOLS}


# =============================================================================
# Passive capture endpoints (merged from sidecar)
# =============================================================================
from backend.models.capture import PassiveCaptureInput


def _detect_passive_source(capture_id: str) -> str:
    """Detect source from captureId format.

    Mobile: "{epoch}_{9char}_mobile" → mobile_passive
    Desktop: "{epoch}_{9char}" → desktop_passive
    """
    parts = capture_id.rsplit("_", 2)
    if len(parts) >= 3 and parts[-1] == "mobile":
        return "mobile_passive"
    return "desktop_passive"


@app.post("/api/passive-captures", tags=["Captures"])
@limiter.limit("20/minute")
async def receive_passive_capture(
    request: Request,
    capture: PassiveCaptureInput,
    background_tasks: BackgroundTasks,
    user_id: int = Depends(verify_not_demo_identity),
):
    """Receive a passive capture from the extension or mobile app.

    Parses the raw page dicts into PageVisit objects, saves to PostgreSQL,
    and queues background LLM processing.
    """
    source = _detect_passive_source(capture.capture_id)
    logger.info(
        f"Received passive capture: {capture.capture_id} "
        f"({len(capture.pages)} pages, source={source})"
    )

    # Check duplicate
    existing = capture_repo.get_capture(capture.capture_id)
    if existing:
        raise HTTPException(status_code=409, detail="Capture already exists")

    # Parse timestamps
    from dateutil.parser import isoparse

    started = isoparse(capture.started_at)
    ended = isoparse(capture.ended_at)

    # Build PageVisit-compatible dicts from raw page data
    page_dicts = []
    for p in capture.pages:
        domain = urlparse(p.get("url", "")).hostname or None
        page_dicts.append(
            {
                "url": p.get("url", ""),
                "title": p.get("title"),
                "domain": domain,
                "dwell_time_seconds": p.get("dwellTimeSeconds"),
                "visited_at": isoparse(p["timestamp"]) if p.get("timestamp") else started,
                "transition_type": p.get("transitionType"),
                "transition_qualifiers": p.get("transitionQualifiers"),
                "is_tracked_domain": p.get("isTrackedDomain", False),
                "extracted_text": p.get("extractedText"),
            }
        )

    # Compute is_trivial server-side (same logic as active endpoint)
    tracked_count = sum(1 for p in page_dicts if p.get("is_tracked_domain"))
    is_trivial = tracked_count < 3

    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture.capture_id,
        source=source,
        started_at=started,
        ended_at=ended,
        is_trivial=is_trivial,
        events=capture.events,
        device_label=capture.device_label,
        client_meta=capture.client_meta,
    )
    page_repo.insert_pages(cap["id"], page_dicts)

    logger.info(f"Saved passive capture {capture.capture_id}: {len(page_dicts)} pages")

    # Queue background LLM processing if non-trivial
    if not is_trivial:
        capture_input = CaptureInput(
            capture_id=capture.capture_id,
            pages=[
                PageVisit(
                    url=p["url"],
                    timestamp=p.get("visited_at") or started,
                    dwell_time_seconds=p.get("dwell_time_seconds"),
                    title=p.get("title"),
                    is_tracked_domain=p.get("is_tracked_domain", False),
                    transition_type=p.get("transition_type"),
                    transition_qualifiers=p.get("transition_qualifiers"),
                    extracted_text=p.get("extracted_text"),
                )
                for p in page_dicts
            ],
            events=[],
            started_at=started,
            ended_at=ended,
        )
        background_tasks.add_task(
            _process_capture_background, cap["id"], capture_input, user_id
        )

    return {
        "status": "saved",
        "captureId": capture.capture_id,
        "pageCount": len(page_dicts),
    }


@app.get("/api/passive-captures/status", tags=["Captures"])
async def passive_capture_status(user_id: int = Depends(verify_api_key)):
    """Return count of passive captures."""
    caps = capture_repo.list_captures(user_id)
    passive = [c for c in caps if c["source"] in ("desktop_passive", "mobile_passive")]
    return {"captureCount": len(passive)}


# =============================================================================
# Graph endpoints
# =============================================================================
GRAPH_WINDOWS = ("all", "7", "30", "90", "365")


@app.get("/api/graph", tags=["Graph"])
async def get_graph(
    window: str = Query("all", description="Time window: all|7|30|90|365 (days back)"),
    user_id: int = Depends(verify_api_key),
):
    """Return the knowledge graph as JSON, optionally time-window filtered.

    Rebuilt fresh from Postgres on EVERY call rather than served from
    ``graph_cache``. That is Dash cost-parity, not a new expense: the Dash
    app already rebuilds per page load (``refresh_graph_on_load``,
    ``frontend/dash/callbacks/graph.py:16-35``) and per mutation. Serving the
    cache here is what let a stale graph survive non-hybrid topic mutations,
    whose add/rename/remove endpoints repaint clusters without rebuilding the
    cache (02 results.md deferred ruling M4).

    Cache semantics differ by window, mirroring the two Dash callbacks:

      - ``all`` -> build, then ``save_graph`` so ``graph_cache`` stays warm for
        the readers that still use it (``load_graph`` consumers such as
        ``/api/graph/nodes/{node_id}``).
      - ``7|30|90|365`` -> build with ``visited_after = now - N days`` and do
        NOT save (``filter_graph_by_time_window``, callbacks/graph.py:78-108).
        A filtered view must never become the cached full graph.
    """
    from datetime import timedelta, timezone

    from backend.services.graph_builder import build_graph_from_db
    from backend.services.graph_service import save_graph
    from backend.utils.graph_export import to_d3_elements

    if window not in GRAPH_WINDOWS:
        raise HTTPException(
            status_code=422, detail=f"window must be {'|'.join(GRAPH_WINDOWS)}"
        )

    if window == "all":
        graph = build_graph_from_db(user_id)
        save_graph(graph, user_id)
    else:
        visited_after = datetime.now(timezone.utc) - timedelta(days=int(window))
        graph = build_graph_from_db(user_id, visited_after=visited_after)

    return to_d3_elements(graph, user_id)


@app.get("/api/graph/nodes/{node_id}", tags=["Graph"])
async def get_graph_node(node_id: str, user_id: int = Depends(verify_api_key)):
    """Return a node and its subtree."""
    graph = load_graph(user_id)
    node = graph.get_node(node_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    subtree = graph.get_subtree(node_id)
    return {
        "node": node.model_dump(),
        "subtree": [n.model_dump() for n in subtree],
    }


@app.get("/api/diary/windows", tags=["Graph"])
async def get_diary_windows(
    granularity: str = "day",
    filter_node_id: str | None = None,
    user_id: int = Depends(verify_api_key),
):
    """Time-window groupings for the session diary (left panel)."""
    if granularity not in ("day", "week", "month"):
        raise HTTPException(status_code=422, detail="granularity must be day|week|month")
    from backend.db import page_repo

    return page_repo.get_time_windows(user_id, granularity, filter_node_id=filter_node_id)


@app.get("/api/clustering/status", tags=["Graph"])
async def get_clustering_status(user_id: int = Depends(verify_api_key)):
    """Clustering-card data for the graph header (Dash parity).

    Combines the data reads behind three Dash callbacks, all keyed off the
    same "latest completed recluster_runs row" concept -- but scoped to
    the authed ``user_id`` throughout, unlike the callbacks themselves
    (which use ``get_default_user_id()``'s single-user assumption):

      - title/run_number: ``frontend/dash/callbacks/graph.py:49-76``
        (``update_clustering_card_title``).
      - stats_line1/stats_line2: ``frontend/dash/callbacks/graph.py:208-291``
        (``update_hbar_cluster_stats``). Noise is computed live via the
        singleton-cluster (size=1) subquery -- see
        ``cluster_repo.get_noise_stats`` -- not the
        ``recluster_runs.noise_count`` column captured at completion time.
      - freshness_label/freshness_color:
        ``frontend/dash/callbacks/recluster.py:98-144``
        (``update_cache_badge``).

    Presentation-ready strings ARE the contract -- the Next.js client
    renders stats_line1/stats_line2/freshness_label verbatim, so their
    exact formats (unit letters, punctuation, the "· suggested" conditional)
    must match Dash's. ``naming_cost`` is intentionally dropped from the
    response -- dev telemetry only (design audit §4.7), never user-facing.

    When no completed run exists, this byte-mirrors
    ``update_hbar_cluster_stats``'s no-row branch
    (``frontend/dash/callbacks/graph.py:245-246``): stats_line1 is the
    literal string ``"no recluster yet"``, stats_line2 is ``""``.
    """
    from datetime import timezone

    from backend.db import auth_repo, cluster_repo, graph_repo, recluster_repo

    run = recluster_repo.get_latest_run(user_id)

    if run is None:
        run_number = None
        title = "CLUSTERING (NO RUNS YET)"
        stats_line1 = "no recluster yet"
        stats_line2 = ""
    else:
        run_number = run["id"]
        title = f"CLUSTERING (RUN #{run_number})"

        noise, total = cluster_repo.get_noise_stats(user_id, run_number)
        suggested_count = cluster_repo.get_suggested_group_count(user_id, run_number)
        topic_count = len(auth_repo.get_preferences(user_id).get("topic_interests", []))

        stats_line1 = f"{run['cluster_count']} clusters · {topic_count} topics"
        if suggested_count:
            stats_line1 += f" · {suggested_count} suggested"
        pct = round(noise * 100 / total) if total else 0
        stats_line2 = f"{pct}% noise"

    updated_at = graph_repo.get_cache_updated_at(user_id)
    if updated_at is None:
        # No hex color tier applies when there is no cache at all -- the
        # Dash badge uses a CSS var + opacity here, not one of the four
        # freshness-tier hex colors, so we return "" rather than inventing
        # a fifth color the client would need to special-case anyway.
        freshness_label = "No cache"
        freshness_color = ""
    else:
        now = datetime.now(timezone.utc)
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=timezone.utc)
        delta = now - updated_at
        minutes = int(delta.total_seconds() / 60)
        days = minutes / 1440

        if minutes < 60:
            label = f"{minutes}m ago"
        elif days < 1:
            label = f"{minutes // 60}h ago"
        else:
            label = f"{int(days)}d ago"

        if days < 1:
            freshness_color = "#4ade80"  # green
        elif days < 3:
            freshness_color = "#facc15"  # yellow
        elif days < 5:
            freshness_color = "#f97316"  # orange
        else:
            freshness_color = "#ef4444"  # red

        freshness_label = f"● {label}"

    return {
        "run_number": run_number,
        "title": title,
        "stats_line1": stats_line1,
        "stats_line2": stats_line2,
        "freshness_label": freshness_label,
        "freshness_color": freshness_color,
    }


# =============================================================================
# Recategorization endpoints (human overrides of LLM decisions)
# =============================================================================

from backend.models.recategorization import (
    BatchOverrideRequest,
    CaptureOverrideRequest,
    PageFlagRequest,
    PageOverrideRequest,
)
from backend.models.validation import ValidateArchiveRequest


@app.patch("/api/pages/{page_id}/override", tags=["Recategorization"])
async def override_page(
    page_id: int,
    body: PageOverrideRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Set or clear human overrides on a page's status and/or processing depth."""
    result = {}

    if body.human_status is not None or "human_status" in (body.model_fields_set or set()):
        r = page_repo.override_page_status(
            page_id,
            body.human_status,
            user_id,
            note=body.note,
        )
        result.update(r)

    if body.human_processing_depth is not None or "human_processing_depth" in (
        body.model_fields_set or set()
    ):
        r = page_repo.override_page_depth(
            page_id,
            body.human_processing_depth,
            user_id,
            note=body.note,
        )
        result.update(r)

    if not result:
        raise HTTPException(status_code=400, detail="No override fields provided")

    return result


@app.patch("/api/pages/{page_id}/flag", tags=["Recategorization"])
async def flag_page(
    page_id: int,
    body: PageFlagRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Toggle the review queue flag on a page."""
    page_repo.flag_page_for_review(page_id, body.flagged)
    return {"page_id": page_id, "flagged_for_review": body.flagged}


@app.patch("/api/captures/{capture_db_id}/override", tags=["Recategorization"])
async def override_capture(
    capture_db_id: int,
    body: CaptureOverrideRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Set or clear the human override on a capture's trivial flag."""
    result = capture_repo.override_capture_trivial(
        capture_db_id,
        body.human_is_trivial,
        user_id,
        note=body.note,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Capture not found")
    return result


@app.post("/api/pages/batch-override", tags=["Recategorization"])
async def batch_override_pages(
    body: BatchOverrideRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Override status for all pages matching a domain."""
    count = page_repo.batch_override_by_domain(
        user_id,
        body.domain,
        body.human_status,
        note=body.note,
    )
    return {"affected_count": count, "domain": body.domain}


@app.get("/api/pages/review-queue", tags=["Recategorization"])
async def review_queue(user_id: int = Depends(verify_api_key)):
    """Return all pages flagged for human review."""
    return page_repo.get_flagged_pages(user_id)


@app.get("/api/pages/{page_id}/annotations", tags=["Recategorization"])
async def page_annotations(page_id: int, user_id: int = Depends(verify_api_key)):
    """Return the full audit trail for a page."""
    return annotation_repo.get_annotations_for_entity("page", page_id)


@app.get("/api/analytics/disagreements", tags=["Recategorization"])
async def disagreement_analytics(user_id: int = Depends(verify_api_key)):
    """Aggregate where human overrides disagree with LLM decisions."""
    return annotation_repo.get_disagreement_summary(user_id)


@app.get("/api/analytics/archive-health", tags=["Recategorization"])
async def archive_health(
    range: str | None = None,
    user_id: int = Depends(verify_api_key),
):
    """Archive pipeline health snapshot for the Archive dev view.

    Optional ``range`` query param: ``7d`` / ``30d`` / ``90d`` / ``all``.
    Omitted or unrecognized → all time.
    """
    from backend.db import trends_repo

    since = trends_repo.since_from_range(range or "all")
    return page_repo.get_archive_health_summary(user_id, since=since)


@app.get("/api/pages/overrides", tags=["Recategorization"])
async def list_overrides(user_id: int = Depends(verify_api_key)):
    """Return all pages with human overrides."""
    return page_repo.get_pages_with_overrides(user_id)


# ── Archive-validation endpoints ─────────────────────────────────────────────


@app.get("/api/pages/validation-batch", tags=["Recategorization"])
async def validation_batch(user_id: int = Depends(verify_api_key)):
    """Return a stratified batch of archived pages for human review."""
    return page_repo.generate_validation_batch(user_id)


@app.post("/api/pages/{page_id}/validate-archive", tags=["Recategorization"])
async def validate_archive(
    page_id: int,
    body: ValidateArchiveRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Label a page's archive decision (correct | incorrect | skip).

    Writes a ``validate_archive`` annotation. Does NOT auto-flip the page
    status on 'incorrect' — the Archive Review UI stages labels and lets
    the user commit a batch of status flips via the existing
    batch-override flow.
    """
    annotation_repo.create_annotation(
        user_id,
        "page",
        page_id,
        "validate_archive",
        new_value=body.label,
        note=body.note,
    )
    return {
        "page_id": page_id,
        "label": body.label,
        "auto_flipped": False,
    }


@app.get("/api/pages/{page_id}/dedup-pair", tags=["Recategorization"])
async def dedup_pair(page_id: int, user_id: int = Depends(verify_api_key)):
    """Return the canonical/archived pair for a dedup-archived page."""
    pair = page_repo.get_dedup_pair(page_id)
    if pair is None:
        raise HTTPException(status_code=404, detail="No dedup pair found")
    return pair


@app.get("/api/pages/{pid}/preview", tags=["Captures"])
async def get_archived_preview(pid: int, user_id: int = Depends(verify_api_key)):
    """Sanitized archived HTML for the topic-detail iframe (Dash /__preview parity).

    ``pid`` is a ``page_content`` row id, NOT a ``pages`` id --
    ``render_archived_preview`` reads ``page_content.raw_html`` directly
    (see ``_load_page_content_row`` in preview_renderer.py). The Dash
    consumer passes ``page_content.id``; the Next.js client is expected to
    source ``pid`` from the page-content endpoint the same way.

    ``render_archived_preview`` itself is NOT user-scoped -- it will render
    any page_content row's archived HTML given a bare id. Ownership is
    verified here (one query) before rendering; a caller viewing another
    user's pid gets 404 -- not 403 -- so a probing pid doesn't leak whether
    the row exists at all.

    Cache-Control/Pragma no-store headers are set on every outcome (200 and
    error alike), mirroring the Flask ``/__preview`` route at
    frontend/dash/app.py:1437.

    Also sets the ``_PREVIEW_FRAME_MARKER`` header on every outcome, which
    ``security_middleware`` (main.py) recognizes and swaps for
    ``X-Frame-Options: SAMEORIGIN`` plus a ``Content-Security-Policy:
    frame-ancestors 'self'`` -- this is the one route meant to be embedded
    in the Next.js topic-detail iframe (same-origin, via the Next proxy);
    every other route keeps the middleware's default ``DENY``.
    """
    from fastapi.responses import HTMLResponse

    from backend.services.preview_renderer import render_archived_preview

    no_store_headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        _PREVIEW_FRAME_MARKER: "1",
    }

    if not page_repo.page_content_owned_by_user(pid, user_id):
        return HTMLResponse(
            content="Preview row not found.",
            status_code=404,
            headers=no_store_headers,
        )

    body, status = render_archived_preview(pid, user_id)
    return HTMLResponse(content=body, status_code=status, headers=no_store_headers)


async def captured_asset_auth(
    request: Request,
    sig: str | None = Query(None),
    x_api_key: str | None = Header(None),
    authorization: str | None = Header(None),
) -> int | None:
    """Auth for ``GET /captured-assets``: signed URL or the normal credentials.

    A request carrying ``sig`` is authenticated by that signature alone, and
    the handler verifies it (after its path-safety checks), so this returns
    None. Without ``sig`` it is exactly ``verify_api_key``.
    """
    if sig is not None:
        return None
    return await verify_api_key(request, x_api_key, authorization)


@app.get("/captured-assets/{rel:path}", tags=["Captures"])
async def get_captured_asset(
    rel: str,
    user_id: int | None = Depends(captured_asset_auth),
    u: str | None = Query(None),
    exp: str | None = Query(None),
    sig: str | None = Query(None),
):
    """Owner-gated file server for archived page-preview subresources.

    Dash is today's only server of these files, reading straight off disk;
    Dash retires at batch 08b, so this route is what replaces it. ``rel``
    is ``captured_assets.file_path``, resolved against the assets base dir
    the server compose mounts (``asset_archiver._BASE_ASSETS_DIR`` --
    legacy rows look like ``<aa>/<sha>.<ext>``, post-migration-031 rows
    ``user_<id>/<aa>/<sha>.<ext>``); archived preview HTML references
    them as signed ``/captured-assets/<file_path>?u=&exp=&sig=`` URLs (see
    ``preview_renderer._load_asset_map`` and ``services.asset_urls``).

    Ownership is checked with one query before any file access: no
    matching row, a NULL owner (an orphaned legacy row), or an owner that
    isn't the caller all return the same 404 -- never 403 -- so a probing
    path never learns whether the row exists at all (same rule as
    ``GET /api/pages/{pid}/preview`` above).

    Two ways to authenticate. Without ``sig``: like every other API route,
    a bearer token the Next.js route handler injects (or an API key); this
    never reads a cookie, and no credential is a 401. With ``sig``: the
    signed URL minted for the viewer by the preview renderer is the only
    credential (the sandboxed preview iframe has an opaque origin, so the
    browser withholds the session cookie and no bearer can be injected). A
    signed request that fails verification (wrong path, tampered user or
    expiry, expired, malformed) gets the same 404 as any unreadable asset,
    never 401/403; a valid one proceeds as the signed user, so the
    ownership check below still applies.
    """
    from fastapi.responses import FileResponse

    from backend.services import asset_archiver

    not_found = HTTPException(status_code=404, detail="Asset not found.")

    # Path safety first, before any DB query -- empty, NUL-containing, or
    # absolute paths are never valid file_path values.
    if not rel or "\x00" in rel or Path(rel).is_absolute():
        raise not_found

    # Read the base dir at request time (not at import time) so tests can
    # monkeypatch asset_archiver._BASE_ASSETS_DIR.
    base_dir = asset_archiver._BASE_ASSETS_DIR
    candidate = (base_dir / rel).resolve()
    try:
        candidate.relative_to(base_dir.resolve())
    except ValueError:
        # Not strictly inside the base dir -- catches "../" traversal
        # (literal or already-decoded from a percent-encoded form).
        raise not_found

    if sig is not None:
        from backend.services.asset_urls import verify_asset_signature

        user_id = verify_asset_signature(rel, u, exp, sig)
        if user_id is None:
            raise not_found
        set_current_user_id(user_id)

    row = page_repo.captured_asset_for_path(rel)
    if row is None:
        raise not_found
    owner_id, content_type = row
    if owner_id is None or owner_id != user_id:
        raise not_found

    if not candidate.is_file():
        raise not_found

    # Archived files come from arbitrary sites (an SVG can carry script)
    # and a signed URL works in any browser, so an asset opened directly at
    # this origin must not execute or fetch anything. The CSP only applies
    # when the file is loaded as a document; as an <img>/<link> subresource
    # of a preview it is ignored.
    return FileResponse(
        candidate,
        media_type=content_type or "application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/pages/content", tags=["Captures"])
async def get_page_content(url: str, user_id: int = Depends(verify_api_key)):
    """Page text content for the topic-detail panel (Dash parity).

    Mirrors the page_content lookup inside
    ``frontend/dash/layouts/topic_detail.py::_fetch_and_render_page_content``
    (line ~233): normalize the incoming ``url`` via
    ``backend.utils.url_normalize.normalize_url`` exactly as that Dash
    consumer does, then look up ``page_content`` by normalized_url. Unlike
    the Dash helper (which tries a *list* of candidate page_urls in order
    until one matches), this endpoint takes exactly one ``url`` -- the
    Next.js client already knows which URL it wants content for.

    ``pid`` in the response is the ``page_content`` row id -- the same
    value ``GET /api/pages/{pid}/preview`` expects.

    Ownership: the underlying query is NOT user-scoped (same situation as
    the preview endpoint), so we gate on
    ``page_repo.page_content_owned_by_user`` -- a ``pages`` row linking to
    this page_content id must belong to a capture owned by the caller.
    404 on both "no matching row" and "not owned", never 403, so a
    probing url doesn't leak whether the row exists for another user.
    """
    from backend.db import content_repo
    from backend.utils.url_normalize import normalize_url

    normalized = normalize_url(url)
    row = content_repo.get_content_by_normalized_url(normalized)
    if row is None or not page_repo.page_content_owned_by_user(row["id"], user_id):
        raise HTTPException(status_code=404, detail="No content found for url")

    return {
        "pid": row["id"],
        "url": row["url"],
        "domain": row["domain"],
        "extracted_text": row["extracted_text"],
        "content_summary": row["content_summary"],
        "tool_selected": row["tool_selected"],
        "has_usable_html": row["has_usable_html"],
    }


@app.get("/api/export/training-data", tags=["Recategorization"])
async def export_training_data(user_id: int = Depends(verify_api_key)):
    """Export (original_decision, human_correction) pairs as JSON for fine-tuning.

    Returns pages where a human override exists, with both the LLM's
    original decision and the human correction, plus context (url, title,
    content snippet, skip reasoning).
    """
    from backend.db.connection import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.url, p.title, p.domain,
                       p.status AS llm_status,
                       p.processing_depth AS llm_depth,
                       p.skip_reasoning,
                       p.human_status,
                       p.human_processing_depth,
                       LEFT(pc.content_summary, 500) AS content_snippet,
                       pc.tool_selected
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                LEFT JOIN page_content pc ON p.page_content_id = pc.id
                WHERE c.user_id = %s
                  AND (p.human_status IS NOT NULL
                       OR p.human_processing_depth IS NOT NULL)
                ORDER BY p.visited_at ASC
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    return {"count": len(rows), "records": rows}


# =============================================================================
# Tagging endpoints
# =============================================================================

from backend.models.recategorization import (
    EntityTagRequest,
    TagCreateRequest,
    TagUpdateRequest,
)


@app.post("/api/tags", tags=["Tags"])
async def create_tag(body: TagCreateRequest, user_id: int = Depends(verify_not_plain_demo)):
    """Create a new tag."""
    return tag_repo.create_tag(
        user_id,
        body.name,
        color=body.color,
        group_name=body.group_name,
        description=body.description,
    )


@app.get("/api/tags", tags=["Tags"])
async def list_tags(
    group: str | None = None,
    user_id: int = Depends(verify_api_key),
):
    """List all tags, optionally filtered by group."""
    return tag_repo.get_tags(user_id, group_name=group)


@app.patch("/api/tags/{tag_id}", tags=["Tags"])
async def update_tag(
    tag_id: int,
    body: TagUpdateRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Update a tag's name, color, group, or description."""
    tag = tag_repo.get_tag_by_id(tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    updates = body.model_dump(exclude_unset=True)
    if updates:
        tag_repo.update_tag(tag_id, **updates)
    return tag_repo.get_tag_by_id(tag_id)


@app.delete("/api/tags/{tag_id}", tags=["Tags"])
async def delete_tag(tag_id: int, user_id: int = Depends(verify_not_plain_demo)):
    """Delete a tag (cascades to all entity associations)."""
    tag_repo.delete_tag(tag_id)
    return {"deleted": True}


@app.post("/api/tags/{tag_id}/entities", tags=["Tags"])
async def tag_entity(
    tag_id: int,
    body: EntityTagRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Associate a tag with a page or capture."""
    tag_repo.add_entity_tag(tag_id, body.entity_type, body.entity_id, user_id)
    return {"tagged": True}


@app.delete("/api/tags/{tag_id}/entities", tags=["Tags"])
async def untag_entity(
    tag_id: int,
    body: EntityTagRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Remove a tag association from a page or capture."""
    tag_repo.remove_entity_tag(tag_id, body.entity_type, body.entity_id)
    return {"untagged": True}


@app.get("/api/pages/{page_id}/tags", tags=["Tags"])
async def page_tags(page_id: int, user_id: int = Depends(verify_api_key)):
    """Return all tags on a specific page."""
    return tag_repo.get_tags_for_entity("page", page_id)


@app.get("/api/captures/{capture_db_id}/tags", tags=["Tags"])
async def capture_tags(capture_db_id: int, user_id: int = Depends(verify_api_key)):
    """Return all tags on a specific capture."""
    return tag_repo.get_tags_for_entity("capture", capture_db_id)


@app.get("/api/tags/{tag_id}/entities", tags=["Tags"])
async def tag_entities(
    tag_id: int,
    entity_type: str | None = None,
    user_id: int = Depends(verify_api_key),
):
    """Return all entities (pages/captures) with a specific tag."""
    return tag_repo.get_entities_for_tag(tag_id, entity_type=entity_type)


@app.get("/api/tags/groups", tags=["Tags"])
async def tag_groups(user_id: int = Depends(verify_api_key)):
    """Return all distinct tag group names."""
    return tag_repo.get_tag_groups(user_id)


# =============================================================================
# Authentication endpoints (JWT + API key coexistence)
# =============================================================================


class RegisterRequest(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8, max_length=128)
    name: str | None = Field(None, max_length=200)


class LoginRequest(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=1, max_length=128)
    trust_tailnet_login: str | None = Field(None, max_length=320)


class PreferencesRequest(BaseModel):
    preferences: dict


class TopicAddRequest(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=100)


class TopicRenameRequest(BaseModel):
    # keyword is the NEW name. 36 = Dash's rename input maxLength
    # (frontend/dash/callbacks/topics.py:1509, sc-rename-input).
    keyword: str = Field(..., min_length=1, max_length=36)


class TopicIconOverride(BaseModel):
    icon_id: str = Field(..., min_length=1, max_length=50)


class SuggestionAcceptRequest(BaseModel):
    keyword: str | None = Field(None, max_length=100)
    """Optional rename-on-accept; defaults to the group's suggested label."""


class MemberExclusionRequest(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=100)
    cluster_name: str = Field(..., min_length=1, max_length=200)


@app.post("/api/auth/register", tags=["Auth"])
@limiter.limit("3/minute")
async def register(request: Request, body: RegisterRequest):
    """Create a new user with password-based auth.

    Disabled in production (``DISABLE_REGISTRATION=1``) so the public deploy URL
    can't be hijacked by a first-mover. Provision users via the bootstrap script
    instead: ``python -m backend.scripts.bootstrap_user``.
    """
    import os

    if os.environ.get("DISABLE_REGISTRATION", "").lower() in {"1", "true", "yes"}:
        raise HTTPException(
            status_code=403,
            detail="Registration is disabled. Contact the administrator.",
        )

    from backend.db import auth_repo as ar
    from backend.services.auth_service import hash_password

    existing = ar.get_user_by_email(body.email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = user_repo.create_user(body.email, name=body.name)
    ar.set_password(
        user["id"],
        hash_password(body.password),
        audit_ctx=_audit_ctx.from_request(request),
        via="register",
    )

    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
    }


@app.post("/api/auth/login", tags=["Auth"])
@limiter.limit("5/minute")
async def login(request: Request, body: LoginRequest):
    """Log in with email + password. Returns access + refresh tokens in the JSON
    body (no cookie is set here -- the Next.js login route stores them as
    cookies on its side).

    ``body.email`` accepts an email OR a username (field name kept as
    ``email`` — same form contract as the Dash ``/__login`` route,
    app.py:1520-1528) via ``get_user_by_login``, which preserves
    ``get_user_by_email``'s exact matching behaviour for email so existing
    logins can't regress.
    """
    from backend.db import auth_repo as ar
    from backend.services import auth_service

    ctx = _audit_ctx.from_request(request)
    user = ar.get_user_by_login(body.email)
    if not user or not user.get("password_hash") or not auth_service.verify_password(
        body.password, user["password_hash"]
    ):
        # The submitted identifier is never stored; only whether it matched.
        audit_repo.record(
            "auth.login.failed",
            subject_user_id=user["id"] if user else None,
            origin_class=ctx.origin_class,
            client_key=ctx.client_key,
            detail={"known_identifier": bool(user)},
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Server-authoritative, amended 2026-09-10 (spec D1): "remembered" is
    # derived from the ingress path the request arrived over (Caddy's
    # X-Compendium-Ingress header, unspoofable from the public origin --
    # see auth_service.ingress_trusted), never a client-supplied opt-in.
    # Role is a DB lookup, never client-trusted, so the demo credential can
    # never obtain a remembered/90-day session.
    role = ar.get_role(user["id"])
    # demo-one-click-entry: on the public demo stack the demo account is
    # entered through POST /api/auth/demo only; the published password is
    # retired. Other roles are unaffected.
    if settings.demo_public_entry and role == "demo":
        audit_repo.record(
            "auth.login.failed",
            subject_user_id=user["id"],
            origin_class=ctx.origin_class,
            client_key=ctx.client_key,
            detail={"known_identifier": True, "reason": "demo_entry_only"},
        )
        raise HTTPException(status_code=401, detail="Invalid credentials")
    remembered = role != "demo" and auth_service.ingress_trusted(request.headers)

    access_token = auth_service.create_access_token(user["id"], user["email"])
    refresh_token = auth_service.create_refresh_token(user["id"], remembered=remembered)

    from backend.api.routers.tailnet_auth import maybe_trust_browser

    trusted, declined = maybe_trust_browser(request, user, body.trust_tailnet_login)
    detail = {"role": role, "remembered": remembered}
    if trusted:
        detail["trusted_browser_id"] = trusted[1]
    elif declined:
        detail["trust"] = f"declined:{declined}"
    audit_repo.record(
        "auth.login.ok",
        actor_user_id=user["id"],
        subject_user_id=user["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
        detail=detail,
    )
    response = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
        },
        "session_policy": auth_service.session_policy(role, remembered),
    }
    if trusted:
        response["browser_token"] = trusted[0]
    return response


class ViewAsRequest(BaseModel):
    profile: str = Field(..., min_length=1, max_length=50)


@app.post("/api/auth/view-as", tags=["Auth"])
async def view_as(
    request: Request,
    body: ViewAsRequest,
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
):
    """Admin-only: mint a demo-scoped access token (the JWT/API port of
    Dash's session-cookie ``/__view_as_demo`` switch — see
    frontend/dash/app.py:1566-1624 for the mechanism this mirrors).

    There is no ``users.view_as_user_id`` column to flip (dropped by
    migration 030) and no ``effective_id`` plumbing — the "acting as demo"
    state lives entirely in extra JWT claims (``acting_as_demo``,
    ``admin_origin_user_id``, ``admin_origin_email``) on a freshly minted
    token for the demo account, exactly like Dash stashes the equivalent
    markers in the signed session cookie.

    Guard order mirrors ``_do_view_as_demo``: admin role is re-checked from
    the DB (never trusted from the client), the CURRENT token is checked
    for an existing ``acting_as_demo`` claim to refuse nesting, then the
    demo account is resolved and its role re-verified.
    """
    if body.profile != "demo":
        raise HTTPException(
            status_code=422, detail="Only the 'demo' profile is supported"
        )

    from backend.db import auth_repo as ar
    from backend.services import auth_service

    ctx = _audit_ctx.from_request(request)

    def _denied(reason: str) -> None:
        audit_repo.record(
            "auth.viewas.denied",
            actor_user_id=user_id,
            origin_class=ctx.origin_class,
            client_key=ctx.client_key,
            detail={"reason": reason},
        )

    if ar.get_role(user_id) != "admin":
        _denied("not_admin")
        raise HTTPException(status_code=403, detail="Admin role required")

    if claims.get("acting_as_demo"):
        _denied("already_viewing_as_demo")
        raise HTTPException(
            status_code=403, detail="Already viewing as demo; cannot nest"
        )

    demo = ar.get_user_by_login("demo") or ar.get_user_by_email(
        "demo@traversal.local"
    )
    if not demo or ar.get_role(demo["id"]) != "demo":
        _denied("demo_account_unavailable")
        raise HTTPException(status_code=403, detail="Demo account unavailable")

    extra_claims: dict = {
        "acting_as_demo": True,
        "admin_origin_user_id": user_id,
    }
    # Pulled from the current token's own claims (no extra DB query) --
    # mirrors Dash's session["admin_origin_email"] = session["user_email"].
    admin_email = claims.get("email")
    if admin_email:
        extra_claims["admin_origin_email"] = admin_email

    # Deliberate deviation from Dash's 7-day token: there, the signed
    # session cookie is the actual authority and the JWT is just along for
    # the ride, so a long-lived token is harmless. Here the JWT itself is
    # the credential, so an acting-as-demo session must not be able to
    # outlive the admin's own sitting -- 60 minutes caps the blast radius
    # of a leaked acting token without requiring the admin to babysit it.
    access_token = auth_service.create_access_token(
        demo["id"],
        demo["email"],
        expires_minutes=60,
        extra_claims=extra_claims,
    )

    # No refresh_token, deliberately: refresh rotation would silently
    # resurrect the acting-as-demo identity past the 60-minute cap with no
    # further admin re-check, undermining the short TTL above. The acting
    # session ends when the access token expires or return-to-admin is
    # called -- there is no renewal path.
    audit_repo.record(
        "auth.viewas.start",
        actor_user_id=user_id,
        subject_user_id=demo["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": demo["id"],
            "email": demo["email"],
            "name": demo["name"],
        },
        # acting=True: resume False (no refresh path exists for this
        # token), remembered forced False, idle_minutes the acting cap
        # (informational only -- the 60-minute access-token TTL above is
        # the actual enforcement).
        "session_policy": auth_service.session_policy("demo", False, acting=True),
    }


@app.post("/api/auth/return-to-admin", tags=["Auth"])
async def return_to_admin(
    request: Request,
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
):
    """Return an admin-launched view-as-demo session to the admin account
    (the JWT port of Dash's ``/__return_to_admin`` — app.py:1627-1659).

    Acts ONLY on the ``acting_as_demo`` + ``admin_origin_user_id`` claims
    minted by ``/api/auth/view-as``. A direct demo login carries neither
    claim and cannot manufacture them client-side (they're inside a
    server-signed JWT), so this 403s for them — same "verified no-op for a
    plain demo login" posture as the Dash route.
    """
    if not claims.get("acting_as_demo") or not claims.get("admin_origin_user_id"):
        raise HTTPException(status_code=403, detail="Not currently viewing as demo")

    from backend.db import auth_repo as ar
    from backend.services import auth_service

    try:
        admin_id = int(claims["admin_origin_user_id"])
    except (TypeError, ValueError):
        # Defense-in-depth: the only code path that sets this claim
        # (view-as) always writes a real int uid, so a non-numeric value
        # here would require a token signed with our own secret carrying a
        # malformed claim -- not reachable through the public API today.
        # Closing it anyway so a malformed claim 403s instead of 500ing.
        raise HTTPException(status_code=403, detail="Invalid origin admin claim")

    # Re-check from the DB, not the token -- an admin demoted since minting
    # the view-as token should not be able to return to admin privileges.
    if ar.get_role(admin_id) != "admin":
        raise HTTPException(
            status_code=403, detail="Origin admin no longer has admin role"
        )

    admin = user_repo.get_user_by_id(admin_id)
    if not admin:
        raise HTTPException(status_code=403, detail="Origin admin not found")

    access_token = auth_service.create_access_token(admin["id"], admin["email"])

    ctx = _audit_ctx.from_request(request)
    audit_repo.record(
        "auth.viewas.stop",
        actor_user_id=admin["id"],
        subject_user_id=admin["id"],
        origin_class=ctx.origin_class,
        client_key=ctx.client_key,
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": admin["id"],
            "email": admin["email"],
            "name": admin["name"],
        },
        # remembered is not knowable here (no refresh token round-trips
        # through return-to-admin -- see the no-refresh comment above), so
        # a remembered admin re-enters the default (7-day/60-min) policy
        # until their next refresh rotation restores it from the DB-backed
        # `remembered` flag on their refresh token. The refresh response is
        # the authoritative source of a remembered policy, not this one.
        # Role is the literal "admin" -- already verified from the DB by
        # the ar.get_role(admin_id) != "admin" check above; a second
        # get_role round-trip here would be redundant.
        "session_policy": auth_service.session_policy("admin", False),
    }


class RefreshRequest(BaseModel):
    """Body for token refresh — avoids exposing tokens in query params/logs."""

    refresh_token: str


class LogoutRequest(BaseModel):
    """Body for logout — avoids exposing tokens in query params/logs."""

    refresh_token: str


@app.post("/api/auth/refresh", tags=["Auth"])
async def refresh_token_endpoint(request: Request, body: RefreshRequest):
    """Exchange a refresh token for a new access + refresh token pair.

    ``remembered`` is recomputed from the CURRENT ingress verdict on every
    rotation (spec D1, amended 2026-09-10) -- see
    ``auth_service.rotate_refresh_token`` / ``ingress_trusted``.
    """
    from backend.services import auth_service

    result = auth_service.rotate_refresh_token(
        body.refresh_token,
        auth_service.ingress_trusted(request.headers),
        audit_ctx=_audit_ctx.from_request(request),
    )
    if result is None:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    access, refresh, policy = result
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "session_policy": policy,
    }


@app.post("/api/auth/logout", tags=["Auth"])
async def logout(request: Request, body: LogoutRequest):
    """Revoke a refresh token."""
    from backend.services import auth_service

    auth_service.revoke_refresh_token(
        body.refresh_token, audit_ctx=_audit_ctx.from_request(request)
    )
    return {"logged_out": True}


@app.get("/api/auth/me", tags=["Auth"])
async def auth_me(
    user_id: int = Depends(verify_api_key),
    claims: dict = Depends(get_current_claims),
):
    """Return current user info.

    Additive fields on top of the historical id/email/name/api_key_prefix/
    created_at/preferences shape: ``role`` (get_role(uid)) and
    ``acting_as_demo`` (bool, read from the current token's claims — false
    for dev-bypass/API-key auth, where get_current_claims returns {}).
    When acting, also surfaces ``admin_origin_email`` straight from the
    claim the view-as token was minted with (no extra DB query).
    """
    from backend.db import auth_repo as ar

    user = user_repo.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user = dict(user)
    user["role"] = ar.get_role(user_id)
    acting_as_demo = bool(claims.get("acting_as_demo"))
    user["acting_as_demo"] = acting_as_demo
    if acting_as_demo and claims.get("admin_origin_email"):
        user["admin_origin_email"] = claims["admin_origin_email"]
    return user


# Preference keys a demo identity never sees from its stored row: every demo
# session starts on the app defaults (the default palette, All time).
DEMO_DEFAULTED_PREFERENCES = ("theme", "time_window")


@app.get("/api/auth/preferences", tags=["Auth"])
async def get_preferences(user_id: int = Depends(verify_api_key)):
    """Return current user's preferences.

    A demo identity (a direct demo login or an admin viewing as demo) gets
    them without ``DEMO_DEFAULTED_PREFERENCES``, so every reader falls back
    to the app defaults whatever the demo row holds.
    """
    from backend.db import auth_repo as ar

    prefs = ar.get_preferences(user_id)
    if ar.get_role(user_id) == "demo":
        prefs = {k: v for k, v in prefs.items() if k not in DEMO_DEFAULTED_PREFERENCES}
    return prefs


@app.patch("/api/auth/preferences", tags=["Auth"])
async def update_preferences(
    body: PreferencesRequest,
    user_id: int = Depends(verify_api_key),
):
    """Update user preferences (shallow merge).

    Demo write gate: no demo identity may write preferences, neither a
    direct demo login nor an admin viewing as demo, so clicks made while
    viewing as demo never change what demo visitors get (2026-10-04).
    Stricter than Dash's ``role_guard.is_plain_demo()``, which let view-as
    writes land on the demo row. Topic curation (``/api/topics``) keeps
    its own ``verify_not_plain_demo`` gate and is unaffected.
    """
    from backend.db import auth_repo as ar

    if ar.get_role(user_id) == "demo":
        raise HTTPException(
            status_code=403, detail="Demo account preferences are read-only"
        )

    ar.update_preferences(user_id, body.preferences)
    return ar.get_preferences(user_id)


# ── Topic interest endpoints ──────────────────────────────────────────


@app.get("/api/topics", tags=["Topics"])
async def list_topics(user_id: int = Depends(verify_api_key)):
    """Return current user's topic interests with assignment counts."""
    from backend.db import auth_repo as ar, cluster_repo

    prefs = ar.get_preferences(user_id)
    topics = prefs.get("topic_interests", [])
    sc_map = cluster_repo.get_super_cluster_map(user_id)

    for t in topics:
        t["cluster_count"] = sum(1 for v in sc_map.values() if v == t.get("keyword"))

    return {"topics": topics}


@app.post("/api/topics", tags=["Topics"])
async def add_topic(
    body: TopicAddRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Add a topic interest, pick an icon via LLM, and assign clusters."""
    from backend.db import auth_repo as ar
    from backend.services.super_cluster_service import (
        assign_super_clusters,
        select_icon_for_topic,
    )

    prefs = ar.get_preferences(user_id)
    topics: list[dict] = prefs.get("topic_interests", [])

    # Prevent duplicates
    if any(t["keyword"].lower() == body.keyword.lower() for t in topics):
        raise HTTPException(400, f"Topic '{body.keyword}' already exists")

    # LLM picks icon
    icon_id = await select_icon_for_topic(body.keyword)

    new_topic = {"keyword": body.keyword, "icon_id": icon_id}
    topics.append(new_topic)
    ar.update_preferences(user_id, {"topic_interests": topics})

    # Re-assign all clusters. Hybrid mode skips the legacy classifier —
    # running it here would overwrite hybrid group labels with keyword
    # classifications; the new keyword maps onto groups at the next recluster.
    if settings.supercluster_mode != "hybrid":
        await assign_super_clusters(user_id, topics)

    return {"topic": new_topic, "topics": topics}


@app.delete("/api/topics/exclusions", tags=["Topics"])
async def remove_member_exclusion(
    body: MemberExclusionRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Remove a (keyword, cluster) member exclusion — the pair becomes
    eligible for keyword membership again at the next recluster.

    Registered ahead of the ``/api/topics/{keyword}`` DELETE below: FastAPI
    matches routes in registration order, and a path-param route would
    otherwise swallow ``/api/topics/exclusions`` (keyword="exclusions").
    """
    from backend.db import auth_repo as ar
    from backend.services.clustering_service import _slugify

    keyword = body.keyword.strip()
    cluster_slug = _slugify(body.cluster_name.strip())

    prefs = ar.get_preferences(user_id)
    exclusions: list[dict] = prefs.get("sc_member_exclusions", [])
    updated = [
        e for e in exclusions
        if not (
            e["keyword"].lower() == keyword.lower() and e["cluster_slug"] == cluster_slug
        )
    ]
    if len(updated) != len(exclusions):
        ar.update_preferences(user_id, {"sc_member_exclusions": updated})
    return {"exclusions": updated}


@app.delete("/api/topics/{keyword}", tags=["Topics"])
async def remove_topic(
    keyword: str,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Remove a topic interest and re-assign clusters."""
    from backend.db import auth_repo as ar
    from backend.services.super_cluster_service import assign_super_clusters

    prefs = ar.get_preferences(user_id)
    topics: list[dict] = prefs.get("topic_interests", [])

    updated = [t for t in topics if t["keyword"].lower() != keyword.lower()]
    if len(updated) == len(topics):
        raise HTTPException(404, f"Topic '{keyword}' not found")

    ar.update_preferences(user_id, {"topic_interests": updated})
    # Same hybrid guard as add_topic: the legacy classifier would clobber
    # hybrid group labels; removal takes effect at the next recluster.
    if settings.supercluster_mode != "hybrid":
        await assign_super_clusters(user_id, updated)

    return {"topics": updated}


@app.patch("/api/topics/{keyword}", tags=["Topics"])
async def rename_topic(
    keyword: str,
    body: TopicRenameRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Rename a topic interest and re-assign clusters.

    REST equivalent of Dash's sc_rename_topic (frontend/dash/callbacks/
    topics.py:1509). *keyword* (path) identifies the topic to rename,
    matched case-insensitively like add/remove; ``body.keyword`` is the new
    name, whitespace-stripped -- a stripped-empty value is rejected rather
    than silently no-op'd, since that's a malformed request rather than a
    legitimate "no change" intent.
    """
    from backend.db import auth_repo as ar
    from backend.services.super_cluster_service import assign_super_clusters

    new_keyword = body.keyword.strip()
    if not new_keyword:
        raise HTTPException(400, "Topic keyword must be non-empty")

    prefs = ar.get_preferences(user_id)
    topics: list[dict] = prefs.get("topic_interests", [])

    idx = next(
        (i for i, t in enumerate(topics) if t["keyword"].lower() == keyword.lower()), None
    )
    if idx is None:
        raise HTTPException(404, f"Topic '{keyword}' not found")

    if new_keyword.lower() == topics[idx]["keyword"].lower():
        return {"topics": topics}  # no-op: unchanged

    if any(
        i != idx and t["keyword"].lower() == new_keyword.lower() for i, t in enumerate(topics)
    ):
        raise HTTPException(400, f"Topic '{new_keyword}' already exists")

    topics[idx]["keyword"] = new_keyword
    ar.update_preferences(user_id, {"topic_interests": topics})
    # Same hybrid guard as add_topic/remove_topic: the legacy classifier
    # would clobber hybrid group labels; the rename takes effect at the
    # next recluster in hybrid mode.
    if settings.supercluster_mode != "hybrid":
        await assign_super_clusters(user_id, topics)

    return {"topics": topics}


@app.get("/api/topics/suggestions", tags=["Topics"])
async def list_topic_suggestions(user_id: int = Depends(verify_api_key)):
    """Suggested topics = discovered groups no keyword matched (hybrid mode).

    Sourced from the latest completed recluster run, ranked by interest tier
    then size; dismissed labels are filtered out (case-insensitive).
    """
    from backend.db import auth_repo as ar, cluster_repo
    from backend.services.supercluster_discovery import TIER_ORDER

    prefs = ar.get_preferences(user_id)
    dismissed = {
        d["label"].lower() for d in prefs.get("dismissed_topics", [])
    }
    groups = cluster_repo.get_groups_for_user(user_id)
    tier_rank = {t: i for i, t in enumerate(TIER_ORDER)}
    suggestions = sorted(
        (g for g in groups
         if g["source"] == "suggested" and g["label"].lower() not in dismissed),
        key=lambda g: (tier_rank.get(g["interest_tier"], 99), -g["page_count"]),
    )
    # Split proposals (batch C C2): declared umbrellas spanning >=2 fine
    # subgroups. Display-only until the accept-semantics decision lands.
    splits = [
        {"group_id": g["id"], "topic": g["topic"],
         "split_proposal": g["split_proposal"]}
        for g in groups
        if g["source"] in ("keyword", "accepted") and g.get("split_proposal")
    ]
    return {"suggestions": suggestions, "splits": splits}


@app.post("/api/topics/suggestions/{group_id}/accept", tags=["Topics"])
async def accept_topic_suggestion(
    group_id: int,
    body: SuggestionAcceptRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Accept a suggested group as a declared topic.

    The keyword defaults to the group's suggested label (pass ``keyword`` to
    rename on accept). Adds it to topic_interests (LLM icon), marks the group
    accepted, and relabels its member clusters immediately — the graph
    reflects the acceptance without waiting for the next recluster.
    """
    from backend.db import auth_repo as ar, cluster_repo
    from backend.services.super_cluster_service import select_icon_for_topic

    groups = cluster_repo.get_groups_for_user(user_id)
    group = next((g for g in groups if g["id"] == group_id), None)
    if group is None:
        raise HTTPException(404, f"Suggested group {group_id} not found")

    keyword = (body.keyword or group["label"]).strip()
    if not keyword:
        raise HTTPException(400, "Keyword must be non-empty")

    prefs = ar.get_preferences(user_id)
    topics: list[dict] = prefs.get("topic_interests", [])
    if not any(t["keyword"].lower() == keyword.lower() for t in topics):
        icon_id = await select_icon_for_topic(keyword)
        topics.append({"keyword": keyword, "icon_id": icon_id})

    # Un-dismiss if it was previously dismissed under this label
    dismissed = [
        d for d in prefs.get("dismissed_topics", [])
        if d["label"].lower() != group["label"].lower()
    ]
    ar.update_preferences(
        user_id, {"topic_interests": topics, "dismissed_topics": dismissed}
    )

    relabeled = cluster_repo.update_group_acceptance(user_id, group_id, keyword)
    return {
        "topic": {"keyword": keyword},
        "topics": topics,
        "relabeled_clusters": len(relabeled),
    }


@app.post("/api/topics/suggestions/{group_id}/dismiss", tags=["Topics"])
async def dismiss_topic_suggestion(
    group_id: int,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Dismiss a suggested topic: it stops being re-suggested under this
    label. Recorded in preferences (weak negative interest signal for the
    batch-C scoring work)."""
    from datetime import datetime as _dt

    from backend.db import auth_repo as ar, cluster_repo

    groups = cluster_repo.get_groups_for_user(user_id)
    group = next((g for g in groups if g["id"] == group_id), None)
    if group is None:
        raise HTTPException(404, f"Suggested group {group_id} not found")

    prefs = ar.get_preferences(user_id)
    dismissed: list[dict] = prefs.get("dismissed_topics", [])
    if not any(d["label"].lower() == group["label"].lower() for d in dismissed):
        dismissed.append(
            {
                "label": group["label"],
                "dismissed_at": _dt.now().astimezone().isoformat(timespec="seconds"),
            }
        )
    ar.update_preferences(user_id, {"dismissed_topics": dismissed})
    return {"dismissed": group["label"], "dismissed_topics": dismissed}


@app.get("/api/topics/exclusions", tags=["Topics"])
async def list_member_exclusions(user_id: int = Depends(verify_api_key)):
    """List durable class-(e) member exclusions: (keyword, cluster) pairs
    the user dismissed as "doesn't belong here", honored by the SC pipeline
    forever (sc-followups 2026-07-16)."""
    from backend.db import auth_repo as ar

    prefs = ar.get_preferences(user_id)
    return {"exclusions": prefs.get("sc_member_exclusions", [])}


@app.get("/api/topics/{keyword}/members", tags=["Topics"])
async def list_topic_members(
    keyword: str,
    limit: int = Query(50, ge=1, le=200),
    user_id: int = Depends(verify_api_key),
):
    """Top member clusters of a supercluster keyword, for the popover/
    tooltip member list. Read-only -- not demo-gated.

    Thin wrapper over cluster_repo.get_top_clusters_for_keyword, which is
    already user-scoped and scoped to the latest completed recluster run
    (ordered mean_membership_probability DESC NULLS LAST, page_count DESC,
    cluster_name). 50 is Dash's SC_POPOVER_MEMBER_CAP (frontend/dash/
    callbacks/topics.py:636); the hover tooltip caller passes limit=5. An
    unknown/memberless keyword returns an empty list (repo semantics), not
    a 404 -- there's no "topic" entity to 404 on, just an absence of
    matching clusters.
    """
    from backend.db import cluster_repo

    members = cluster_repo.get_top_clusters_for_keyword(user_id, keyword, limit)
    return {"members": members}


@app.post("/api/topics/exclusions", tags=["Topics"])
async def add_member_exclusion(
    body: MemberExclusionRequest,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Record a (keyword, cluster) member exclusion and immediately unlabel
    the cluster if it is currently painted with that keyword — the graph
    reflects the exclusion without waiting for the next recluster.

    Dedupes on (keyword.lower(), cluster_slug), same as the dismiss-topic
    precedent above.
    """
    from datetime import datetime as _dt

    from backend.db import auth_repo as ar
    from backend.services.clustering_service import _slugify
    from backend.services.super_cluster_service import apply_member_exclusion_now

    keyword = body.keyword.strip()
    cluster_name = body.cluster_name.strip()
    cluster_slug = _slugify(cluster_name)

    prefs = ar.get_preferences(user_id)
    exclusions: list[dict] = prefs.get("sc_member_exclusions", [])
    if not any(
        e["keyword"].lower() == keyword.lower() and e["cluster_slug"] == cluster_slug
        for e in exclusions
    ):
        exclusions.append(
            {
                "keyword": keyword,
                "cluster_slug": cluster_slug,
                "cluster_name": cluster_name,
                "created_at": _dt.now().astimezone().isoformat(timespec="seconds"),
            }
        )
        ar.update_preferences(user_id, {"sc_member_exclusions": exclusions})

    unlabeled = apply_member_exclusion_now(user_id, keyword, cluster_slug)
    return {"exclusions": exclusions, "unlabeled": unlabeled}


@app.put("/api/topics/{keyword}/icon", tags=["Topics"])
async def override_topic_icon(
    keyword: str,
    body: TopicIconOverride,
    user_id: int = Depends(verify_not_plain_demo),
):
    """Override the LLM-selected icon for a topic."""
    from backend.db import auth_repo as ar

    prefs = ar.get_preferences(user_id)
    topics: list[dict] = prefs.get("topic_interests", [])

    found = False
    for t in topics:
        if t["keyword"].lower() == keyword.lower():
            t["icon_id"] = body.icon_id
            found = True
            break

    if not found:
        raise HTTPException(404, f"Topic '{keyword}' not found")

    ar.update_preferences(user_id, {"topic_interests": topics})
    return {"topics": topics}


# ---------------------------------------------------------------------------
# Late router registrations (placed AFTER verify_api_key is defined to avoid
# the circular-import failure that occurs when a router imports verify_api_key
# from this module while this module is still being executed).
# ---------------------------------------------------------------------------

from backend.api.routers import dq_bot as _dq_bot_router  # noqa: E402

app.include_router(_dq_bot_router.router)

from backend.api.routers import pipeline as _pipeline_router  # noqa: E402

app.include_router(_pipeline_router.router)

from backend.api.routers import overview as _overview_router  # noqa: E402

app.include_router(_overview_router.router)

from backend.api.routers import clusters as _clusters_router  # noqa: E402

app.include_router(_clusters_router.router)

from backend.api.routers import prompts as _prompts_router  # noqa: E402

app.include_router(_prompts_router.router)

from backend.api.routers import tailnet_auth as _tailnet_auth_router  # noqa: E402

app.include_router(_tailnet_auth_router.router)

from backend.api.routers import demo_entry as _demo_entry_router  # noqa: E402

app.include_router(_demo_entry_router.router)
