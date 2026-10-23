"""X-Request-ID sanitising (backlog 208): cap, strip, fall back to a uuid."""

import uuid

from fastapi.testclient import TestClient

from backend.api import client_identity as ci
from backend.api.main import app


def _is_uuid(v: str) -> bool:
    try:
        uuid.UUID(v)
        return True
    except ValueError:
        return False


def test_normal_id_passes_through():
    assert ci.clean_request_id("req-123_abc.DEF") == "req-123_abc.DEF"
    u = str(uuid.uuid4())
    assert ci.clean_request_id(u) == u


def test_overlong_id_truncated():
    out = ci.clean_request_id("req.id." * 700)
    assert out == ("req.id." * 10)[: ci.REQUEST_ID_MAX_LEN]
    assert len(out) == ci.REQUEST_ID_MAX_LEN


def test_long_unbroken_alnum_run_is_truncated_not_replaced():
    assert ci.clean_request_id("a" * 5000) == "a" * ci.REQUEST_ID_MAX_LEN


def test_control_and_separator_chars_stripped():
    out = ci.clean_request_id("ab\x00c\x1b[31md\r\ne f g\x7f")
    assert out == "abc[31mdefg"


def test_empty_or_invalid_replaced_by_uuid():
    for bad in (None, "", "   ", "\x00\x01\r\n", " ​"):
        assert _is_uuid(ci.clean_request_id(bad)), bad


def test_secret_shaped_id_replaced_by_uuid():
    assert _is_uuid(ci.clean_request_id("sk-ant-" + "x" * 40))


def test_long_hyphenated_and_hex_ids_pass_through_truncated():
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    assert len(traceparent) == 55
    assert ci.clean_request_id(traceparent) == traceparent
    hex64 = "a1b2c3d4" * 8
    assert ci.clean_request_id(hex64) == hex64
    assert ci.clean_request_id(hex64 + "ff") == hex64


def test_bearer_with_space_still_redacted():
    assert _is_uuid(ci.clean_request_id("Bearer " + "A1b2C3d4" * 3))
    assert _is_uuid(ci.clean_request_id("token=abcdef"))


def test_cleaned_id_on_error_response():
    client = TestClient(app)
    r = client.post(
        "/api/anything",
        headers={"X-Request-ID": "bad\x01id " + "r" * 100, "Content-Length": str(10**9)},
        content=b"x",
    )
    assert r.status_code == 413
    assert r.headers["X-Request-ID"] == "badid" + "r" * (ci.REQUEST_ID_MAX_LEN - 5)


def test_middleware_echoes_cleaned_value():
    client = TestClient(app)
    r = client.get("/health", headers={"X-Request-ID": "req.id." * 70})
    assert r.headers["X-Request-ID"] == ("req.id." * 10)[: ci.REQUEST_ID_MAX_LEN]
    r = client.get("/health", headers={"X-Request-ID": "good-id-1"})
    assert r.headers["X-Request-ID"] == "good-id-1"
    r = client.get("/health")
    assert _is_uuid(r.headers["X-Request-ID"])
