#!/usr/bin/env bash
# install-owner-gateway.sh -- install the owner Compendium gateway (owner-gateway, 2026-10-10).
#
# Run on the server with sudo, from the checkout:
#   sudo bash apps/api/scripts/server/owner-gateway/install-owner-gateway.sh
#   sudo bash apps/api/scripts/server/owner-gateway/install-owner-gateway.sh register-acmedns <fqdn>
#   bash apps/api/scripts/server/owner-gateway/install-owner-gateway.sh check-env <path>   (no root)
#
# Installs the Caddy binary (with the acmedns module) as /usr/local/bin/caddy-owner,
# the identity helper, the config and both systemd units; enables and starts
# tailnet-whois. caddy-owner is installed but NEVER enabled or started by this
# script (an enabled unit would race `tailscale serve` for :443 on a cold boot);
# a re-run only reloads it if it is already running. It never runs
# `tailscale serve` and never edits tailscaled: the cutover is the private
# operator runbook's. Idempotent: safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN=/usr/local/bin/caddy-owner
ETC=/etc/caddy-owner
OPT=/opt/owner-gateway
UNITS=/etc/systemd/system
CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/acmedns"

say() { printf '[owner-gateway] %s\n' "$*"; }

# Load the five gateway variables from an env file WITHOUT evaluating it (the
# file is also read by systemd's EnvironmentFile, whose parsing differs from
# bash's), then refuse an empty or still-placeholder value. With both tailnet
# addresses empty Caddy adapts to an empty config, validate passes, and
# nothing is served.
check_env() {
  local file="$1" k v
  unset OWNER_HOSTNAME TAILNET_HOSTNAME TAILNET_IPV4 TAILNET_IPV6 ACMEDNS_CREDENTIALS
  [ -r "$file" ] || { echo "cannot read env file $file" >&2; return 1; }
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in
      ''|'#'*) continue ;;
      OWNER_HOSTNAME|TAILNET_HOSTNAME|TAILNET_IPV4|TAILNET_IPV6|ACMEDNS_CREDENTIALS)
        v="${v#"${v%%[![:space:]]*}"}"   # strip leading blanks
        v="${v%"${v##*[![:space:]]}"}"   # strip trailing blanks (incl. CR)
        case "$v" in
          \"*\") [ "${#v}" -ge 2 ] && v="${v:1:${#v}-2}" ;;
          \'*\') [ "${#v}" -ge 2 ] && v="${v:1:${#v}-2}" ;;
        esac
        export "$k=$v" ;;
    esac
  done < "$file"
  if [ -z "${OWNER_HOSTNAME:-}" ] || [ -z "${TAILNET_HOSTNAME:-}" ] ||
     [ -z "${TAILNET_IPV4:-}" ] || [ -z "${TAILNET_IPV6:-}" ] ||
     [ -z "${ACMEDNS_CREDENTIALS:-}" ] ||
     [ "$OWNER_HOSTNAME" = "my.example.test" ] ||
     [ "$TAILNET_HOSTNAME" = "<server>.<tailnet>.ts.net" ] ||
     [ "$TAILNET_IPV4" = "100.64.0.1" ] ||
     [ "$TAILNET_IPV6" = "fd7a:115c:a1e0::1" ]; then
    echo "$file still has an empty or placeholder value for one of OWNER_HOSTNAME, TAILNET_HOSTNAME, TAILNET_IPV4, TAILNET_IPV6, ACMEDNS_CREDENTIALS; fill in the real values (runbook), then re-run" >&2
    return 1
  fi
}

if [ "${1:-}" = "check-env" ]; then
  check_env "${2:?usage: check-env <path>}" || exit 1
  say "env ok"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 2; }

has_modules() {
  "$1" list-modules 2>/dev/null | grep -qx 'dns.providers.acmedns' &&
    "$1" list-modules 2>/dev/null | grep -qx 'tls.get_certificate.tailscale'
}

register_acmedns() {
  local name="${1:?usage: register-acmedns <fqdn>}"
  install -d -m 0750 -o root -g caddy "$ETC"
  python3 - "$name" "$ETC/acmedns.json" <<'PY'
import json, os, sys, urllib.request
name, path = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) else {}
if name in d:
    print(f"{name}: entry exists; CNAME target: {d[name]['fulldomain']}")
    sys.exit(0)
req = urllib.request.Request("https://auth.acme-dns.io/register", method="POST")
acct = json.load(urllib.request.urlopen(req, timeout=30))
acct["server_url"] = "https://auth.acme-dns.io"
d[name] = acct
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print(f"{name}: registered. Set this DNS record (grey cloud):")
print(f"  CNAME  _acme-challenge.{name}  ->  {acct['fulldomain']}")
PY
  chown caddy:caddy "$ETC/acmedns.json"
  chmod 0600 "$ETC/acmedns.json"
}

if [ "${1:-}" = "register-acmedns" ]; then
  register_acmedns "${2:-}"
  exit 0
fi

say "1/5 caddy binary"
if [ -x "$BIN" ] && has_modules "$BIN"; then
  say "    $BIN already has the required modules"
else
  tmp=$(mktemp)
  trap 'rm -f "${tmp:-}"' EXIT
  curl -fsSL --max-time 300 -o "$tmp" "$CADDY_URL"
  chmod 0755 "$tmp"
  has_modules "$tmp" || { echo "downloaded caddy lacks dns.providers.acmedns or tls.get_certificate.tailscale" >&2; rm -f "$tmp"; exit 1; }
  install -m 0755 -o root -g root "$tmp" "$BIN"
  rm -f "$tmp"
  say "    installed $($BIN version | head -1)"
fi

say "2/5 helper and config"
id caddy >/dev/null 2>&1 || { echo "user 'caddy' missing (it comes with the apt caddy package)" >&2; exit 1; }
install -d -m 0755 "$OPT"
install -m 0644 "$HERE/whois_auth.py" "$OPT/whois_auth.py"
install -d -m 0750 -o root -g caddy "$ETC"
install -m 0644 "$HERE/Caddyfile" "$ETC/Caddyfile"
install -m 0644 "$HERE/owner-app.caddy" "$ETC/owner-app.caddy"
if [ ! -f "$ETC/env" ]; then
  install -m 0640 -o root -g caddy "$HERE/env.example" "$ETC/env"
  say "    wrote $ETC/env from env.example: fill in the real values (runbook), then re-run"
  exit 0
fi

say "3/5 systemd units"
install -m 0644 "$HERE/tailnet-whois.service" "$UNITS/tailnet-whois.service"
install -m 0644 "$HERE/caddy-owner.service" "$UNITS/caddy-owner.service"
systemctl daemon-reload

say "4/5 identity helper"
systemctl enable --now tailnet-whois.service
systemctl restart tailnet-whois.service
sleep 1
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null -w '    helper on 127.0.0.1:9180 -> HTTP %{http_code}\n' http://127.0.0.1:9180/whois; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "identity helper did not answer on 127.0.0.1:9180 after 10 tries; see: journalctl -u tailnet-whois" >&2; exit 1; }

say "5/5 gateway config"
check_env "$ETC/env" || exit 1
"$BIN" validate --config "$ETC/Caddyfile" --adapter caddyfile >/dev/null
if systemctl is-active --quiet caddy-owner; then
  systemctl reload caddy-owner
  say "    Caddyfile valid; caddy-owner was running and has been reloaded (re-run after the cutover)"
else
  say "    caddy-owner installed but not enabled; the runbook's cutover enables and starts it"
fi
say "done"
