# Server scripts: ops journal

Scripts here run on the app server. Mutation scripts are run through the
`ops` wrapper so every run leaves a masked record.

## The `ops <script>` convention

```
ops deploy_server.sh
ops backup_db.sh
ops ./section-19-caddy.sh
```

`ops` is `ops-run.sh` (symlinked to `~/bin/ops` by section 22). For each run it:

- appends a start line and an end line to `/var/log/compendium-ops/journal.jsonl`
  (`ts, run_id, phase, script, argv, cwd, git_sha, host_user`; the end line adds
  `exit, duration_s`);
- writes the combined stdout+stderr, passed through `ops_mask.py`, to
  `/var/log/compendium-ops/runs/<run_id>.log` (`<YYYY-MM-DD-HHMMSS>-<basename>`);
- still shows the raw output on the terminal, passes stdin through untouched
  (silent prompts work), and returns the command's exit code.

If the journal directory is missing or not writable the wrapper refuses with
exit 2 and points at section 22; nothing runs unlogged by accident. An
unwrapped run is unlogged. Override the location with `OPS_JOURNAL_DIR`.
stderr is merged into stdout while wrapped, and a program that checks
whether stdout is a terminal will see a pipe.

## What is masked, and what is not

- Every value of 8+ characters in `~/.secrets` (or `$OPS_MASK_SECRETS`) is
  replaced by `<SECRET:KEY>`, longest value first.
- Known shapes are replaced by `<REDACTED:kind>`: `sk-`, `sk-ant-`, `cmp_`,
  `hf_`, `ghp_` tokens, JWT triples, `Bearer` tokens, `password=`, `token=`,
  `secret=`, `PGPASSWORD=` assignments, `postgresql://user:pass@`
  credentials, and hex or base64url runs of 48+ characters (a 40-char git
  SHA survives).
- Not masked: a brand-new secret printed before it is saved to `~/.secrets`
  and not matching a shape; secrets shorter than 8 characters; anything a
  script writes directly to a file rather than stdout/stderr; the terminal
  itself (it stays raw). The rotate script prints the new key once by
  design: the journal copy is masked by shape, the terminal shows it.

## Reading the journal as a read-only user

The directories are `2750` with group `adm`; `claude-ro` is in `adm`.

```
tail -n 20 /var/log/compendium-ops/journal.jsonl
ls -t /var/log/compendium-ops/runs | head
cat /var/log/compendium-ops/runs/<run_id>.log
```

The API's file log is `/var/log/compendium-ops/api/api.jsonl` (rotated daily,
14 kept, by `/etc/logrotate.d/compendium-api`).

## Install (once, user-run)

```
bash apps/api/scripts/server-setup/section-22-ops-journal.sh
```

It uses sudo to create the directories, installs `~/bin/ops`, and installs the
logrotate drop-in. `RENDER_ONLY=1` prints the plan without sudo. Add
`umask 027` to your shell profile so journal files are group-readable but not
world-readable, and put `~/bin` on `PATH`.
