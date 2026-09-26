"""Interactive API docs are off outside development (mig-06 Task 2,
2026-09-26 backend prod-hardening checklist, item C).

Once the FastAPI backend gets its own public hostname (routed straight
from the Cloudflare Tunnel, no Dash proxy in front -- see the public-demo
exposure audit handoff, mig-06 section), ``/docs``, ``/redoc`` and
``/openapi.json`` become directly reachable for the first time. They must
be disabled whenever ``settings.environment != "development"`` and stay on
in development (the existing local-dev workflow).

``docs_url``/``redoc_url``/``openapi_url`` are constructor kwargs on
``FastAPI()`` (``backend/api/main.py:495-503``) -- baked into the ``app``
object once, at import time, not re-evaluated per request. To exercise
both environments this file runs a small probe script in a **fresh
subprocess** per environment, with real env vars (not a monkeypatched
``settings`` attribute), rather than ``importlib.reload``-ing
``backend.api.main`` in-process.

Why not reload: ``importlib.reload`` re-executes ``app = FastAPI(...)``
and ``limiter = Limiter(...)`` (line 522) against the SAME
``sys.modules["backend.api.main"]`` entry every other already-collected
test file bound ``app``/``limiter`` from at collection time. After a
reload, ``main.app`` is a fresh object while every other file's ``app``
reference still points at the original -- among other things, the
autouse rate-limiter-reset fixture in ``conftest.py`` would reset the
*new* app's limiter and never again the original's. A subprocess
sidesteps this entirely: its own interpreter, its own ``sys.modules``,
its own real ``Settings()`` construction -- exercising the actual
production boot path end to end -- and it never touches this process's
``backend.api.main``.

No database connectivity is required: a bare ``TestClient(app)`` (no
``with`` block) never runs the ASGI lifespan -- verified empirically
against a real boot: the SBERT/reranker preload and startup DB sweep
only fire once the lifespan context manager actually enters -- and none
of ``/docs``/``/redoc``/``/openapi.json`` touch the database anyway.
"""

import os
import subprocess
import sys
from pathlib import Path

_API_ROOT = Path(__file__).resolve().parents[1]

_PROBE_SCRIPT = """
from fastapi.testclient import TestClient
from backend.api.main import app

client = TestClient(app)
codes = [
    client.get("/docs").status_code,
    client.get("/redoc").status_code,
    client.get("/openapi.json").status_code,
]
print(" ".join(str(c) for c in codes))
"""

# The four ``Settings._check_production_secrets`` validators
# (``backend/config/settings.py``) a real ``ENVIRONMENT=production`` boot
# must satisfy, or the subprocess never gets far enough to serve a
# request: a non-default ``JWT_SECRET_KEY``, an explicit (non-wildcard)
# ``CORS_ORIGINS``, ``SESSION_TRUST_MISSING_INGRESS=0`` -- this machine's
# gitignored local ``.env`` sets that dev-only knob on for solo local dev,
# and it would otherwise leak into the subprocess (env vars we pass below
# take precedence over the dotenv file, but this key isn't one of them
# unless listed here) and trip the same validator -- and (batch-06,
# deploy-flip fix wave) a non-default ``SESSION_INGRESS_TRUSTED_VALUE``,
# since the local ``.env`` doesn't set that one at all and the subprocess
# would otherwise inherit the class default and trip the new validator.
_PROD_ENV = {
    "JWT_SECRET_KEY": "test-only-probe-secret-never-used-elsewhere",
    "CORS_ORIGINS": "https://compendium.example.test",
    "SESSION_TRUST_MISSING_INGRESS": "0",
    "SESSION_INGRESS_TRUSTED_VALUE": "test-only-probe-ingress-value-never-used-elsewhere",
}


def _probe_docs_endpoints(environment: str, extra_env: dict[str, str]) -> tuple[int, int, int]:
    """Boot ``backend.api.main`` in a fresh subprocess under ``environment``
    (plus any validator-satisfying overrides) and return the
    (docs, redoc, openapi) status codes it printed."""
    env = {**os.environ, "ENVIRONMENT": environment, **extra_env}
    result = subprocess.run(
        [sys.executable, "-c", _PROBE_SCRIPT],
        cwd=str(_API_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, (
        f"probe subprocess exited {result.returncode}\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    docs, redoc, openapi = (int(code) for code in result.stdout.strip().split())
    return docs, redoc, openapi


def test_docs_endpoints_404_outside_development():
    docs, redoc, openapi = _probe_docs_endpoints("production", _PROD_ENV)
    assert docs == 404
    assert redoc == 404
    assert openapi == 404


def test_docs_endpoints_200_in_development():
    docs, redoc, openapi = _probe_docs_endpoints("development", {})
    assert docs == 200
    assert redoc == 200
    assert openapi == 200
