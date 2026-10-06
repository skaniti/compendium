# Server-setup scripts

Idempotent bash scripts that automate the scriptable portions of the 2026-05-03 laptop-server-setup plan (private), plan.md, sections 13-22.

## Workflow per script

1. **Transfer to server** (from workstation):
   ```
   scp scripts/server-setup/section-NN-<topic>.sh <user>@<server-ip>:~/
   ```
2. **Run on server**:
   ```
   bash ~/section-NN-<topic>.sh
   ```
   Output tees to `~/server-setup-logs/NN-<topic>-<timestamp>.log` on the server.

3. **Retrieve log** (from workstation):
   ```
   scp <user>@<server-ip>:~/server-setup-logs/<NN-*-*.log> scripts/server-setup/logs/
   ```
4. (Optional) ask Claude to verify by referencing the log filename in `scripts/server-setup/logs/`.

## Script conventions

Each script:
- Uses `set -euxo pipefail` (fail fast, trace every command + arg expansion).
- Tees all stdout + stderr to a timestamped log file.
- Disables `set -x` briefly around secret generation (so passwords / topic names don't end up in the log).
- Writes secrets to root-owned config files (mode 640) or `~`-dotfiles (mode 600); never echoes them to stdout.
- Is idempotent where reasonable: re-runs pick up existing state (e.g., reuses an existing `~/.nut-ntfy-topic` rather than regenerating).
- Prints a clear "DONE" summary at the end with next manual steps.

## Files

| File | Plan section | Purpose |
|---|---|---|
| `section-13-nut.sh` | 13 | NUT install + UPS detection + 5 config files + service start + ntfy.sh notify hooks |
| `section-14-baseline.sh` | 14 | Born-on-date hardware + performance snapshot (inxi, SMART, sensors, 5-min stress, fio, iperf3) -> markdown report |
| `section-15-tailscale.sh` | 15 | Tailscale install (interactive auth URL; script blocks) + hostname set + status verify |
| `section-16-cloudflare-tunnel.sh` | 16 | cloudflared install + interactive tunnel login + create + config.yml + DNS route + systemd service |
| `section-17-docker.sh` | 17 | Docker Engine + Compose plugin + group setup + auto-start + verify |
| `section-18-app-stack.sh` | 18 | git clone + docker compose up + migrate + bootstrap users (single stack; provisions BOTH primary + demo users via bootstrap_user.py; uses `docker/server/docker-compose.yml`) |
| `section-19-caddy.sh` | 19 | SUPERSEDED 2026-10-06 (Caddy left the serving path; see demo-split-runbook.md). Caddy install (official apt repo) + Caddyfile (loopback `:8080` -> Dash `:8051`) + repoint cloudflared + `tailscale serve` from 8051 to 8080 |
| `section-20-backups.sh` | 20 | restic install + repo init + nightly backup script + cron entry at 03:00 |
| `section-21-autostart-verify.sh` | 21 | Enable all services for auto-start + pre/post-test verify (run with `--post-verify` after a reboot) |
| `maintenance-quickcheck.sh` | 22 | Weekly/monthly health quickcheck (read-only): journal errors, RAM/swap, SMART, backup freshness, services, disk |
| `demo-isolation-firewall.sh` | — | ufw rules keeping the public demo stack's containers off the tailnet, the LAN and the host (DOCKER-USER + ufw-before-input); idempotent, backs up the rule files |
| `demo-split-runbook.md` | — | Cutover runbook: owner stack tailnet-only, public demo on its own stack, firewall + Tailscale ACL, owner demo-copy refresh |

The `logs/` subdirectory is tracked (via `.gitkeep`); the `.log` files inside are gitignored.
