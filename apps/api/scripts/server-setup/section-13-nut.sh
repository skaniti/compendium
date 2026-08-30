#!/bin/bash
#
# section-13-nut.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 13
# Automates 13.1 through 13.6 (NUT install + config + service start + verify)
# and 13.8 (ntfy.sh notify script + upsmon.conf hook).
#
# NOT automated (must be done manually after this script):
#   13.7 -- physical pull-plug test (unplug UPS from wall, watch shutdown signal fire)
#   ntfy phone subscription (cat ~/.nut-ntfy-topic for your topic, subscribe in ntfy app)
#
# Idempotent: re-runnable. Reuses existing ntfy topic if ~/.nut-ntfy-topic exists.
# Regenerates NUT passwords every run (no user-side state depends on them).
#
# Run from server as user with sudo. Writes log to ~/server-setup-logs/13-nut-<timestamp>.log.

set -euo pipefail

# --- Logging setup ---
LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/13-nut-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-13-nut.sh  start: $TS"
echo "host:   $(hostname)"
echo "user:   $USER"
echo "log:    $LOGFILE"
echo "=========================================="

set -x

# --- 13.1: Detect UPS via lsusb ---
echo "--- 13.1: detect UPS ---"
if ! lsusb | grep -iE "cyber|apc|powerware|tripp|eaton" ; then
  set +x
  echo ""
  echo "ERROR: No recognized UPS make found via lsusb."
  echo "Re-seat the USB cable and re-run. Full lsusb output for reference:"
  lsusb
  exit 1
fi

# --- 13.2: Install NUT ---
echo "--- 13.2: install nut ---"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nut

# Re-fire udev rules so the NUT-shipped USB permission rules apply to any UPS
# that was already plugged in BEFORE this install. Without this, the driver
# process (running as user `nut`) gets "insufficient permissions" trying to
# open the USB device, and the driver instance fails to start in a loop.
echo "--- 13.2 (cont): re-trigger udev for already-attached USB devices ---"
sudo udevadm trigger --action=add --subsystem-match=usb
sleep 2

# --- Secret generation (set -x off; values never echoed to log) ---
set +x
echo "--- generating NUT passwords + ntfy topic (set -x off) ---"
ADMIN_PW="$(openssl rand -hex 16)"
UPSMON_PW="$(openssl rand -hex 16)"

if [[ -f "$HOME/.nut-ntfy-topic" ]]; then
  NTFY_TOPIC="$(cat "$HOME/.nut-ntfy-topic")"
  echo "(reusing existing ntfy topic from ~/.nut-ntfy-topic)"
else
  NTFY_TOPIC="compendium-server-$(openssl rand -hex 6)"
  echo "$NTFY_TOPIC" > "$HOME/.nut-ntfy-topic"
  chmod 600 "$HOME/.nut-ntfy-topic"
  echo "(generated new ntfy topic; saved to ~/.nut-ntfy-topic mode 600)"
fi
set -x

# --- 13.3: Write the five NUT config files ---
echo "--- 13.3: write /etc/nut/ config files ---"

sudo tee /etc/nut/nut.conf > /dev/null <<'EOF'
MODE=standalone
EOF

sudo tee /etc/nut/ups.conf > /dev/null <<'EOF'
[homeups]
  driver = usbhid-ups
  port = auto
  desc = "Home server UPS"
EOF

sudo tee /etc/nut/upsd.conf > /dev/null <<'EOF'
LISTEN 127.0.0.1 3493
EOF

# heredoc unquoted so $ADMIN_PW / $UPSMON_PW expand
sudo tee /etc/nut/upsd.users > /dev/null <<EOF
[admin]
  password = $ADMIN_PW
  actions = SET
  instcmds = ALL

[upsmon]
  password = $UPSMON_PW
  upsmon master
EOF

sudo tee /etc/nut/upsmon.conf > /dev/null <<EOF
MONITOR homeups@localhost 1 upsmon $UPSMON_PW master
SHUTDOWNCMD "/sbin/shutdown -h +0"
NOTIFYCMD /usr/local/bin/nut-notify.sh
POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 15
DEADTIME 15
NOTIFYFLAG ONBATT      EXEC+SYSLOG
NOTIFYFLAG ONLINE      EXEC+SYSLOG
NOTIFYFLAG LOWBATT     EXEC+SYSLOG
NOTIFYFLAG SHUTDOWN    EXEC+SYSLOG
NOTIFYFLAG COMMOK      EXEC+SYSLOG
NOTIFYFLAG COMMBAD     EXEC+SYSLOG
NOTIFYFLAG REPLBATT    EXEC+SYSLOG
NOTIFYMSG ONBATT       "UPS on battery -- power outage detected"
NOTIFYMSG ONLINE       "UPS back on AC -- power restored"
NOTIFYMSG LOWBATT      "UPS battery low -- shutdown imminent"
NOTIFYMSG SHUTDOWN     "UPS exhausted -- shutting down now"
NOTIFYMSG COMMOK       "UPS communication restored"
NOTIFYMSG COMMBAD      "UPS communication lost"
NOTIFYMSG REPLBATT     "UPS battery needs replacement"
EOF

