"""Owner gateway units and install script (owner-gateway, Task 3)."""
import subprocess
from pathlib import Path

GW = Path(__file__).resolve().parents[1] / "scripts/server/owner-gateway"
SCRIPT = GW / "install-owner-gateway.sh"

SANDBOX = ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes"]


def _unit(name):
    return (GW / name).read_text()


def test_install_script_parses():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_install_script_is_executable_and_strict():
    text = SCRIPT.read_text()
    assert SCRIPT.stat().st_mode & 0o111
    assert "set -euo pipefail" in text


def test_install_script_never_touches_serve_tailscaled_or_starts_the_gateway():
    code = "\n".join(l for l in SCRIPT.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert "tailscale serve" not in code
    assert "/etc/default/tailscaled" not in code
    assert "start caddy-owner" not in code and "enable --now caddy-owner" not in code
    assert "restart caddy-owner" not in code


def test_install_script_verifies_the_required_caddy_modules():
    text = SCRIPT.read_text()
    assert "dns.providers.acmedns" in text and "tls.get_certificate.tailscale" in text


def _check_env(tmp_path, text):
    env = tmp_path / "env"
    env.write_text(text)
    return subprocess.run(["bash", str(SCRIPT), "check-env", str(env)], capture_output=True, text=True)


GOOD_ENV = (
    "OWNER_HOSTNAME=my.owner.test\n# comment\n\n"
    "TAILNET_HOSTNAME=host.net.ts.net\nTAILNET_IPV4=100.64.0.7\n"
    "TAILNET_IPV6=fd7a:115c:a1e0::7\nACMEDNS_CREDENTIALS=/etc/caddy-owner/acmedns.json\n"
)


def test_check_env_rejects_the_example_placeholders(tmp_path):
    r = _check_env(tmp_path, (GW / "env.example").read_text())
    assert r.returncode != 0
    assert "placeholder" in r.stderr + r.stdout
    assert "No such file" not in r.stderr  # the env is read, never evaluated by bash


def test_check_env_rejects_an_empty_value(tmp_path):
    r = _check_env(tmp_path, GOOD_ENV.replace("TAILNET_IPV4=100.64.0.7", "TAILNET_IPV4="))
    assert r.returncode != 0
    assert "empty or placeholder" in r.stderr + r.stdout


def test_check_env_accepts_a_valid_env_without_root(tmp_path):
    r = _check_env(tmp_path, GOOD_ENV)
    assert r.returncode == 0, r.stderr


def test_install_script_enables_only_after_validate():
    code = SCRIPT.read_text()
    assert code.index('"$BIN" validate') < code.index("systemctl enable caddy-owner.service")


def test_whois_unit_is_sandboxed_and_loopback_only():
    u = _unit("tailnet-whois.service")
    for line in SANDBOX + ["DynamicUser=yes", "Restart=always", "RestartSec=3", "StartLimitIntervalSec=0", "ReadWritePaths=-/run/tailscale"]:
        assert line in u, line
    assert "--host 127.0.0.1 --port 9180" in u
    assert "/opt/owner-gateway/whois_auth.py" in u


def test_caddy_unit_runs_unprivileged_with_only_the_bind_capability():
    u = _unit("caddy-owner.service")
    for line in SANDBOX + [
        "User=caddy",
        "AmbientCapabilities=CAP_NET_BIND_SERVICE",
        "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
        "EnvironmentFile=/etc/caddy-owner/env",
        "StateDirectory=caddy-owner",
        "RuntimeDirectory=caddy-owner",
        "RuntimeDirectoryMode=0700",
        "ReadWritePaths=/var/lib/caddy-owner -/run/tailscale",
        "RestartSec=3",
        "StartLimitIntervalSec=0",
        "Wants=tailscaled.service",
        "PrivateDevices=yes",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        "Wants=tailnet-whois.service",
    ]:
        assert line in u, line
    assert "/usr/local/bin/caddy-owner run --config /etc/caddy-owner/Caddyfile --adapter caddyfile" in u
