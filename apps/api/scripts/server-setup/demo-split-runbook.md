# Runbook: tailnet-only owner stack + separate public demo stack

Cutover for the 2026-10-06 tailnet-owner-demo-split. Run the steps in order
on the server (as the deploy user, from the checkout at `~/apps/compendium`)
unless a step says otherwise. Check each step before starting the next.
Steps 1-7 are reversible. Roll back in reverse order: undo a later step
before an earlier one (e.g. undo 6 before 5, 5 before 3).

Placeholders: `<tailnet-host>` = the server's MagicDNS name;
`<public-api-host>` = the public API hostname on the Cloudflare tunnel;
`<server>` = the server's SSH target;
`<desktop-tailnet-ip>`, `<server-tailnet-ip>`, `<lan-gateway-ip>` as named;
`<demo-subnet-gateway-ip>` = the demo bridge's own address, from
`ip -4 -br addr show br-compdemo` (the bridge exists once step 3 has run;
network declared in `apps/api/docker/docker-compose.demo.yml`).

## 0. Pre-flight

1. `cd ~/apps/compendium && git pull --ff-only`. The deploy script does no
   pull; deploys once ran silently 57 commits behind.
2. `free -h`. The web image build needs several GB. If less than about 3 GB
   is available, build the image on another machine instead of on the server:
   `docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_DEMO_ROLE_TOOLING=1 -t compendium-web:server .`,
   then `docker save compendium-web:server | ssh <server> docker load`. Then
   run EVERY owner deploy below with `NO_WEB_BUILD=1` (e.g.
   `NO_WEB_BUILD=1 bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed`),
   otherwise the deploy rebuilds the web image on the server and replaces the
   loaded one.
3. Docker subnet overlap. List every Docker network's subnets:

       docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'

   No network other than `compendium-demo-net` may use 172.31.250.0/24 (the
   demo subnet declared in `apps/api/docker/docker-compose.demo.yml`) or any range
   containing it. Also `ip -br addr | grep 172.31.250.` must print nothing.
