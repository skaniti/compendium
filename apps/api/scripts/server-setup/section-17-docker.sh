#!/bin/bash
#
# section-17-docker.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 17
# Installs Docker Engine + Compose plugin, adds user to docker group, enables
# auto-start, runs hello-world verification.
#
# Caveat: after `usermod -aG docker $USER`, your active shell still has the OLD
# group membership. You need to log out + log back in (or `newgrp docker`) for
# the new group to apply to non-sudo `docker` commands. The script's verify step
# uses `sudo docker run hello-world` to side-step this so the verification works
# in the same session.
#
# Idempotent: get.docker.com's installer is no-op on already-installed Docker.

set -euo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/17-docker-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-17-docker.sh start: $TS"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

set -x

# --- 17.1: Install Docker Engine ---
echo "--- 17.1: install Docker Engine ---"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sudo sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
else
  echo "(docker already installed; version: $(docker --version))"
fi

# --- 17.2: Install Compose plugin ---
echo "--- 17.2: install docker-compose-plugin ---"
if dpkg -l docker-compose-plugin 2>/dev/null | grep -q '^ii'; then
  echo "(docker-compose-plugin already installed; skipping apt)"
else
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
fi

# --- 17.3: Add user to docker group ---
echo "--- 17.3: usermod -aG docker $USER ---"
if ! groups "$USER" | grep -q "\bdocker\b"; then
  sudo usermod -aG docker "$USER"
  NEEDS_LOGOUT=true
else
  echo "(user already in docker group)"
  NEEDS_LOGOUT=false
fi

# --- 17.4: Auto-start ---
echo "--- 17.4: enable docker auto-start ---"
sudo systemctl enable docker

# --- 17.5: Verify ---
echo "--- 17.5: verify (using sudo so current-shell group membership doesn't matter) ---"
sudo docker run --rm hello-world
docker compose version

# --- Summary ---
set +x
echo ""
echo "=========================================="
echo "DONE: section-17-docker.sh"
echo "=========================================="
echo ""
echo "Docker version:       $(docker --version)"
echo "Compose plugin:       $(docker compose version --short 2>/dev/null || echo '(check via docker compose version)')"
echo "Docker auto-start:    $(systemctl is-enabled docker)"
echo "Docker service:       $(systemctl is-active docker)"
echo ""
if [[ "$NEEDS_LOGOUT" == "true" ]]; then
  echo "*** ACTION REQUIRED: log out + log back in for docker group to apply ***"
  echo "After re-login, you can run 'docker ps' without sudo. Right now, only 'sudo docker'"
  echo "works in this shell. Alternative without logout: 'newgrp docker' in the current shell."
  echo ""
fi
echo "Log: $LOGFILE"
