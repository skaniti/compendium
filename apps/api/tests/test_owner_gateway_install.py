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


def test_install_script_refuses_empty_or_placeholder_env_before_validate():
    text = SCRIPT.read_text()
    guard_at = text.index("OWNER_HOSTNAME")
    assert guard_at < text.index('"$BIN" validate')
    guard = text[guard_at:text.index('"$BIN" validate')]
    for name in ["OWNER_HOSTNAME", "TAILNET_HOSTNAME", "TAILNET_IPV4", "TAILNET_IPV6", "ACMEDNS_CREDENTIALS"]:
        assert name in guard, name
    for placeholder in ["my.example.test", "<server>.<tailnet>.ts.net", "100.64.0.1", "fd7a:115c:a1e0::1"]:
        assert placeholder in guard, placeholder
    assert "exit 1" in guard


def test_whois_unit_is_sandboxed_and_loopback_only():
    u = _unit("tailnet-whois.service")
    for line in SANDBOX + ["DynamicUser=yes", "Restart=always", "ReadWritePaths=/run/tailscale"]:
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
        "ReadWritePaths=/var/lib/caddy-owner /run/tailscale",
        "Wants=tailnet-whois.service",
    ]:
        assert line in u, line
    assert "/usr/local/bin/caddy-owner run --config /etc/caddy-owner/Caddyfile --adapter caddyfile" in u
