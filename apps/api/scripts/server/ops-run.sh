#!/usr/bin/env bash
# ops-run.sh -- run a command with a masked, journaled record of the run.
#
# Usage:   ops-run.sh <command> [args...]      (installed as `ops` by section-22)
#
# Appends a start and an end JSON line to $OPS_JOURNAL_DIR/journal.jsonl and
# writes the command's combined stdout+stderr, passed through ops_mask.py, to
# $OPS_JOURNAL_DIR/runs/<run_id>.log. The terminal still gets the raw output.
# stdin is untouched (silent prompts keep working). The exit code is the
# command's. Run id: <YYYY-MM-DD-HHMMSS>-<basename of command>.
#
# Fails closed: if the journal dir is missing or unwritable the wrapper
# refuses (exit 2) rather than letting a run go unlogged. Create it with
# apps/api/scripts/server-setup/section-22-ops-journal.sh.
#
# Env: OPS_JOURNAL_DIR (default /var/log/compendium-ops)
#      OPS_MASK_SECRETS (read by ops_mask.py; default ~/.secrets)
# See README.md in this directory for what is and is not masked.

set -uo pipefail

JOURNAL_DIR="${OPS_JOURNAL_DIR:-/var/log/compendium-ops}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASK="${OPS_MASK_SCRIPT:-$HERE/ops_mask.py}"

if [[ $# -lt 1 ]]; then
  echo "usage: ops-run.sh <command> [args...]" >&2
  exit 2
fi

if [[ ! -d "$JOURNAL_DIR" || ! -w "$JOURNAL_DIR" ]]; then
  echo "ops-run: journal dir '$JOURNAL_DIR' is missing or not writable; refusing to run unlogged." >&2
  echo "ops-run: create it with apps/api/scripts/server-setup/section-22-ops-journal.sh" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ops-run: python3 not found on PATH; the journal and mask filter need it. Refusing to run unlogged." >&2
  exit 2
fi
mkdir -p "$JOURNAL_DIR/runs" 2>/dev/null
if [[ ! -w "$JOURNAL_DIR/runs" ]]; then
  echo "ops-run: '$JOURNAL_DIR/runs' is not writable; run section-22-ops-journal.sh" >&2
  exit 2
fi

CMD="$1"
RESOLVED="$(command -v -- "$CMD" 2>/dev/null || true)"
RUN_ID="$(date +%Y-%m-%d-%H%M%S)-$(basename -- "$CMD")"
JOURNAL="$JOURNAL_DIR/journal.jsonl"
RUN_LOG="$JOURNAL_DIR/runs/$RUN_ID.log"
GIT_SHA=""
if [[ -n "$RESOLVED" && -e "$RESOLVED" ]]; then
  GIT_SHA="$(git -C "$(dirname -- "$(readlink -f -- "$RESOLVED")")" rev-parse HEAD 2>/dev/null || true)"
fi

# journal_line <phase> [exit] [duration_s]; argv/cwd go through json.dumps.
journal_line() {
  python3 - "$JOURNAL" "$1" "${2:-}" "${3:-}" "$RUN_ID" "$CMD" "$GIT_SHA" "$PWD" "$(id -un)" "${@:4}" <<'PY'
import datetime, json, os, sys
journal, phase, code, dur, run_id, script, sha, cwd, user = sys.argv[1:10]
argv = sys.argv[10:]
rec = {
    "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "run_id": run_id, "phase": phase, "script": script, "argv": argv,
    "cwd": cwd, "git_sha": sha or None, "host_user": user,
}
if phase == "end":
    rec["exit"] = int(code)
    rec["duration_s"] = int(dur)
    if os.environ.get("OPS_MASK_FAILED") == "1":
        rec["mask_failed"] = True
with open(journal, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(rec) + "\n")
PY
}

shift_args=("${@:2}")
journal_line start "" "" "${shift_args[@]}"

RC_FILE="$(mktemp)"
START=$SECONDS
# Terminal gets the raw stream from tee's stdout; the masked copy goes to the
# log through a pipe on fd 4 (a pipe, unlike a socket stdout, can be re-opened
# by tee as /dev/fd/4). Stderr is merged into stdout so ordering is preserved.
exec 4> >(python3 "$MASK" >>"$RUN_LOG")
MASK_PID=$!
# A journal failure must never abort the wrapped command: tee -p keeps the
# terminal stream alive if the mask pipe breaks, and mask death is recorded.
( exec 4>&-; "$@" 2>&1; echo $? >"$RC_FILE" ) | tee -p /dev/fd/4
TEE_RC="${PIPESTATUS[1]}"
exec 4>&-
wait "$MASK_PID" 2>/dev/null
MASK_RC=$?
export OPS_MASK_FAILED=0
if [[ "$MASK_RC" -ne 0 || "$TEE_RC" -ne 0 ]]; then
  OPS_MASK_FAILED=1
  echo "ops-run: WARNING mask filter failed; run log '$RUN_LOG' may be incomplete (command result unaffected)" >&2
fi
RC="$(cat "$RC_FILE" 2>/dev/null)"
rm -f "$RC_FILE"
RC="${RC:-127}"

journal_line end "$RC" "$((SECONDS - START))" "${shift_args[@]}"
exit "$RC"
