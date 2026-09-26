"""Interactive API docs are off outside development (mig-06 Task 2,
2026-09-26 backend prod-hardening checklist, item C).

Once the FastAPI backend gets its own public hostname (routed straight
from the Cloudflare Tunnel, no Dash proxy in front -- see the public-demo
exposure audit handoff, mig-06 section), ``/docs``, ``/redoc`` and
``/openapi.json`` become directly reachable for the first time. They must
be disabled whenever ``settings.environment != "development"`` and stay on
in development (the existing local-dev workflow).

``docs_url``/``redoc_url``/``openapi_url`` are constructor kwargs on
``FastAPI()`` -- baked into the ``app`` object at import time, not
re-evaluated per request. To exercise both environments in one test
session we reload ``backend.api.main`` after mutating the ``settings``
singleton's ``environment`` attribute directly (same manual
save/reload/restore pattern as
``tests/test_dq_agent_prompt.py::test_default_model_constant_is_opus_1m``),
then always reload once more in a ``finally`` block so the module-level
``app`` singleton other test files already imported (via
``from backend.api.main import app``, captured once at collection time)
is never left in a mutated state for the rest of the session.
"""

import importlib

from fastapi.testclient import TestClient

from backend.config.settings import settings


def _reload_main():
    from backend.api import main

    importlib.reload(main)
    return main


def test_docs_endpoints_404_outside_development():
    original_env = settings.environment
    settings.environment = "production"
    try:
        main = _reload_main()
        client = TestClient(main.app)
        assert client.get("/docs").status_code == 404
        assert client.get("/redoc").status_code == 404
        assert client.get("/openapi.json").status_code == 404
    finally:
        settings.environment = original_env
        _reload_main()


def test_docs_endpoints_200_in_development():
    original_env = settings.environment
    settings.environment = "development"
    try:
        main = _reload_main()
        client = TestClient(main.app)
        assert client.get("/docs").status_code == 200
        assert client.get("/redoc").status_code == 200
        assert client.get("/openapi.json").status_code == 200
    finally:
        settings.environment = original_env
        _reload_main()
