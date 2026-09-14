#!/bin/bash
#
# claude-ro-access.sh -- provision a structurally read-only server channel
# for Claude Code (CC) on compendium-server.
#
# Plan: the 2026-06-09 server-ro-access-local-mirror-backups plan (private),
#       spec.md Part 1. Deliberately NOT named section-NN: those numbers map to
#       the laptop-server-setup plan; this script belongs to a different plan.
#
# What it creates (idempotent; re-runs are safe and ROTATE the PG password):
#   1. Unix user `claude-ro`: key-only login, no sudo, NOT in the docker group
#      (docker group == root-equivalent); systemd-journal + adm for log reads.
#   2. PG role `claude_ro`: LOGIN, SELECT-only grants, BYPASSRLS, enforced
#      read-only (default_transaction_read_only=on), 30s statement_timeout,
#      CONNECTION LIMIT 3. BYPASSRLS is deliberate: the app's per-user RLS
#      policies (migrations 003/027/029/031) would otherwise filter rows for
#      any non-owner role, making SELECTs misleading and pg_dump SILENTLY
#      PARTIAL. Read-only-ness is enforced by the grant + transaction layers,
#      not by RLS.
#   3. Audit trail: every SSH command appended to /var/log/claude-ro-audit.log
#      via a forced-command wrapper. Log is root-owned, group-append, chattr +a
#      where supported -- claude-ro can add lines, not rewrite history.
#   4. sshd Match block: TCP forwarding allowed ONLY to 127.0.0.1:5432 (the
#      compose-mapped Postgres loopback); no agent/X11 forwarding, no TTY.
#
# Usage (from the laptop, Git Bash):
#   scp scripts/server-setup/claude-ro-access.sh compendium-server:/tmp/
#   ssh -t compendium-server 'bash /tmp/claude-ro-access.sh "ssh-ed25519 AAAA... claude-ro@new-laptop-2026-06-09"'
#   (-t so sudo can prompt; run from a normal terminal if the prompt misbehaves)
#
# After it passes self-tests:
#   - transfer ~/claude-ro-pg-password to the laptop's pgpass, then delete it
#   - CC verifies via the `compendium-ro` alias (read-only side already configured)

set -euo pipefail

PUBKEY="${1:-}"
if [[ ! "$PUBKEY" =~ ^ssh-(ed25519|rsa)[[:space:]] ]]; then
  echo "ERROR: pass CC's PUBLIC key line as the single (quoted) argument." >&2
  exit 1
fi

RO_USER="claude-ro"
PG_CONTAINER="compendium-postgres"
PG_DB="traversal_discovery"
AUDIT_LOG="/var/log/claude-ro-audit.log"
WRAPPER="/usr/local/bin/claude-ro-shell"
SSHD_DROPIN="/etc/ssh/sshd_config.d/60-claude-ro.conf"
PW_FILE="$HOME/claude-ro-pg-password"

echo "== 1. unix user $RO_USER =="
if ! id "$RO_USER" &>/dev/null; then
  sudo adduser --disabled-password --gecos "Claude Code read-only" "$RO_USER"
fi
sudo usermod -aG systemd-journal,adm "$RO_USER"
# Defensive: strip privilege-equivalent groups if ever present.
for g in docker sudo wheel; do
  if id -nG "$RO_USER" | tr ' ' '\n' | grep -qx "$g"; then
    sudo gpasswd -d "$RO_USER" "$g"
  fi
done

echo "== 2. postgres role claude_ro (password rotates on every run) =="
PW="$(openssl rand -hex 24)"
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U tbd -d "$PG_DB" -v pw="$PW" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_ro') THEN
    CREATE ROLE claude_ro;
  END IF;
END $$;
ALTER ROLE claude_ro WITH LOGIN BYPASSRLS CONNECTION LIMIT 3 PASSWORD :'pw';
ALTER ROLE claude_ro SET default_transaction_read_only = on;
ALTER ROLE claude_ro SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE traversal_discovery TO claude_ro;
GRANT USAGE ON SCHEMA public TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO claude_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE tbd IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE tbd IN SCHEMA public GRANT SELECT ON SEQUENCES TO claude_ro;
SQL
( umask 077; printf '%s\n' "$PW" > "$PW_FILE" )
echo "   password -> $PW_FILE (0600). Transfer to the laptop pgpass, then: rm $PW_FILE"

