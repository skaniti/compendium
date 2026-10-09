# Runbook: tailnet-only owner stack + separate public demo stack

Cutover for the 2026-10-06 tailnet-owner-demo-split. Run the steps in order
on the server, as the deploy user, from `<checkout>` (the compendium monorepo
checkout; see pre-flight 0.1) unless a step says otherwise. Check each step
before starting the next.
Steps 1-7 are reversible. Roll back in reverse order: undo a later step
before an earlier one (e.g. undo 6 before 5, 5 before 3).

Placeholders: `<tailnet-host>` = the server's MagicDNS name;
`<public-api-host>` = the public API hostname on the Cloudflare tunnel;
`<server>` = the server's SSH target;
`<desktop-tailnet-ip>`, `<server-tailnet-ip>`, `<lan-gateway-ip>` as named;
`<demo-subnet-gateway-ip>` = the demo bridge's own address, from
`ip -4 -br addr show br-compdemo` (the bridge exists once step 3 has run;
network declared in `apps/api/docker/docker-compose.demo.yml`).

Two directories, on purpose:
- `<checkout>`: the compendium monorepo checkout (pre-flight 0.1). Every
  relative `apps/api/...` path below runs from here.
- `~/apps/compendium`: the older explorer clone. The deploy env files live
  here, `.env` (owner stack, already exists) and `.env.demo` (created in
  step 3), because `deploy_server.sh`, section-21 and `diagnose_server.sh`
  read them from this directory by default. Every `~/apps/compendium/...`
  path below is deliberate; it is not the checkout.

## 0. Pre-flight

1. Find `<checkout>`: it is three levels above the directory the running API
   was deployed from.

       docker inspect compendium-api --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}} {{index .Config.Labels "com.docker.compose.project"}}'

   The first value ends in `/apps/api/docker`; strip that to get
   `<checkout>`. The second value must be `docker` (item 6 below).
   `~/apps/compendium` is NOT the checkout: it holds the older explorer
   clone and the deploy env files (`.env`, and `.env.demo` from step 3) that
   the deploy script reads by default.
   Then `cd <checkout> && git pull --ff-only`. The deploy script does no
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
   `compendium-demo-net` does not exist until step 3 creates it;
   `compendium-net` (the existing owner network) and the other default
   networks are expected in the list.
