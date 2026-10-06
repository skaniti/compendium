"""Shape checks for the server compose files (tailnet-owner-demo-split)."""
from pathlib import Path

import yaml

COMPOSE_DIR = Path(__file__).resolve().parent.parent / "docker"
REPO_ROOT = Path(__file__).resolve().parents[3]


def _load(name: str) -> dict:
    return yaml.safe_load((COMPOSE_DIR / name).read_text())


def test_owner_compose_keeps_its_default_project_name():
    # Adding `name:` would rename the project and orphan its volumes.
    assert "name" not in _load("docker-compose.server.yml")


def test_owner_web_service_shape():
    web = _load("docker-compose.server.yml")["services"]["web"]
    assert (COMPOSE_DIR / web["build"]["context"]).resolve() == REPO_ROOT
    assert web["build"]["dockerfile"] == "apps/web/Dockerfile"
    assert web["build"]["args"]["NEXT_PUBLIC_DEMO_ROLE_TOOLING"] == "1"
    assert web["image"] == "compendium-web:server"
    assert web["container_name"] == "compendium-web"
    assert web["environment"]["BACKEND_URL"] == "http://compendium-api:8000"
    assert web["environment"]["AUTH_REQUIRED"] == "1"
    assert web["ports"] == ["127.0.0.1:${WEB_HOST_PORT:-3000}:3000"]
    assert web["networks"] == ["compendium-net"]
    assert web["depends_on"]["api"]["condition"] == "service_healthy"


def test_owner_api_passes_the_tailnet_only_flag_defaulting_off():
    env = _load("docker-compose.server.yml")["services"]["api"]["environment"]
    assert env["TAILNET_ONLY_DEPLOYMENT"] == "${TAILNET_ONLY_DEPLOYMENT:-0}"


def test_every_owner_port_is_loopback_bound():
    for svc in _load("docker-compose.server.yml")["services"].values():
        for port in svc.get("ports", []):
            assert port.startswith("127.0.0.1:"), port


def test_web_dockerfile_takes_the_role_tooling_build_arg():
    text = (REPO_ROOT / "apps/web/Dockerfile").read_text()
    assert 'ARG NEXT_PUBLIC_DEMO_ROLE_TOOLING=""' in text
    assert "ENV NEXT_PUBLIC_DEMO_ROLE_TOOLING=$NEXT_PUBLIC_DEMO_ROLE_TOOLING" in text
