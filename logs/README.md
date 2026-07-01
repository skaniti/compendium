# logs/

Local dev-run logs written by `scripts/dev.sh`:

- `<YYYY-MM-DD-HHMMSS>-frontend.log` — the Next dev server
- `<YYYY-MM-DD-HHMMSS>-backend.log` — the FastAPI backend (when `dev.sh` starts it)
- `latest.log` — symlink to the newest frontend log; use `tail -f logs/latest.log`

Everything here except this README is gitignored: logs are per-machine and may
contain local paths or request data, so they never ship.
