#!/bin/bash
#
# section-19-caddy.sh
#
# Plan: the 2026-05-03 laptop-server-setup plan (private), section 19
# Amended: the 2026-09-09 session-expiry-tuning plan (private), spec D6
#          (Task 3) -- split the single shared listener into two, one per
#          ingress edge, so the app can trust which edge a request arrived on.
#
# Installs Caddy (official apt repo), writes /etc/caddy/Caddyfile with TWO
# loopback listeners -- :8080 for Cloudflare Tunnel (public) and :8081 for
# `tailscale serve` (tailnet-only) -- both proxying to the app upstream, then
# repoints cloudflared -> :8080 (unchanged) and `tailscale serve` -> :8081
# (changed from :8080). Idempotent: safe to re-run.
#
# WHY two listeners instead of one shared ':8080' block (pre-2026-09-10): the
# API derives a session's trust level (remembered/long-lived vs default) from
# one request header, X-Compendium-Ingress. A header is only trustworthy as a
# same-request signal if nothing between the client and the app can forge it.
# With one shared listener and no Host matching, a public caller's own
# X-Compendium-Ingress (or Tailscale-User-*) header would reach the app
# unmodified -- forgeable by construction. Splitting into two loopback
# listeners fixes this: nothing but tailscaled can reach :8081 (loopback-
# bound, Tailscale Funnel never enabled), and Caddy's `header_up FIELD VALUE`
# REPLACES (not appends to) any client-supplied value of FIELD before the
# reverse proxy forwards the request, so each listener stamps its own verdict
# on every single request regardless of what the client sent. `header_up
# -FIELD` deletes a header outright -- used on :8080 to strip Tailscale
# identity headers so a public caller can never inject them, even though
# cloudflared itself would never send them.
#
# Order is deliberate: Caddy comes up + BOTH listeners are verified BEFORE
# the ingress repointing, so the public + tailnet paths never route to a dead
# or half-configured Caddy mid-script.
#
# Env override: APP_UPSTREAM_PORT (default 8051, Dash today). Once apps/web
# fronts the host (batch 06), set this to that port -- see the batch-06 note
# in infra-runbook.md alongside this plan.
#
# Rollback -- full bypass (uninstall Caddy from the path entirely):
#   sudo sed -i 's|service: http://localhost:8080|service: http://localhost:8051|' /etc/cloudflared/config.yml
#   sudo systemctl restart cloudflared
#   sudo tailscale serve reset
#   sudo tailscale serve --bg --https=443 http://127.0.0.1:8051
#   sudo systemctl stop caddy
# Rollback -- keep Caddy, drop back to one shared listener: see
#   infra-runbook.md (the 2026-09-09 session-expiry-tuning plan, private).

set -euxo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS=$(date +%Y%m%d-%H%M%S)
LOG="$LOGDIR/19-caddy-$TS.log"
exec > >(tee -a "$LOG") 2>&1

echo "section-19-caddy.sh start: $TS"

# Upstream the app lives on. Dash today (8051); apps/web once batch 06 flips
# the host -- bump via env (APP_UPSTREAM_PORT=<port> ./section-19-caddy.sh)
# rather than editing this file, so the change is visible in the invocation.
APP_UPSTREAM_PORT="${APP_UPSTREAM_PORT:-8051}"
echo "APP_UPSTREAM_PORT=$APP_UPSTREAM_PORT"

# Public hostname used only by Step 8's end-to-end curl (same env-override
# pattern as section-16's PUBLIC_HOSTNAME; unlike section-16 this one has a
# safe placeholder default since Step 8 is a verification convenience, not
# provisioning -- override via PUBLIC_HOSTNAME=<your-domain> if it differs).
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-compendium.example.com}"
echo "PUBLIC_HOSTNAME=$PUBLIC_HOSTNAME"

# === Step 1: install Caddy via official apt repo ===
if command -v caddy >/dev/null; then
  echo "Caddy already installed: $(caddy version | head -1)"
