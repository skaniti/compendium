"""/health must answer HEAD as well as GET.

Uptime pingers on free plans (UptimeRobot's plain HTTP(s) monitor) probe with
HEAD and cannot be switched to GET; a GET-only route answers 405 and the
monitor reports the API down while it is healthy (batch 06, 2026-09-26).
"""

from fastapi.testclient import TestClient

from backend.api.main import app


def test_health_get_ok():
    with TestClient(app) as tc:
        resp = tc.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"]


def test_health_head_ok():
    with TestClient(app) as tc:
        resp = tc.head("/health")
    assert resp.status_code == 200
    assert resp.content == b""
