# Runbook: passwordless owner sign-in on the tailnet

Turns on automatic sign-in for browsers you trust once, on the tailnet-only
owner stack (tailnet-passwordless-login, 2026-10-09). Requires the owner
stack from the demo split (`TAILNET_ONLY_DEPLOYMENT=1`, `tailscale serve`
443 -> web `127.0.0.1:3000`). Placeholders: `<tailnet-host>` = the server's
MagicDNS name; `<checkout>` = the monorepo checkout on the server.

## Requirement

The owner web must only ever be reached through `tailscale serve`: it trusts
the `Tailscale-User-Login` header because serve sets it and strips forged
copies. `TAILNET_LOGIN=1` is therefore only safe on a web server bound to
`127.0.0.1` behind `tailscale serve`. Never set it on a server reachable
directly on the tailnet or LAN (for example a dev server listening on all
interfaces): any device that can reach it could send its own
`Tailscale-User-Login` header. Never publish `:3000` beyond `127.0.0.1` and
never route the Cloudflare tunnel to it (the demo-split runbook's step 6 gate
checks the tunnel). Requests carrying Cloudflare headers are refused anyway.

## 1. Find your Tailscale login

On any of your devices:

    tailscale status --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])'

## 2. Configure

In `~/apps/compendium/.env` (owner env file), add:

    TAILNET_LOGIN=1
    TAILNET_ASSERT_SECRET=<output of: openssl rand -hex 32>
    TAILNET_LOGIN_MAP=<your tailscale login>=<your account email>

Names only check (never prints values):

    grep -noE '^(TAILNET_LOGIN|TAILNET_ASSERT_SECRET|TAILNET_LOGIN_MAP|TAILNET_ONLY_DEPLOYMENT)=' ~/apps/compendium/.env

## 3. Deploy

    cd <checkout> && git pull --ff-only && bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed

## 4. Trust each browser once

On each device (laptop, phone, desktop) open `https://<tailnet-host>/`. The
login page shows "Tailscale: signed in as <your login>"; sign in with your
password with "Trust this browser for automatic sign-in" ticked. Signing in
with the box unticked leaves that browser untrusted.

## Check

- Reload: the app opens with no login page.
- Sign out: the login page shows "Continue as <your login>" and keeps showing
  it until you click it; it signs you in with no password.
- From a fresh client (e.g. `curl -s -o /dev/null -w '%{http_code}\n' https://<tailnet-host>/`)
  you get a redirect to `/login`, not the app.

## Revoke

    docker exec compendium-api python scripts/trusted_browsers.py list
    docker exec compendium-api python scripts/trusted_browsers.py revoke <id>
    docker exec compendium-api python scripts/trusted_browsers.py revoke-all --user <your account email> --sessions

`--sessions` also ends the sessions the account holds now. Keep `--user`:
without it, only accounts that still have an active trusted browser at that
moment are affected, so after a `revoke <id>` it would end nothing.

## Rollback

Remove the three lines from `~/apps/compendium/.env` and redeploy the owner
stack. The endpoints return 404 and password sign-in works as before.