else
  set +x  # quiet the apt-key dance trace
  sudo apt-get update
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
  set -x
  echo "Caddy installed: $(caddy version | head -1)"
fi

# === Step 2: write /etc/caddy/Caddyfile ===
# Unquoted heredoc delimiter (deliberate, unlike a static config): lets
# $APP_UPSTREAM_PORT expand into both site blocks below.
sudo tee /etc/caddy/Caddyfile <<CADDYFILE >/dev/null
# /etc/caddy/Caddyfile
# Two loopback listeners, split by ingress edge (session-expiry-tuning D6).
#
# :8080 -- Cloudflare Tunnel ingress (public internet, via cloudflared).
#          Strips any client-supplied Tailscale-User-* headers and stamps
#          X-Compendium-Ingress: public.
# :8081 -- tailscale serve ingress (tailnet-only; Funnel is never enabled,
#          so nothing but tailscaled can reach this port). Stamps
#          X-Compendium-Ingress: tailnet.
#
# 'header_up FIELD VALUE' REPLACES any client-supplied value of FIELD before
# the app sees it (it does not append); 'header_up -FIELD' deletes FIELD
# outright. That is what makes X-Compendium-Ingress trustworthy: the app
# only ever sees Caddy's verdict for the listener the request actually came
# through, never a value the client sent.
#
# Both listeners are loopback-bound ('bind 127.0.0.1') -- defense-in-depth in
# case ufw is later misconfigured. Both ingress edges terminate TLS upstream
# (cloudflared / tailscaled); Caddy does plain HTTP routing + header rewrite.
#
# Upstream is APP_UPSTREAM_PORT (Dash today; apps/web once batch 06 flips
# the host) -- one value, both listeners, via env at script invocation.

(access_log) {
	log {
		output stdout
		format console
		level INFO
	}
}

# Cloudflare Tunnel ingress (public)
:8080 {
	bind 127.0.0.1
	import access_log

	reverse_proxy 127.0.0.1:$APP_UPSTREAM_PORT {
		header_up X-Compendium-Ingress public
		header_up -Tailscale-User-Login
		header_up -Tailscale-User-Name
		header_up -Tailscale-User-Profile-Pic
	}
}

# tailscale serve ingress (tailnet only)
:8081 {
	bind 127.0.0.1
	import access_log

	reverse_proxy 127.0.0.1:$APP_UPSTREAM_PORT {
		header_up X-Compendium-Ingress tailnet
	}
}
CADDYFILE

# === Step 3: validate config (fail fast on syntax errors) ===
sudo caddy validate --config /etc/caddy/Caddyfile

# === Step 4: enable + (re)start caddy ===
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 2

# === Step 5: verify Caddy responds on BOTH listeners BEFORE repointing ingress ===
echo ""
echo "--- pre-repoint: verify Caddy on :8080 and :8081 ---"
CADDY_HTTP_8080=$(curl -sI -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:8080/ || echo "FAIL")
CADDY_HTTP_8081=$(curl -sI -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:8081/ || echo "FAIL")
echo "Caddy :8080 (public block)  -> HTTP $CADDY_HTTP_8080 (expect 200 or 302; anything else aborts)"
echo "Caddy :8081 (tailnet block) -> HTTP $CADDY_HTTP_8081 (expect 200 or 302; anything else aborts)"
if [[ "$CADDY_HTTP_8080" != "200" && "$CADDY_HTTP_8080" != "302" ]] || \
   [[ "$CADDY_HTTP_8081" != "200" && "$CADDY_HTTP_8081" != "302" ]]; then
  echo "ERROR: Caddy not responding correctly on one or both listeners; aborting before repointing ingress."
  exit 1
fi

