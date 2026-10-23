"""A rejected request names its client (backlog #77).

Real test DB for the audit row; caplog for the request log line. Covers the
three records the 2026-10-07 cutover hunt lacked: the request-completed line
on any 4xx, the api_key.auth_failed audit detail, and a refused CORS
preflight (recorded nowhere with its Origin before).

Fake credentials are assembled at runtime; every test asserts the presented
key never appears in a log field or a row.
"""

import json
import logging

import pytest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from starlette.middleware import Middleware

from backend.config.settings import settings
from backend.db import audit_repo
from backend.db.connection import get_conn

BAD_KEY = "cmp_" + "bad0" * 8
EXT_HEADERS = {
    "X-Compendium-Client": "extension/0.5.1",
    "X-Compendium-Device": "Desktop%20Firefox",
    "User-Agent": "Mozilla/5.0 (X11; Linux) Firefox/130.0",
    "Origin": "moz-extension://11111111-2222-3333-4444-555555555555",
}


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def env(monkeypatch):
    # Production mode so the dev auth bypass cannot short-circuit the key path.
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "session_trust_missing_ingress", False)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM audit_events")


@pytest.fixture
def client():
    from backend.api.main import app

    return TestClient(app)


@pytest.fixture
def strict_cors(monkeypatch):
    """Rebuild the app's middleware stack with one allowed origin, so a
    foreign Origin's preflight is refused the way production refuses it."""
    from backend.api import main

    allowed = ["https://app.example"]
    patched = []
    for mw in main.app.user_middleware:
        if mw.cls is CORSMiddleware:
            mw = Middleware(CORSMiddleware, **{**mw.kwargs, "allow_origins": allowed})
        patched.append(mw)
    monkeypatch.setattr(main.app, "user_middleware", patched)
    monkeypatch.setattr(main.app, "middleware_stack", None)
    monkeypatch.setattr(main, "_cors_origins", allowed)


def _request_lines(caplog, path):
    return [
        r
        for r in caplog.records
        if r.getMessage() == "request completed" and getattr(r, "path", None) == path
    ]


def _no_key_anywhere(caplog):
    blob = json.dumps([r.__dict__.get("msg") for r in caplog.records], default=str) + json.dumps(
        [{k: v for k, v in r.__dict__.items() if k != "args"} for r in caplog.records],
        default=str,
    )
    assert BAD_KEY not in blob


# -- audit detail -----------------------------------------------------------


def test_bad_key_audit_detail_names_the_client(env, client):
    r = client.get("/api/auth/me", headers={"X-API-Key": BAD_KEY, **EXT_HEADERS})
    assert r.status_code == 401
    row = audit_repo.list_events(event="api_key.auth_failed")[0]
    assert row["detail"] == {
        "prefix": BAD_KEY[:8],
        "client": "extension",
        "client_version": "0.5.1",
        "device": "Desktop Firefox",
        "origin": EXT_HEADERS["Origin"],
        "user_agent": EXT_HEADERS["User-Agent"],
    }
    assert BAD_KEY not in json.dumps(row["detail"])


def test_bad_key_audit_detail_without_client_headers_is_unknown(env, client):
    assert client.get("/api/auth/me", headers={"X-API-Key": BAD_KEY}).status_code == 401
    detail = audit_repo.list_events(event="api_key.auth_failed")[0]["detail"]
    assert detail["prefix"] == BAD_KEY[:8]
    assert detail["client"] == "unknown"
    assert set(detail) <= {"prefix", "client", "user_agent"}


def test_oversized_client_values_are_truncated_in_the_audit_row(env, client):
    headers = {
        "X-API-Key": BAD_KEY,
        # dotted so the audit scrubber's 48+ char token shape does not fire
        "X-Compendium-Device": "ab." * 200,
        "User-Agent": "ab." * 400,
        "Origin": "https://" + "ab." * 200,
    }
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    detail = audit_repo.list_events(event="api_key.auth_failed")[0]["detail"]
    assert len(detail["device"]) == 64
    assert len(detail["user_agent"]) == 200
    assert len(detail["origin"]) == 100


# -- request log line -------------------------------------------------------


def test_key_pasted_into_a_client_field_is_scrubbed_from_log_and_audit(env, client, caplog):
    caplog.set_level(logging.DEBUG)
    headers = {"X-API-Key": BAD_KEY, "X-Compendium-Device": BAD_KEY, "User-Agent": BAD_KEY}
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    (line,) = _request_lines(caplog, "/api/auth/me")
    assert line.device == "<redacted>" and line.user_agent == "<redacted>"
    detail = audit_repo.list_events(event="api_key.auth_failed")[0]["detail"]
    assert detail["device"] == "<redacted>" and detail["user_agent"] == "<redacted>"
    assert BAD_KEY not in json.dumps(detail)
    _no_key_anywhere(caplog)


def test_4xx_request_line_names_the_client(env, client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.get("/api/auth/me", headers={"X-API-Key": BAD_KEY, **EXT_HEADERS})
    assert r.status_code == 401
    (line,) = _request_lines(caplog, "/api/auth/me")
    assert line.status_code == 401
    assert line.client == "extension"
    assert line.client_version == "0.5.1"
    assert line.device == "Desktop Firefox"
    assert line.origin == EXT_HEADERS["Origin"]
    assert line.user_agent == EXT_HEADERS["User-Agent"]
    assert not hasattr(line, "cors_preflight_rejected")
    _no_key_anywhere(caplog)


def test_successful_request_line_carries_no_client_fields(env, client, caplog):
    caplog.set_level(logging.DEBUG)
    assert client.get("/health", headers=EXT_HEADERS).status_code == 200
    (line,) = _request_lines(caplog, "/health")
    assert line.status_code == 200
    for field in ("client", "device", "origin", "user_agent"):
        assert not hasattr(line, field)


# -- CORS preflight ---------------------------------------------------------


def test_refused_preflight_logs_the_origin(env, strict_cors, client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.options(
        "/api/passive-captures",
        headers={
            "Origin": "https://stale.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-api-key",
            "User-Agent": "Mozilla/5.0 preflight-test",
        },
    )
    assert r.status_code == 400
    (line,) = _request_lines(caplog, "/api/passive-captures")
    assert line.method == "OPTIONS" and line.status_code == 400
    assert line.cors_preflight_rejected is True
    assert line.cors_origin_allowed is False
    assert line.origin == "https://stale.example"
    assert line.cors_request_method == "POST"
    assert line.cors_request_headers == "content-type,x-api-key"
    assert line.user_agent == "Mozilla/5.0 preflight-test"
    assert line.client == "web"


def test_allowed_preflight_is_not_flagged(env, strict_cors, client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.options(
        "/api/passive-captures",
        headers={
            "Origin": "https://app.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code == 200
    (line,) = _request_lines(caplog, "/api/passive-captures")
    assert not hasattr(line, "cors_preflight_rejected")
    assert not hasattr(line, "client")
