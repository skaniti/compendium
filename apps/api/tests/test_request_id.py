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


def test_long_unbroken_alnum_run_is_treated_as_secret_shaped():
    # 48+ unbroken [A-Za-z0-9_-] characters match the audit table's key patterns, so the
    # id is replaced by a uuid rather than logged truncated.
    assert _is_uuid(ci.clean_request_id("a" * 5000))


def test_control_and_separator_chars_stripped():
    out = ci.clean_request_id("ab\x00c\x1b[31md\r\ne f g\x7f")
    assert out == "abc[31mdefg"


def test_empty_or_invalid_replaced_by_uuid():
    for bad in (None, "", "   ", "\x00\x01\r\n", " ​"):
        assert _is_uuid(ci.clean_request_id(bad)), bad


def test_secret_shaped_id_replaced_by_uuid():
    assert _is_uuid(ci.clean_request_id("sk-ant-" + "x" * 40))


def test_middleware_echoes_cleaned_value():
    client = TestClient(app)
    r = client.get("/health", headers={"X-Request-ID": "req.id." * 70})
    assert r.headers["X-Request-ID"] == ("req.id." * 10)[: ci.REQUEST_ID_MAX_LEN]
    r = client.get("/health", headers={"X-Request-ID": "good-id-1"})
    assert r.headers["X-Request-ID"] == "good-id-1"
    r = client.get("/health")
    assert _is_uuid(r.headers["X-Request-ID"])