echo "== 3. audit log + forced-command wrapper =="
sudo touch "$AUDIT_LOG"
sudo chown root:"$RO_USER" "$AUDIT_LOG"
sudo chmod 0620 "$AUDIT_LOG"
sudo chattr +a "$AUDIT_LOG" 2>/dev/null || echo "   (chattr +a unsupported here; log stays group-append by mode only)"
sudo tee "$WRAPPER" >/dev/null <<'WRAP'
#!/bin/sh
# Forced command for the claude-ro key: append-only audit, then exec.
LOG=/var/log/claude-ro-audit.log
printf '%s %s\n' "$(date -Is)" "${SSH_ORIGINAL_COMMAND:-<no-command>}" >> "$LOG" 2>/dev/null || true
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi
exec /bin/bash
WRAP
sudo chmod 755 "$WRAPPER"

echo "== 4. authorized_keys (restrict + tunnel + forced command) =="
RO_HOME="$(getent passwd "$RO_USER" | cut -d: -f6)"
sudo install -d -m 700 -o "$RO_USER" -g "$RO_USER" "$RO_HOME/.ssh"
printf 'restrict,port-forwarding,command="%s" %s\n' "$WRAPPER" "$PUBKEY" | sudo tee "$RO_HOME/.ssh/authorized_keys" >/dev/null
sudo chown "$RO_USER":"$RO_USER" "$RO_HOME/.ssh/authorized_keys"
sudo chmod 600 "$RO_HOME/.ssh/authorized_keys"

echo "== 5. sshd Match block (tunnel locked to PG loopback) =="
sudo tee "$SSHD_DROPIN" >/dev/null <<'CONF'
Match User claude-ro
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:5432
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
CONF
sudo sshd -t
sudo systemctl reload ssh

echo "== 6. secrets exposure check =="
SECRETS_MODE="$(stat -c %a "$HOME/.secrets" 2>/dev/null || echo missing)"
if [[ "$SECRETS_MODE" != "600" && "$SECRETS_MODE" != "missing" ]]; then
  chmod 600 "$HOME/.secrets"
  echo "   ~/.secrets was mode $SECRETS_MODE -> chmod 600 applied"
else
  echo "   ~/.secrets mode: $SECRETS_MODE (ok)"
fi

echo "== 7. self-tests =="
fail=0
if id -nG "$RO_USER" | tr ' ' '\n' | grep -qx docker; then echo "FAIL: $RO_USER in docker group"; fail=1; else echo "PASS: not in docker group"; fi
if id -nG "$RO_USER" | tr ' ' '\n' | grep -qx sudo; then echo "FAIL: $RO_USER in sudo group"; fail=1; else echo "PASS: not in sudo group"; fi
COUNT="$(docker exec -e PGPASSWORD="$PW" "$PG_CONTAINER" psql -h 127.0.0.1 -U claude_ro -d "$PG_DB" -tAc 'SELECT count(*) FROM pages;' || echo ERR)"
if [[ "$COUNT" =~ ^[0-9]+$ && "$COUNT" -gt 0 ]]; then
  echo "PASS: SELECT as claude_ro sees $COUNT pages (grants + RLS bypass working)"
else
  echo "FAIL: SELECT as claude_ro returned '$COUNT'"; fail=1
fi
if docker exec -e PGPASSWORD="$PW" "$PG_CONTAINER" psql -h 127.0.0.1 -U claude_ro -d "$PG_DB" -c 'CREATE TABLE _claude_ro_probe(i int);' >/dev/null 2>&1; then
  echo "FAIL: write as claude_ro SUCCEEDED -- do not use this channel until fixed"
  docker exec "$PG_CONTAINER" psql -U tbd -d "$PG_DB" -c 'DROP TABLE IF EXISTS _claude_ro_probe;' >/dev/null
  fail=1
else
  echo "PASS: write as claude_ro rejected"
fi

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "ALL SELF-TESTS PASSED."
else
  echo "SELF-TEST FAILURES -- resolve before handing the channel to CC."
fi
echo ""
echo "Laptop next steps:"
echo "  1. scp compendium-server:claude-ro-pg-password <somewhere-local>  (CC wires pgpass"
echo "     from the file without echoing it), then: ssh compendium-server 'rm claude-ro-pg-password'"
echo "  2. CC verifies: ssh compendium-ro 'curl -s 127.0.0.1:8001/health'"
echo "  3. Spot-check the audit trail: ssh compendium-server 'sudo tail /var/log/claude-ro-audit.log'"
