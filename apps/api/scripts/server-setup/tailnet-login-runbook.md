# Runbook: passwordless owner sign-in on the tailnet

Turns on automatic sign-in for browsers you trust once, on the tailnet-only
owner stack (tailnet-passwordless-login, 2026-10-09). Requires the owner
stack from the demo split (`TAILNET_ONLY_DEPLOYMENT=1`, `tailscale serve`
443 -> web `127.0.0.1:3000`). Placeholders: `<tailnet-host>` = the server's
MagicDNS name; `<checkout>` = the monorepo checkout on the server.

## Requirement

`tailscale serve` is the only route that carries a genuine Tailscale identity
from your devices: it sets the `Tailscale-User-Login` header and strips forged
copies. The web container is also reachable from processes on the server
itself (`127.0.0.1:3000`) and, before this change, from other containers on
`compendium-net`. On those paths the header can be forged. There the
trusted-browser token is the guard: a forged header alone gets nothing, because
sign-in also needs the `trusted_browser` cookie value, which only a browser you
trusted holds. This change moves the web container onto a private network
shared only with the API.

Never publish `:3000` beyond `127.0.0.1`, never route the Cloudflare tunnel to
it (the demo-split runbook's step 6 gate checks the tunnel), and never enable
`TAILNET_LOGIN` on a server reachable directly on the tailnet or LAN (for
example a dev server listening on all interfaces): any device that can reach
it could send its own header. Requests carrying Cloudflare headers are refused
anyway.

## 1. Find your Tailscale login

Run this on your own Linux or macOS computer, signed in to Tailscale as you.
Not on the server: it is a tagged node, so it would print `tagged-devices`,
which will not match your sign-in.

    tailscale status --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])'

On Windows PowerShell (one line):

    $s = tailscale status --json | ConvertFrom-Json; $s.User."$($s.Self.UserID)".LoginName

You can also read it on the Users page of the Tailscale admin console.

## 2. Configure

Steps 2 and 3 run on the server. In `~/apps/compendium/.env` (owner env
file), add the lines below. Keep `TAILNET_ASSERT_SECRET` in that file, not in
`~/.secrets`: other containers mount `~/.secrets`, and the secret is only for
the API and web containers.

    TAILNET_LOGIN=1
    TAILNET_ASSERT_SECRET=<output of: openssl rand -hex 32>
    TAILNET_LOGIN_MAP=<your tailscale login>=<your account email>

Names only check (never prints values):

    grep -noE '^(TAILNET_LOGIN|TAILNET_ASSERT_SECRET|TAILNET_LOGIN_MAP|TAILNET_ONLY_DEPLOYMENT)=' ~/apps/compendium/.env

Precondition check (the value is not secret); it must print a line:

    grep -nx 'TAILNET_ONLY_DEPLOYMENT=1' ~/apps/compendium/.env

Without it the API refuses to boot once `TAILNET_ASSERT_SECRET` is set, which
takes the owner stack down until you roll back.

## 3. Deploy

    cd <checkout> && git pull --ff-only && bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed

If you build the web image on another machine (demo-split-runbook pre-flight
0.2), rebuild it from this commit, load it on the server and deploy with
`NO_WEB_BUILD=1`; otherwise the old web image (without tailnet sign-in) keeps
running.

This deploy also moves the web container to a private network shared only
with the API (no action needed).

## 4. Trust each browser once

On each device (laptop, phone, desktop) open `https://<tailnet-host>/`. The
login page shows "Tailscale: signed in as <your login>"; sign in with your
password with "Trust this browser for automatic sign-in" ticked. Signing in
with the box unticked leaves that browser untrusted.

## Check

- Close the browser completely and reopen `https://<tailnet-host>/`: the
  session cookie is gone, so this exercises automatic sign-in. The app opens
  with no login page.
- While signed in, opening `/login` in a trusted browser signs you in again
  automatically. After you sign out, the login page shows "Continue as <your
  login>", which signs you in with no password.
- From a fresh client (not a trusted browser), run
  `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<tailnet-host>/`.
  Expected: a 3xx status with a redirect URL ending in `/login`, not the app.

## Revoke

    docker exec compendium-api python scripts/trusted_browsers.py list
    docker exec compendium-api python scripts/trusted_browsers.py revoke <id>
    docker exec compendium-api python scripts/trusted_browsers.py revoke-all --user <your account email> --sessions

`--sessions` also ends the sessions the account holds now. Keep `--user`:
without it, only accounts that still have an active trusted browser at that
moment are affected, so after a `revoke <id>` it would end nothing.

## Lost or stolen device

1. Remove the device from your tailnet in the Tailscale admin console. This is
   what cuts it off.
2. On the server run `trusted_browsers.py list`, then `revoke <id> --sessions`:

       docker exec compendium-api python scripts/trusted_browsers.py list
       docker exec compendium-api python scripts/trusted_browsers.py revoke <id> --sessions

   `--sessions` ends every session of the account; your other trusted browsers
   sign back in automatically. Without it, a session the lost browser already
   holds keeps refreshing until it signs out. If `list` already shows the
   browser as revoked, `revoke <id> --sessions` still ends the sessions.

Changing your password does not revoke trusted browsers or sessions.

## Rollback

Remove the three lines from `~/apps/compendium/.env` and redeploy the owner
stack:

    cd <checkout> && bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed

The API endpoint then returns 404 and the web route falls back to the
password page. Trusted-browser rows stay on the server and would work again if
you re-enable the feature, so if you are rolling back for security reasons,
first run `docker exec compendium-api python scripts/trusted_browsers.py revoke-all --user <your account email> --sessions`.
