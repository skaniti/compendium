"""audit_ctx.from_request on a tailnet-only deployment (tailnet-owner-demo-split)."""
from starlette.requests import Request

from backend.api import audit_ctx
from backend.config.settings import settings


def _req(headers: dict[str, str]) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": ("203.0.113.9", 1234),
        }
    )


def test_tailnet_only_classifies_a_headerless_request_as_tailnet(monkeypatch):
    monkeypatch.setattr(settings, "tailnet_only_deployment", True)
    assert audit_ctx.from_request(_req({})).origin_class == "tailnet"


def test_tailnet_only_overrides_a_public_header(monkeypatch):
    monkeypatch.setattr(settings, "tailnet_only_deployment", True)
    ctx = audit_ctx.from_request(_req({"X-Compendium-Ingress": "public"}))
    assert ctx.origin_class == "tailnet"


def test_default_headerless_request_stays_unknown(monkeypatch):
    monkeypatch.setattr(settings, "tailnet_only_deployment", False)
    assert audit_ctx.from_request(_req({})).origin_class == "unknown"
