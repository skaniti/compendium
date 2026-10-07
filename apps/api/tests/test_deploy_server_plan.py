"""deploy_server.sh stack selection (tailnet-owner-demo-split). PLAN_ONLY=1
prints the resolved plan and exits before any docker/log/file work."""
import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/server/deploy_server.sh"


def _plan(*args, env=None, timeout=20):
    full_env = {"PATH": os.environ["PATH"], "HOME": "/nonexistent-home", "PLAN_ONLY": "1",
                **(env or {})}
    r = subprocess.run(["bash", str(SCRIPT), *args], env=full_env,
                       stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    out = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    return r.returncode, out


def test_script_parses():
    assert subprocess.run(["bash", "-n", str(SCRIPT)]).returncode == 0


def test_default_stack_is_owner():
    rc, out = _plan()
    assert rc == 0
    assert out["stack"] == "owner"
    assert out["compose_file"].endswith("docker/docker-compose.server.yml")
    assert out["env_file"] == "/nonexistent-home/apps/compendium/.env"
    assert out["secrets_file"] == "/nonexistent-home/.secrets"
    assert out["api_host_port"] == "8001"
    assert out["project"] == "docker"


def test_demo_stack_uses_its_own_file_env_and_port():
    rc, out = _plan("--stack", "demo")
    assert rc == 0
    assert out["compose_file"].endswith("docker/docker-compose.demo.yml")
    assert out["env_file"] == "/nonexistent-home/apps/compendium/.env.demo"
    assert out["api_host_port"] == "8002"
    assert out["project"] == "compendium-demo"


def test_demo_never_uses_a_secrets_file_even_when_one_is_exported():
    rc, out = _plan("--stack=demo", env={"SECRETS_FILE": "/home/someone/.secrets"})
    assert rc == 0 and out["secrets_file"] == "<none>"


def test_unknown_stack_is_rejected():
    rc, _ = _plan("--stack", "prod")
    assert rc == 2


def test_seed_never_applies_without_a_terminal():
    _, out = _plan()
    assert out["seed_apply"] == "no"


def test_seed_apply_env_wins():
    _, out = _plan(env={"SEED_APPLY": "yes"})
    assert out["seed_apply"] == "yes"


def test_demo_and_skip_seed_have_no_seed_step():
    assert _plan("--stack", "demo")[1]["seed_apply"] == "skip"
    assert _plan("--skip-seed")[1]["seed_apply"] == "skip"


def test_stack_without_a_value_exits_2_instead_of_hanging():
    assert _plan("--stack", timeout=5)[0] == 2
    assert _plan("--stack=", timeout=5)[0] == 2


def test_web_build_defaults_to_yes_on_owner():
    assert _plan()[1]["web_build"] == "yes"


def test_no_web_build_skips_the_web_image_build_on_owner():
    assert _plan(env={"NO_WEB_BUILD": "1"})[1]["web_build"] == "no"


def test_no_web_build_has_no_effect_on_demo():
    assert _plan("--stack", "demo", env={"NO_WEB_BUILD": "1"})[1]["web_build"] == "n/a"
