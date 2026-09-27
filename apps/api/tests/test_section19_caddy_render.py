"""RENDER_ONLY rendering + secret hygiene for section-19-caddy.sh (Task 2a).

The `:8081` (tailnet) Caddy listener stamps `X-Compendium-Ingress` with an
operator secret shared with the API's own env (`SESSION_INGRESS_TRUSTED_VALUE`)
instead of the fixed literal `tailnet`, so a caller reaching that loopback
port cannot forge the tailnet verdict by guessing a constant string. The
script resolves the secret from the environment, falling back to the last
matching line in `$HOME/.secrets`, and must never trace or log the value.

`RENDER_ONLY=1` makes the script print the rendered Caddyfile to stdout and
exit before doing anything privileged (no sudo/apt/systemctl, no log dir
under `$HOME`), which is what makes it possible to drive from pytest without
a real server. These tests run the actual script via `bash` + `subprocess`,
never source it, and use a temp `HOME` so `~/.secrets` is fully test-owned.
"""

import os
import subprocess
from pathlib import Path

import pytest

_SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "scripts"
    / "server-setup"
    / "section-19-caddy.sh"
)

_SECRET = "test-ingress-token-123"
_HEADER_8081 = f"header_up X-Compendium-Ingress {_SECRET}"
_HEADER_8080 = "header_up X-Compendium-Ingress public"


def _run(env, home):
    """Run the script with `bash`, an explicit HOME, and an unchanged PATH."""
    full_env = {"PATH": os.environ.get("PATH", "")}
    full_env.update(env)
    full_env["HOME"] = str(home)
    return subprocess.run(
        ["bash", str(_SCRIPT)],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_render_with_env_secret(tmp_path):
    """(a) env secret set -> renders once into the :8081 block; :8080 unchanged."""
    result = _run({"RENDER_ONLY": "1", "SESSION_INGRESS_TRUSTED_VALUE": _SECRET}, tmp_path)

    assert result.returncode == 0, result.stderr

    matching_lines = [line for line in result.stdout.splitlines() if _HEADER_8081 in line]
    assert len(matching_lines) == 1, result.stdout

    assert _HEADER_8080 in result.stdout

    # The old fixed literal must not survive as a header_up VALUE anywhere.
    for line in result.stdout.splitlines():
        if "header_up X-Compendium-Ingress" in line:
            value = line.split("header_up X-Compendium-Ingress", 1)[1].strip()
            assert value != "tailnet", line


def test_render_with_secrets_file(tmp_path):
    """(b) no env secret; ~/.secrets has other keys plus a quoted match."""
    secrets_file = tmp_path / ".secrets"
    secrets_file.write_text(
        "UNRELATED_KEY=marker-should-not-leak\n"
        f"SESSION_INGRESS_TRUSTED_VALUE='{_SECRET}'\n"
    )
    secrets_file.chmod(0o600)

    result = _run({"RENDER_ONLY": "1"}, tmp_path)

    assert result.returncode == 0, result.stderr
    assert _HEADER_8081 in result.stdout  # unquoted in the rendered output
    assert _HEADER_8080 in result.stdout
    assert "marker-should-not-leak" not in result.stdout
    assert "marker-should-not-leak" not in result.stderr
    assert "'test-ingress-token-123'" not in result.stdout
    assert '"test-ingress-token-123"' not in result.stdout


def test_missing_secret_aborts(tmp_path):
    """(c) no env secret, no ~/.secrets -> exit 1, names the var, no unrelated leak."""
    marker = "unrelated-marker-should-never-appear"
    result = _run({"RENDER_ONLY": "1", "SOME_OTHER_VAR": marker}, tmp_path)

    assert result.returncode == 1
    combined = result.stdout + result.stderr
    assert "SESSION_INGRESS_TRUSTED_VALUE" in combined
    assert marker not in combined


def test_trace_hygiene_and_no_log_dir(tmp_path):
    """(d) the secret never reaches stderr trace; render mode touches nothing under HOME."""
    result = _run({"RENDER_ONLY": "1", "SESSION_INGRESS_TRUSTED_VALUE": _SECRET}, tmp_path)

    assert result.returncode == 0, result.stderr
    assert _SECRET not in result.stderr
    assert not (tmp_path / "server-setup-logs").exists()


def test_syntax_and_upstream_port_override(tmp_path):
    """(e) `bash -n` passes; APP_UPSTREAM_PORT expands into both site blocks."""
    syntax_check = subprocess.run(
        ["bash", "-n", str(_SCRIPT)], capture_output=True, text=True
    )
    assert syntax_check.returncode == 0, syntax_check.stderr

    result = _run(
        {
            "RENDER_ONLY": "1",
            "SESSION_INGRESS_TRUSTED_VALUE": _SECRET,
            "APP_UPSTREAM_PORT": "9999",
        },
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("reverse_proxy 127.0.0.1:9999") == 2
