#!/usr/bin/env bash
# Pull the Android collector's dev-notes (notes.json + screenshots) to the laptop.
#
# Uses exec-out|tar to sidestep Git-Bash/MSYS path conversion: the device path
# stays inside a quoted device-side shell, bash handles the POSIX host
# destination, and adb.exe never sees a host path to mangle.
#
# Usage:  bash scripts/pull-notes.sh
# Override adb:  ADB=/path/to/adb bash scripts/pull-notes.sh
set -euo pipefail

PKG="dev.skaniti.compendium"
DEVICE_DIR="/sdcard/Android/data/${PKG}/files"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dev-notes"

# Locate adb: explicit ADB override, then PATH, then the default Windows SDK path.
ADB="${ADB:-$(command -v adb || true)}"
[ -z "$ADB" ] && ADB="/c/Users/${USERNAME:-$USER}/AppData/Local/Android/Sdk/platform-tools/adb"
if ! "$ADB" version >/dev/null 2>&1; then
  echo "adb not runnable ($ADB). Put adb on PATH or run: ADB=/path/to/adb bash scripts/pull-notes.sh" >&2
  exit 1
fi

if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "No device connected (adb get-state failed). Plug in the phone or start wireless debugging." >&2
  exit 1
fi

mkdir -p "$DEST"
echo "Pulling dev-notes from $PKG ..."
"$ADB" exec-out "cd '$DEVICE_DIR' && tar -c dev-notes 2>/dev/null" | tar -x -C "$(dirname "$DEST")"

NOTES_JSON="$DEST/notes.json"
if [ -f "$NOTES_JSON" ]; then
  COUNT=$(grep -o '"id"' "$NOTES_JSON" | wc -l | tr -d ' ')
  SHOTS=$(find "$DEST" -name '*.png' | wc -l | tr -d ' ')
  echo "Pulled $COUNT note(s) and $SHOTS screenshot(s) to $DEST"
  echo "----- notes.json -----"
  cat "$NOTES_JSON"
else
  echo "No notes found (notes.json absent) at $DEST"
fi