# --- 13.4: Permissions ---
# Explicit file list (not *.conf glob) because upsd.users has no .conf extension
# and a glob misses it -- leaving NUT passwords in a world-readable file.
echo "--- 13.4: chown/chmod NUT config files ---"
NUT_FILES=(/etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf /etc/nut/upsd.users /etc/nut/upsmon.conf)
sudo chown root:nut "${NUT_FILES[@]}"
sudo chmod 640 "${NUT_FILES[@]}"

# --- 13.8: ntfy notify script ---
echo "--- 13.8: write /usr/local/bin/nut-notify.sh ---"
sudo tee /usr/local/bin/nut-notify.sh > /dev/null <<EOF
#!/bin/bash
# Posts NUT NOTIFYMSG content to ntfy.sh.
# Topic name baked in at install time; treat as a secret.
TOPIC="$NTFY_TOPIC"
MSG="\${1:-NUT event}"
HOST="\$(hostname)"
curl -fsS -d "[\${HOST}] \${MSG}" "https://ntfy.sh/\${TOPIC}" >/dev/null
EOF
sudo chmod +x /usr/local/bin/nut-notify.sh

# --- 13.5: Enable + start services ---
# Ubuntu 24.04's NUT 2.8.x uses a different systemd unit model than older docs:
#   - nut.target          = umbrella (auto-enabled at install; idempotent here)
#   - nut-driver-enumerator.service = watches ups.conf, spawns nut-driver@<name>
#   - nut-driver@homeups.service    = our specific UPS driver instance
#   - nut-server.service  = upsd (the network daemon)
#   - nut-monitor.service = upsmon (shutdown-signal handler)
echo "--- 13.5: enable + (re)start NUT services ---"
sudo systemctl enable nut.target
sudo systemctl restart nut-driver-enumerator
sleep 4
sudo systemctl restart nut-server
sleep 2
sudo systemctl restart nut-monitor

# --- 13.6: Verify upsd responsive ---
echo "--- 13.6: verify upsc homeups@localhost ---"
sleep 3
upsc homeups@localhost

# --- Summary ---
set +x
echo ""
echo "=========================================="
echo "DONE: section-13-nut.sh"
echo "=========================================="
echo ""
echo "Service status:"
echo "  nut.target:         $(systemctl is-active nut.target)"
echo "  nut-server:         $(systemctl is-active nut-server)"
echo "  nut-monitor:        $(systemctl is-active nut-monitor)"
echo "  nut-driver@homeups: $(systemctl is-active nut-driver@homeups || echo 'inactive (check journalctl -u nut-driver@homeups)')"
echo ""
echo "Your ntfy.sh topic has been saved (your-eyes-only):"
echo "  cat ~/.nut-ntfy-topic"
echo "(file mode 600, owner-readable only -- this script does not echo the topic to the log)"
echo ""
echo "Next manual steps (covers 13.7 + ntfy phone subscription):"
echo "  1. cat ~/.nut-ntfy-topic         # read your topic"
echo "  2. Install the ntfy app on phone (ntfy.sh, iOS or Android). Subscribe to your topic."
echo "  3. Test the channel from this server:"
echo "       curl -d \"hello from \$(hostname)\" \"https://ntfy.sh/\$(cat ~/.nut-ntfy-topic)\""
echo "     Expect a push notification on phone within ~5 sec."
echo "  4. (Plan 13.7 physical test) Pull UPS plug from wall briefly."
echo "     Expect 'UPS on battery -- power outage detected' push within ~5-10 sec."
echo "     Plug back in. Expect 'UPS back on AC -- power restored' push."
echo "  5. (Optional) After memorizing the topic, you can rm ~/.nut-ntfy-topic to reduce exposure."
echo ""
echo "Troubleshooting:"
echo "  - If upsc returns nothing or upsd won't start: sudo journalctl -u nut-driver -n 50"
echo "  - If 'usbhid-ups' wasn't right for your UPS: see NUT HCL at https://networkupstools.org/stable-hcl.html"
echo "  - If notifications don't fire: sudo journalctl -u nut-monitor -f, then trigger an event."
echo ""
echo "Log file: $LOGFILE"
echo "=========================================="