4. Make sure the owner env file `~/apps/compendium/.env` (it already exists;
   `ls -l` it) holds `TAILNET_HOSTNAME=<tailnet-host>`
   (section-21's probes read it). Optionally add
   `PUBLIC_API_HOSTNAME=<public-api-host>` there too so the demo public probe
   runs. `diagnose_server.sh` reads the same `PUBLIC_API_HOSTNAME` from that
   file when `PUBLIC_API_URL` is not set in the environment (an exported
   `PUBLIC_API_URL` wins).
5. Build-context check. `deploy_server.sh` writes deploy logs under
   `apps/api/logs/`, inside the api image's build context, and a failed
   deploy's logs include tails of the owner api and web logs.
   `apps/api/.dockerignore` excludes them; confirm nothing else is loose:

       git status --ignored --short apps/api

   Expect only caches (`__pycache__`, `.pytest_cache`, `.ruff_cache`), `.env`
   files, `data/agent-traces/`, `data/backups/`, `logs/` and test caches. All
   of these are excluded from the image. Any other entry must be checked
   (and excluded or removed) before building the demo image.
6. Compose project label. The owner stack must run under project `docker`:

       docker inspect compendium-api --format '{{index .Config.Labels "com.docker.compose.project"}}'

   It must print `docker`. If it prints anything else, STOP: `deploy_server.sh`
   pins `PROJECT=docker` for the owner stack and would conflict with the
   running containers.
7. Variables that override the deploy script's own. Names only, never values:

       grep -noE '^(export )?(STACK|PROJECT|REPO_ROOT|PROJECT_ROOT|COMPOSE_FILE|ENV_FILE|SECRETS_FILE|SEED_MODE|API_HOST_PORT)=' ~/.secrets ~/apps/compendium/.env

   Any hit must be removed first (the script is sourced against those files;
   a stray `STACK=` or `PROJECT=` there would redirect the deploy).

## 1. Owner web on the tailnet

    bash apps/api/scripts/server/deploy_server.sh --stack owner --skip-seed
    tailscale serve status --json > ~/tailscale-serve-pre-split.json
    sudo tailscale serve --https=443 off
    sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
    sudo tailscale serve --bg --https=8443 http://127.0.0.1:8001
    tailscale serve status

Check: from your laptop or phone (on the tailnet), `https://<tailnet-host>/`
shows the login page. Log in; the graph, diary, topic detail and chat work.
The session is not remembered yet (that's step 6). Dash is no longer exposed.

Rollback (compare against the saved `~/tailscale-serve-pre-split.json`).
Targeted, so other serve routes are never wiped:

    sudo tailscale serve --https=8443 off
    sudo tailscale serve --https=443 off && sudo tailscale serve --bg --https=443 http://127.0.0.1:8080

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
- Functional checks over loopback (spec section 6 requires them before the
  flip). The block below logs in as `demo`, then checks the graph, the chat
  and a preview asset. The token stays in a shell variable and is never
  printed. Replace `<published-demo-password>`; set `PORT` to your
  `DEMO_API_HOST_PORT` if it is not 8002. The login route is limited to
  5 per minute, so run it once:

      PORT=8002
      TOKEN=$(curl -s -X POST 127.0.0.1:$PORT/api/auth/login -H 'content-type: application/json' -d '{"email":"demo","password":"<published-demo-password>"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
      test -n "$TOKEN" && echo "login ok" || echo "login FAILED"

  (a) Login prints `login ok` (the demo account's username `demo` is set by
  the bootstrap).

  (b) Graph. Nodes are keyed by slugified page title, so a node's
  `visit_count` is the number of pages merged into it. Sum it:

      curl -s "127.0.0.1:$PORT/api/graph?window=all" -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json; n=json.load(sys.stdin)["nodes"]; print("graph nodes:", len(n), "pages:", sum(x.get("visit_count", 1) for x in n))'

  Expect `pages: 158` exactly. `graph nodes: 157` is expected, because two
  seed pages share a title and merge into one node. (The 113 augment pages
  are archived or pending and never become nodes.) Any other pages total
  fails the step.

  (c) Chat. One non-streaming agent query; expect a real answer, not
  "OpenAI API key not configured":

      curl -s -X POST 127.0.0.1:$PORT/api/agent/query -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"query":"What topics does this compendium cover?"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["answer"][:300])'

  (d) Preview asset. Fetch one seed asset through the owner-gated route
  (the path is a seed row's `file_path`, here a file that exists under
  `apps/web/demo/fixtures/assets/captured-assets/`); expect `200`:

      curl -s -o /dev/null -w '%{http_code}\n' "127.0.0.1:$PORT/captured-assets/92/92c33407b103e41932b666a66f07bfd5f5993e6fa35a333d370e4ffb6de255c4.png" -H "Authorization: Bearer $TOKEN"

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

Check from inside the demo container. Run:

```
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
```

Expect `blocked` for the first four and `open` for the last
(`api.openai.com 443 open` means the demo can still reach OpenAI).

Then, with the rules applied, repeat the step 3 chat call (c) over loopback
(log in again for a fresh `TOKEN` if needed). It must still return an answer.
The public site is not on the demo stack yet, so confirm over loopback rather
than through the public site. After step 5, also ask the public demo's chat
one question; it must still answer.

Rollback: the script prints its restore command only on success, so spell it
out: find the backups it made (`ls -t /etc/ufw/*.bak-*`), restore each over
its file (`sudo cp /etc/ufw/after.rules.bak-<ts> /etc/ufw/after.rules` and
`sudo cp /etc/ufw/before.rules.bak-<ts> /etc/ufw/before.rules`), then
`sudo ufw reload`.

## 5. Tunnel flip

1. `sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%Y%m%d-%H%M%S)`
2. In `/etc/cloudflared/config.yml` (root-only, so edit with sudo), change
   the `<public-api-host>` rule's `service: http://localhost:8001` to
   `service: http://localhost:8002` (or your `DEMO_API_HOST_PORT`), keeping
   the `^/metrics` 404 rule above it. One command, then a check:

       sudo sed -i 's|service: http://localhost:8001$|service: http://localhost:8002|' /etc/cloudflared/config.yml && sudo grep -nE '^\s*-? *(hostname|service):' /etc/cloudflared/config.yml

   Expect `http_status:404` (the `/metrics` rule), `http://localhost:8002`,
   and the final `http_status:404`; nothing on `8001`.
3. `sudo systemctl restart cloudflared`
4. Vercel: Project, then Settings, then Environment Variables. Set
   `NEXT_PUBLIC_DEMO_ROLE_TOOLING` off (delete it), then redeploy production
   and promote it.

Check: the public site loads; the demo login works; the graph shows the demo
corpus; chat answers; preview images load. Your own login fails on the public
site ("invalid credentials"; that account does not exist there).

Rollback: restore the `.bak` config and `sudo systemctl restart cloudflared`.
If step 6 is already applied, undo step 6 first: a rollback to the owner
API (`:8001`) behind the tunnel while the owner stack is still tailnet-only
would put the owner data on the public path. The API's tripwire (a request
carrying `CF-Connecting-IP` is untrusted and gets the non-remembered
session policy even under `TAILNET_ONLY_DEPLOYMENT`) is only a backstop, not
a substitute for undoing step 6.

## 6. Owner API hardening (only after step 5)

GATE: do not continue until no tunnel route reaches the owner stack. Run
`sudo grep -E '^\s*-? *service:' /etc/cloudflared/config.yml` (the config
may be root-only; this prints service lines only, never the credentials
line). It is an allowlist: the only acceptable `service:` lines are
`http://localhost:<demo port>` (or `http://127.0.0.1:<demo port>`, demo port
8002 unless changed) and `http_status:404`. Any other service line (the
owner ports `:8001` and `:3000` included) fails the gate; do not continue.
`sudo ENV_FILE=$HOME/apps/compendium/.env DEMO_PORT=<demo port> bash apps/api/scripts/server/diagnose_server.sh`
applies the same allowlist and exits non-zero on a violation. (Your shell
expands `$HOME` before sudo runs; sudo resets `HOME` and drops exported
variables, so the hostname read and `DEMO_PORT` would otherwise be lost.)

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

Read the dry run's per-table counts (deleted and inserted). Inserted should
be about the size of the seed (22 captures, 158 + 113 pages, 49 clusters).
Deleted counts can exceed inserted: the replace deletes EVERY row the demo
account owns that is not in the seed, including a capture the seed manifest
deliberately left out as real developer browsing. That data survives only in
the pg_dump you just took. Decide whether that loss is acceptable before you
apply.

Failure signals; in every case stop and report, nothing was changed:
- The deploy script exits 3: the dry run failed. The deploy itself is up; the
  refresh was not applied.
- The loader exits 2 (visible inside that output): a seed id collision, a
  `captures.capture_id` clash, or rows of another account under demo rows.
  The loader aborts with nothing changed.

One exit 2 has a repair. If the loader's message is `page_content_assets
linking demo assets`, pages of your account link assets the demo account
owns: before migration 031 the assets table was shared by all accounts, and
031 gave each shared row to one of them. The repair gives your pages their
own copies (a same-content row you already own, or a new row and file) and
moves the links; it changes nothing else. The pg_dump above is its rollback.

1. List every pair. Each id is printed with its role; your user id is the
   page account of the pair whose asset owner is `(demo)`. This listing run
   may exit 1 on the other pair's files; only the next two runs must exit 0.

       docker exec compendium-api python scripts/repair_cross_account_assets.py

2. Dry run for your account. Expect exactly one pair,
   `asset owner <demo user id> (demo) -> page account <your user id> (admin)`:

       docker exec compendium-api python scripts/repair_cross_account_assets.py --page-account <your user id>

3. Apply, then repeat this step's dry run from the top:

       docker exec compendium-api python scripts/repair_cross_account_assets.py --page-account <your user id> --apply

If the container has no `scripts/repair_cross_account_assets.py`, redeploy the
owner stack with `--skip-seed` first. If run 2 or 3 exits 1, stop and report.
`links_to_reused_rows_with_other_source_url` counts preview images that will
load from their original site instead of the archive (they return 404 today).
Restoring the pg_dump later leaves the copied files on disk (harmless).

Then apply:

    SEED_APPLY=yes bash apps/api/scripts/server/deploy_server.sh --stack owner

A failed apply exits 1 and nothing changed (the loader runs in one
transaction).

Without `SEED_APPLY=yes` the script asks at a terminal and never applies
without one. `--skip-seed` skips the whole step.

Check: on `https://<tailnet-host>/`, View as demo shows the demo corpus with
current previews. Your own graph is unchanged.

Rollback: restore the dump. Restoring rolls the WHOLE database back to the
dump time, so do it right after taking the dump, and stop every writer first:

    docker stop compendium-web compendium-api
    docker stop <dash-app-container>
    docker stop <dq-worker-container>

(`compendium-web` and `compendium-api` are the owner containers; replace the
two placeholders with the names from `docker ps`, and skip the dq-worker line
if it does not exist.) Then restore and check the exit status:

    docker exec -i compendium-postgres pg_restore -U tbd -d traversal_discovery --clean --if-exists < ~/backups/pre-demo-replace-<ts>.dump; echo "pg_restore exit: $?"

A non-zero status, including "errors ignored on restore", means read the
output before restarting anything. Only on a clean exit, restart in reverse
order:

    docker start <dq-worker-container>
    docker start <dash-app-container>
    docker start compendium-api compendium-web

## Done when

- `<public-api-host>` reaches only the demo stack.
- No public route reaches `:8001` or `:3000` (`diagnose_server.sh` checks the
  tunnel config for this).
- Steps 1-8 are all checked.
