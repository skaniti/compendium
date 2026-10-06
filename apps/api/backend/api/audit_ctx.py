"""Request-derived context for audit_events hooks.

Kept dependency-light (no auth_service import at module load) so the db and
service layers can import `AuditCtx` without a cycle.
"""

from dataclasses import dataclass

from backend.api.rate_limit_key import client_key
from backend.config.settings import settings


@dataclass(frozen=True)
class AuditCtx:
    origin_class: str
    client_key: str | None


CLI = AuditCtx("cli", None)


def from_request(request) -> AuditCtx:
    """Map a request to (origin_class, client_key). Never raises."""
    try:
        from backend.services import auth_service

        if settings.tailnet_only_deployment:
            origin = "tailnet"
        elif request.headers.get(settings.session_ingress_header) is None:
            origin = "unknown"
        elif auth_service.ingress_trusted(request.headers):
            origin = "tailnet"
        else:
            origin = "public"
        return AuditCtx(origin, client_key(request))
    except Exception:  # noqa: BLE001 - context derivation must not break routes
        return AuditCtx("unknown", None)
