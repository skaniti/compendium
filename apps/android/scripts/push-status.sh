#!/usr/bin/env bash
# Mark a dev-note resolved (or reopen it) from the laptop, via the app's
# append-only status inbox. The app applies it on next launch / Notes-tab open.
#
# Usage:
#   bash scripts/push-status.sh <note-id> done --commit <sha> --note "how I fixed it"
#   bash scripts/push-status.sh <note-id> open            # reopen (preserves prior resolution)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # keep the device path intact through Git-Bash

[ $# -ge 2 ] || { echo "usage: push-status.sh <note-id> <done|open> [--commit <sha>] [--note <text>]" >&2; exit 1; }
ID="$1"; STATUS="$2"; shift 2
case "$STATUS" in done|open) ;; *) echo "status must be 'done' or 'open'" >&2; exit 1;; esac
COMMIT=""; NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) [ $# -ge 2 ] || { echo "--commit requires a value" >&2; exit 1; }; COMMIT="$2"; shift 2;;
    --note)   [ $# -ge 2 ] || { echo "--note requires a value" >&2; exit 1; };   NOTE="$2";   shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

PKG="dev.skaniti.compendium"
INBOX="/sdcard/Android/data/${PKG}/files/dev-notes/.status-inbox.jsonl"

ADB="${ADB:-$(command -v adb || true)}"
[ -z "$ADB" ] && ADB="/c/Users/${USERNAME:-$USER}/AppData/Local/Android/Sdk/platform-tools/adb"
"$ADB" version  >/dev/null 2>&1 || { echo "adb not runnable ($ADB). Put adb on PATH or set ADB=..." >&2; exit 1; }
"$ADB" get-state >/dev/null 2>&1 || { echo "No device connected (adb get-state failed). Plug in the phone or start wireless debugging." >&2; exit 1; }

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "python not found" >&2; exit 1; }
LINE=$("$PY" -c '
import json, sys, time
_id, status, commit, note = sys.argv[1:5]
obj = {"id": _id, "status": status}
if status == "done":
    obj["resolvedAt"] = int(time.time() * 1000)
    if commit: obj["resolvedCommit"] = commit
    if note:   obj["resolutionNote"] = note
print(json.dumps(obj))
' "$ID" "$STATUS" "$COMMIT" "$NOTE")

printf '%s\n' "$LINE" | "$ADB" shell "mkdir -p '${INBOX%/*}' && cat >> '$INBOX'"
echo "queued: $LINE"
echo "(applies on next app launch or when you open the Notes tab)"
