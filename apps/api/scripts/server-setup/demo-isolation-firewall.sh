#!/bin/bash
#
# demo-isolation-firewall.sh -- keep the public demo stack's containers away
# from the tailnet, the LAN and the host (tailnet-owner-demo-split,
# 2026-10-06). Deliberately NOT named section-NN: those numbers belong to the
# laptop-server-setup plan.
#
# What it does (idempotent; re-runs replace the marked blocks):
#   /etc/ufw/after.rules  -- appends its own *filter block that fills
#     DOCKER-USER: traffic FROM the demo subnet to the tailnet (100.64/10),
#     the LAN / private ranges and link-local is dropped; traffic inside the
#     demo subnet and replies are returned to Docker's own rules; internet
#     egress (OpenAI, the first-boot model download) is untouched.
#   /etc/ufw/before.rules -- inserts one ufw-before-input rule dropping NEW
#     connections arriving on the demo bridge: the host's own listeners
#     (tailscale serve 443/8443, ssh) become unreachable from demo containers.
# ufw loads both files at boot, before Docker starts, so the rules survive
# reboots and Docker restarts. Every edit backs the file up first.
#
# Run on the server:   bash demo-isolation-firewall.sh
# Preview only:        RENDER_ONLY=1 bash demo-isolation-firewall.sh
# Rollback:            restore the printed .bak-<ts> files, then: sudo ufw reload
#
# Test-only knobs: UFW_DIR (default /etc/ufw), SUDO (default sudo; empty for
# none), NO_HOST=1 (skip interface checks, ufw reload and verification).

set -euo pipefail

DEMO_SUBNET="${DEMO_SUBNET:-172.31.250.0/24}"
DEMO_BRIDGE="${DEMO_BRIDGE:-br-compdemo}"
UFW_DIR="${UFW_DIR:-/etc/ufw}"
SUDO="${SUDO-sudo}"
# Destinations the demo subnet may not reach: tailnet, private ranges, link-local.
BLOCKED_NETS="100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16" # scan-ok: test-ip
BEGIN="# BEGIN compendium-demo-isolation"
END="# END compendium-demo-isolation"
COMMIT_MARK="# don't delete the 'COMMIT' line"

render_after() {
    cat <<EOF
$BEGIN
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -s $DEMO_SUBNET -d $DEMO_SUBNET -j RETURN
-A DOCKER-USER -s $DEMO_SUBNET -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
$(for net in $BLOCKED_NETS; do echo "-A DOCKER-USER -s $DEMO_SUBNET -d $net -j DROP"; done)
-A DOCKER-USER -j RETURN
COMMIT
$END
EOF
}

render_before() {
    cat <<EOF
$BEGIN
-A ufw-before-input -i $DEMO_BRIDGE -m conntrack --ctstate NEW -j DROP
$END
EOF
}

if [ -n "${RENDER_ONLY:-}" ]; then
    echo "== $UFW_DIR/after.rules (appended as its own *filter block) =="
    render_after
    echo "== $UFW_DIR/before.rules (inserted before the *filter COMMIT marker) =="
    render_before
    exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
exec > >(tee -a "$LOGDIR/demo-isolation-firewall-$TS.log") 2>&1
echo "=== demo-isolation-firewall.sh start: $TS (subnet $DEMO_SUBNET, bridge $DEMO_BRIDGE) ==="

BEFORE_RULES="$UFW_DIR/before.rules"
AFTER_RULES="$UFW_DIR/after.rules"

if ! $SUDO grep -q "^$COMMIT_MARK" "$BEFORE_RULES"; then
    echo "ERROR: $BEFORE_RULES has no \"$COMMIT_MARK\" line; refusing to edit it."
    exit 1
fi

if [ -z "${NO_HOST:-}" ]; then
    if ! ip link show "$DEMO_BRIDGE" >/dev/null 2>&1; then
        echo "NOTE: $DEMO_BRIDGE does not exist yet (demo stack not up); the rules still apply once it does."
    elif ip -6 addr show dev "$DEMO_BRIDGE" scope global 2>/dev/null | grep -q inet6; then
        echo "ERROR: $DEMO_BRIDGE has a global IPv6 address; these rules are IPv4-only. Add before6/after6 rules first."
        exit 1
    fi
fi

for f in "$BEFORE_RULES" "$AFTER_RULES"; do
    $SUDO cp "$f" "$f.bak-$TS"
    echo "backup: $f.bak-$TS"
    $SUDO sed -i "/^$BEGIN\$/,/^$END\$/d" "$f"
done

tmp="$(mktemp)"
$SUDO cat "$BEFORE_RULES" | BLOCK="$(render_before)" MARK="$COMMIT_MARK" awk '
    !done && index($0, ENVIRON["MARK"]) == 1 { print ENVIRON["BLOCK"]; done = 1 }
    { print }
' > "$tmp"
$SUDO cp "$tmp" "$BEFORE_RULES"
rm -f "$tmp"
render_after | $SUDO tee -a "$AFTER_RULES" >/dev/null
echo "rule files updated"

if [ -z "${NO_HOST:-}" ]; then
    $SUDO ufw reload
    echo "--- DOCKER-USER ---"
    $SUDO iptables -S DOCKER-USER
    echo "--- ufw-before-input (demo bridge) ---"
    $SUDO iptables -S ufw-before-input | grep -- "-i $DEMO_BRIDGE" || { echo "ERROR: input rule missing after reload"; exit 1; }
fi

echo ""
echo "Rollback: $SUDO cp $BEFORE_RULES.bak-$TS $BEFORE_RULES && $SUDO cp $AFTER_RULES.bak-$TS $AFTER_RULES && $SUDO ufw reload"
echo "=== DONE: demo-isolation-firewall.sh ==="
