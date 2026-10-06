"""Shape checks for the server compose files (tailnet-owner-demo-split)."""
import re
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


DEMO = "docker-compose.demo.yml"


def test_demo_project_and_names_never_collide_with_the_owner_stack():
    demo, owner = _load(DEMO), _load("docker-compose.server.yml")
    assert demo["name"] == "compendium-demo"
    owner_names = {s.get("container_name") for s in owner["services"].values()}
    owner_images = {s.get("image") for s in owner["services"].values()}
    for svc in demo["services"].values():
        assert svc["container_name"] not in owner_names
        assert svc["image"] not in owner_images


def test_demo_never_mounts_owner_secrets_or_owner_assets():
    for svc in _load(DEMO)["services"].values():
        for vol in svc.get("volumes", []):
            assert ".secrets" not in vol
            assert "compendium-assets" not in vol
            assert "CAPTURES_ASSETS_HOST_DIR" not in vol


def test_demo_assets_are_the_repo_fixtures_read_only():
    src, dst, mode = _load(DEMO)["services"]["api"]["volumes"][0].split(":")
    assert (dst, mode) == ("/app/data/captures/assets", "ro")
    fixtures = REPO_ROOT / "apps/web/demo/fixtures/assets/captured-assets"
    assert (COMPOSE_DIR / src).resolve() == fixtures
    assert fixtures.is_dir()


def test_demo_db_publishes_no_port_and_api_is_loopback_only():
    services = _load(DEMO)["services"]
    assert "ports" not in services["db"]
    assert services["api"]["ports"] == ["127.0.0.1:${DEMO_API_HOST_PORT:-8002}:8000"]


def test_demo_network_has_the_fixed_bridge_and_subnet():
    demo = _load(DEMO)
    net = demo["networks"]["demo"]
    assert net["name"] == "compendium-demo-net"
    assert net["driver_opts"]["com.docker.network.bridge.name"] == "br-compdemo"
    assert net["ipam"]["config"][0]["subnet"] == "172.31.250.0/24"
    for svc in demo["services"].values():
        assert svc["networks"] == ["demo"]


def test_demo_api_resolves_names_through_public_dns():
    assert _load(DEMO)["services"]["api"]["dns"] == ["1.1.1.1", "9.9.9.9"]


def test_demo_api_runtime_env():
    env = _load(DEMO)["services"]["api"]["environment"]
    expected = {
        "ENVIRONMENT": "production",
        "SEED_DEMO": "1",
        "DEMO_SEED_ARGS": "--replace",
        "BOOTSTRAP_DEMO_ONLY": "1",
        "ENABLE_NIGHTLY_MAINT": "0",
        "DQ_BOT_DISABLED": "true",
        "RERANKER_DISABLED": "1",
        "DISABLE_REGISTRATION": "1",
    }
    for key, value in expected.items():
        assert env[key] == value, key
    assert env["DEV_DEFAULT_USER_EMAIL"] == env["BOOTSTRAP_DEMO_EMAIL"]
    assert "TAILNET_ONLY_DEPLOYMENT" not in env
    assert "PENDING_SWEEP_INTERVAL_SECONDS" not in env


def test_every_demo_interpolation_is_demo_prefixed():
    # Compose lets the calling shell override --env-file values; a plain
    # name would let an exported owner secret reach the public stack.
    names = set(re.findall(r"\$\{([A-Za-z0-9_]+)", (COMPOSE_DIR / DEMO).read_text()))
    assert names
    assert sorted(n for n in names if not n.startswith("DEMO_")) == []


def test_the_env_template_lists_every_required_demo_var():
    text = (COMPOSE_DIR / DEMO).read_text()
    required = set(re.findall(r"\$\{(DEMO_[A-Z0-9_]+):\?", text))
    template = (COMPOSE_DIR / "demo-stack.env.example").read_text()
    assert required
    for name in required:
        assert re.search(rf"^{name}=", template, re.M), name


def test_entrypoint_passes_demo_seed_args_to_the_loader():
    text = (COMPOSE_DIR / "entrypoint.sh").read_text()
    assert "python scripts/demo/load_demo_seed.py ${DEMO_SEED_ARGS:-}" in text