4. Make sure `~/apps/compendium/.env` holds `TAILNET_HOSTNAME=<tailnet-host>`
   (section-21's probes read it). Optionally add
   `PUBLIC_API_HOSTNAME=<public-api-host>` there too so the demo public probe runs.

## 1. Owner web on the tailnet

    bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed
    tailscale serve status --json > ~/tailscale-serve-pre-split.json
    sudo tailscale serve reset
    sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
    sudo tailscale serve --bg --https=8443 http://127.0.0.1:8001
    tailscale serve status

Check: from your laptop or phone (on the tailnet), `https://<tailnet-host>/`
shows the login page. Log in; the graph, diary, topic detail and chat work.
The session is not remembered yet (that's step 6). Dash is no longer exposed.

Rollback (compare against the saved `~/tailscale-serve-pre-split.json`):

    sudo tailscale serve reset && sudo tailscale serve --bg --https=443 http://127.0.0.1:8080

then run `tailscale serve status --json` and confirm it matches the saved
file.

## 2. Collectors

- Browser extension: popup, then Settings, then Backend URL =
  `https://<tailnet-host>:8443`. The API key is unchanged.
- Android: Settings, then Backend URL = `https://<tailnet-host>:8443`. The
  phone needs Tailscale up when it uploads. Sessions queue locally until
  then.

Check: browse a page and confirm it shows in the diary or the Pipeline view
within a few minutes. Rollback: set the previous URL back.

## 3. Demo stack

    cp apps/api/docker/demo-stack.env.example ~/apps/compendium/.env.demo
    chmod 600 ~/apps/compendium/.env.demo
    # fill it in: openssl rand -hex 32 for each random value; the capped demo
    # OpenAI key; the published demo password; the Vercel origin; copy the
    # current RATE_LIMIT_TRUST_CF_HEADER / PROXY_SHARED_SECRET values from the
    # owner stack's ~/.secrets or ~/apps/compendium/.env into the DEMO_ names
    bash apps/api/scripts/server/deploy_server.sh --stack demo

The demo API's host port is `DEMO_API_HOST_PORT` in `.env.demo` (default
8002); the deploy script's health wait and the probes below follow it. The
demo stack never reads `~/.secrets`.

Check (use your `DEMO_API_HOST_PORT` value in place of 8002 if it is not the
default):
- `curl -s 127.0.0.1:8002/health` reports `db_connected: true`.
- `docker logs compendium-demo-api 2>&1 | grep -A 20 'action='` shows
  `action=replaced` on the first boot, with the loader's per-table counts
  (pages inserted).
- `curl -s -X POST 127.0.0.1:8002/api/auth/login -H 'content-type: application/json' -d '{"email":"demo","password":"<published-demo-password>"}'`
  returns 200 (the demo account's username `demo` is set by the bootstrap).

Rollback: `docker compose -p compendium-demo --env-file ~/apps/compendium/.env.demo -f apps/api/docker/docker-compose.demo.yml down`
(the public site is still on the owner API until step 5).

## 4. Firewall

Preview the rules first (writes nothing):

    RENDER_ONLY=1 bash apps/api/scripts/server-setup/demo-isolation-firewall.sh

Then apply:

    bash apps/api/scripts/server-setup/demo-isolation-firewall.sh

This runs before the public flip so the demo is already isolated when it goes
live. Safety behaviour: the script refuses, with no edits, if ufw's `before.rules`
lacks the stock RELATED,ESTABLISHED accept it anchors on; every edit backs the
rule files up first; and on a failed `ufw reload` it restores both backups,
reloads again and exits 1. It verifies DOCKER-USER after the reload.

Check from inside the demo container. Expect `blocked` for the first four and
`open` for the last:

    docker exec -i compendium-demo-api python - <<'EOF'
    import socket
    for host, port in [("<desktop-tailnet-ip>", 445), ("<lan-gateway-ip>", 80),
                       ("<server-tailnet-ip>", 443), ("<demo-subnet-gateway-ip>", 22),
                       ("api.openai.com", 443)]:
        s = socket.socket(); s.settimeout(3)
        try:
            s.connect((host, port)); print(host, port, "open")
        except OSError as e:
            print(host, port, "blocked", type(e).__name__)
        finally:
            s.close()
    EOF

The last line (`api.openai.com 443 open`) is the "demo chat still works"
check. The public site is not on the demo stack yet, so confirm over
loopback rather than through the public site. After step 5, also ask the
public demo's chat one question; it must still answer.

Rollback: the script prints its restore command only on success, so spell it
out: find the backups it made (`ls -t /etc/ufw/*.bak-*`), restore each over
its file (`sudo cp /etc/ufw/after.rules.bak-<ts> /etc/ufw/after.rules` and
`sudo cp /etc/ufw/before.rules.bak-<ts> /etc/ufw/before.rules`), then
`sudo ufw reload`.

## 5. Tunnel flip

1. `sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%Y%m%d-%H%M%S)`
2. In `/etc/cloudflared/config.yml`, change the `<public-api-host>` rule's
   `service: http://localhost:8001` to `service: http://localhost:8002` (or
   your `DEMO_API_HOST_PORT`). Keep the `^/metrics` 404 rule above it.
3. `sudo systemctl restart cloudflared`
4. Vercel: Project, then Settings, then Environment Variables. Set
   `NEXT_PUBLIC_DEMO_ROLE_TOOLING` off (delete it), then redeploy production
   and promote it.

Check: the public site loads; the demo login works; the graph shows the demo
corpus; chat answers; preview images load. Your own login fails on the public
site ("invalid credentials"; that account does not exist there).

Rollback: restore the `.bak` config and `sudo systemctl restart cloudflared`.

## 6. Owner API hardening (only after step 5)

GATE: do not continue until no tunnel route reaches the owner stack. Run
`grep -nE '^\s*-? *service:' /etc/cloudflared/config.yml` (or
`bash apps/api/scripts/server/diagnose_server.sh`) and require that no
`service:` line points at `:8001` or `:3000`.

1. In `~/apps/compendium/.env`, set `TAILNET_ONLY_DEPLOYMENT=1` and
   `API_CORS_ORIGINS=https://<tailnet-host>`.
2. Remove `RATE_LIMIT_TRUST_CF_HEADER`, `PROXY_SHARED_SECRET` and
   `OPENAI_API_KEY_DEMO` from wherever they are set. Run
   `grep -noE '^(export )?(RATE_LIMIT_TRUST_CF_HEADER|PROXY_SHARED_SECRET|OPENAI_API_KEY_DEMO)=' ~/.secrets ~/apps/compendium/.env`
   to find them (it prints variable names and line numbers, never values). The API refuses to boot with tailnet-only plus CF-header
   trust.
3. `bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed`
   (with `NO_WEB_BUILD=1` if the web image was built off-box).
4. `sudo systemctl disable --now caddy`. Caddy is out of the serving path
   since step 1; it stayed up only so step 1 could roll back.

Check: sign out, then sign in on `https://<tailnet-host>/`. The login response
or the `session_policy` cookie shows `remembered: true`.

Rollback: revert the `.env` / `~/.secrets` edits and redeploy;
`sudo systemctl enable --now caddy`.

## 7. Tailscale ACL

Pre-check: nothing on the server may need to open connections to your other
devices. List established connections to tailnet peers and compare against
`tailscale status`:

    sudo ss -tnp state established
    tailscale status
    crontab -l; sudo crontab -l; systemctl list-timers --all

Look for outbound connections or jobs that target tailnet peers (their
tailnet IPs or MagicDNS names). restic goes to R2 and the local SSD, which is
fine.

In the Tailscale admin console:
1. Copy the current policy file somewhere safe.
2. Add the tag owner and make your own devices the only connection
   initiators. In the `grants` form:

        "tagOwners": {
          "tag:compendium-server": ["autogroup:admin"],
        },
        "grants": [
          // Your devices reach everything, the tagged server included.
          // Nothing grants tag:compendium-server a destination, so the
          // server (and every container on it) cannot open connections to
          // your devices.
          {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
        ],

   If the policy uses the older `acls` form, replace the allow-all rule with
   `{"action": "accept", "src": ["autogroup:member"], "dst": ["*:*"]}`. Leave
   the `ssh` section as it is.
3. Machines, then the server, then Edit ACL tags: add
   `tag:compendium-server`. Tagging disables key expiry on that node, which
   is expected.

Caveat: tagging the server removes it from `autogroup:self`, so a default
Tailscale-SSH `ssh` rule (`dst: autogroup:self`) stops covering it. OpenSSH
over the tailnet IP still works through the grant above. Un-tagging may need
node re-auth, so keep LAN or console access available before tagging.

Check: from the laptop, desktop and phone, `https://<tailnet-host>/`,
`https://<tailnet-host>:8443/health` and SSH all still work. From the server,
`nc -vz -w3 <desktop-tailnet-ip> 445` fails.

Rollback: paste the saved policy back and remove the tag.

## 8. Owner DB demo copy (the only step that writes owner data)

    mkdir -p ~/backups
    docker exec compendium-postgres pg_dump -U tbd -Fc traversal_discovery > ~/backups/pre-demo-replace-$(date +%Y%m%d-%H%M%S).dump
    ls -l ~/backups/pre-demo-replace-*.dump
    SEED_APPLY=no bash apps/api/scripts/server/deploy_server.sh --stack owner

(add `NO_WEB_BUILD=1` if the web image was built off-box.) The dump must be
non-empty (the `ls -l` line) before you continue.

Read the dry run's per-table counts (deleted and inserted). Both should be
about the size of the seed (22 captures, 158 + 113 pages, 49 clusters).

Failure signals; in every case stop and report, nothing was changed:
- The deploy script exits 3: the dry run failed. The deploy itself is up; the
  refresh was not applied.
- The loader exits 2 (visible inside that output): a seed id collision, a
  `captures.capture_id` clash, or rows of another account under demo rows.
  The loader aborts with nothing changed.

Then apply:

    SEED_APPLY=yes bash apps/api/scripts/server/deploy_server.sh --stack owner

A failed apply exits 1 and nothing changed (the loader runs in one
transaction).

Without `SEED_APPLY=yes` the script asks at a terminal and never applies
without one. `--skip-seed` skips the whole step.

Check: on `https://<tailnet-host>/`, View as demo shows the demo corpus with
current previews. Your own graph is unchanged.

Rollback: restore the dump:

    docker exec -i compendium-postgres pg_restore -U tbd -d traversal_discovery --clean --if-exists < ~/backups/pre-demo-replace-<ts>.dump

Restoring rolls the WHOLE database back to the dump time, so run this step
right after taking the dump.

## Done when

- `<public-api-host>` reaches only the demo stack.
- No public route reaches `:8001` or `:3000` (`diagnose_server.sh` checks the
  tunnel config for this).
- Steps 1-8 are all checked.