# === Step 6: repoint cloudflared upstream -> 8080 (unchanged: still the public listener) ===
if [[ -f /etc/cloudflared/config.yml ]]; then
  # Match both 8051 (post-section-18.4) and legacy 8052 (pre-section-18.4)
  sudo sed -i 's|service: http://localhost:805[12]|service: http://localhost:8080|' /etc/cloudflared/config.yml
  sudo systemctl restart cloudflared
  echo "cloudflared repointed to localhost:8080"
else
  echo "WARNING: /etc/cloudflared/config.yml not found; skipping cloudflared repoint."
fi

# === Step 7: repoint tailscale serve -> 8081 (changed 2026-09-10, was 8080) ===
# Cloudflare Tunnel and tailscale serve used to target the same :8080 listener,
# so the app could not tell which edge a request came from. tailscale serve
# now targets the tailnet-only :8081 listener; cloudflared keeps :8080 (Step 6).
sudo tailscale serve reset 2>/dev/null || true
sudo tailscale serve --bg --https=443 http://127.0.0.1:8081
echo "tailscale serve repointed to 127.0.0.1:8081"

# === Step 8: final end-to-end verification ===
# Caveat: status code alone isn't enough -- Caddy can return empty 200 for a
# host that doesn't match any server block. Also check body size to confirm
# the response is real app content (>1000 bytes), not an empty NOP-200.
echo ""
echo "=== final verification ==="
sleep 2
LOOPBACK_8080_BYTES=$(curl -s -m 5 http://127.0.0.1:8080/ | wc -c)
LOOPBACK_8081_BYTES=$(curl -s -m 5 http://127.0.0.1:8081/ | wc -c)
# No `|| echo "0"` here (removed 2026-09-10): under `pipefail`, a failed curl
# still gives wc -c an empty stdin (which itself prints "0"), so the `||`
# fires too and appends a SECOND "0" line -- the resulting two-line value
# breaks the `-lt` integer comparison below. wc's own "0" already covers the
# failure case.
PUBLIC_BYTES=$(curl -s -m 10 "https://$PUBLIC_HOSTNAME/" | wc -c) || PUBLIC_BYTES=0
echo "loopback Caddy :8080 (public block)  -> $LOOPBACK_8080_BYTES bytes (expect ~50000+ for app page)"
echo "loopback Caddy :8081 (tailnet block) -> $LOOPBACK_8081_BYTES bytes (expect ~50000+ for app page)"
echo "public via CF ($PUBLIC_HOSTNAME) -> $PUBLIC_BYTES bytes (expect ~50000+ for app page)"
if [[ "$LOOPBACK_8080_BYTES" -lt 1000 || "$LOOPBACK_8081_BYTES" -lt 1000 || "$PUBLIC_BYTES" -lt 1000 ]]; then
  echo "WARNING: one or more responses look empty -- check Caddyfile site blocks"
fi
echo ""
echo "Note: this script can only confirm bytes flow through each listener, not"
echo "which X-Compendium-Ingress value the app received (the app doesn't echo"
echo "it back). infra-runbook.md's verify section covers that end-to-end,"
echo "including the forged-header check."
echo ""
echo "tailscale serve status:"
sudo tailscale serve status

echo ""
echo "Recent Caddy log entries:"
sudo journalctl -u caddy -n 10 --no-pager

echo ""
echo "=== rollback commands (if needed) ==="
echo "  Full bypass (drop Caddy out of the path entirely):"
echo "    sudo sed -i 's|service: http://localhost:8080|service: http://localhost:8051|' /etc/cloudflared/config.yml"
echo "    sudo systemctl restart cloudflared"
echo "    sudo tailscale serve reset"
echo "    sudo tailscale serve --bg --https=443 http://127.0.0.1:8051"
echo "    sudo systemctl stop caddy"
echo "  Keep Caddy, drop back to one shared listener: see infra-runbook.md"
echo "  (the 2026-09-09 session-expiry-tuning plan, private)."

echo ""
echo "DONE: section-19-caddy.sh"
