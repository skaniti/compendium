#!/usr/bin/env bash
# Watch the Android collector's task in the phone's recent-apps list and capture
# diagnostics whenever it changes: the task leaves recents, its task id changes
# (old task removed, new one created), or the app's main process dies.
#
# The phone keeps only minutes of activity-manager events, so this polls and
# snapshots at the moment of change. Each snapshot goes to
# logs/recents-watch/<timestamp>-<reason>/ (events buffer, recents, activities,
# process exit history, main/system/crash logcat). The run log is
# logs/<timestamp>-recents-watch.log, with logs/recents-watch.latest.log
# pointing at it.
#
# Usage:  bash scripts/watch-recents.sh            (Ctrl-C to stop)
# Env:    ADB=/path/to/adb  POLL_SECONDS=15  HEARTBEAT_POLLS=20
set -uo pipefail

PKG="dev.skaniti.compendium"
POLL_SECONDS="${POLL_SECONDS:-15}"
HEARTBEAT_POLLS="${HEARTBEAT_POLLS:-20}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOG_DIR="$REPO/logs"
SNAP_ROOT="$LOG_DIR/recents-watch"

ADB="${ADB:-$(command -v adb || true)}"
[ -z "$ADB" ] && [ -x "$HOME/Android/Sdk/platform-tools/adb" ] && ADB="$HOME/Android/Sdk/platform-tools/adb"
if [ -z "$ADB" ] || ! "$ADB" version >/dev/null 2>&1; then
  echo "adb not runnable. Put adb on PATH or run: ADB=/path/to/adb bash scripts/watch-recents.sh" >&2
  exit 1
fi

mkdir -p "$SNAP_ROOT"
RUN_TS="$(date +%Y-%m-%d-%H%M%S)"
RUN_LOG="$LOG_DIR/$RUN_TS-recents-watch.log"
ln -sfn "$RUN_TS-recents-watch.log" "$LOG_DIR/recents-watch.latest.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$RUN_LOG"; }

# "<task id> <main pid>"; "-" for whichever is absent. Empty when the phone is unreachable.
probe() {
  "$ADB" get-state >/dev/null 2>&1 || return 1
  local task pid
  task="$("$ADB" shell dumpsys activity recents 2>/dev/null \
    | grep -E "Recent #[0-9]+: Task\{.*:$PKG\}" | head -1 | sed -E 's/.* #([0-9]+) .*/\1/')"
  pid="$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
  echo "${task:--} ${pid:--}"
}

snapshot() {
  local dir="$SNAP_ROOT/$(date +%Y-%m-%d-%H%M%S)-$1"
  mkdir -p "$dir"
  "$ADB" logcat -d -b events                > "$dir/events.txt" 2>&1
  "$ADB" logcat -d -b main,system,crash     > "$dir/logcat.txt" 2>&1
  "$ADB" shell dumpsys activity recents     > "$dir/recents.txt" 2>&1
  "$ADB" shell dumpsys activity activities  > "$dir/activities.txt" 2>&1
  "$ADB" shell dumpsys activity exit-info "$PKG" > "$dir/exit-info.txt" 2>&1
  log "  snapshot -> ${dir#$REPO/}"
}

log "watching $PKG in recents every ${POLL_SECONDS}s (log: ${RUN_LOG#$REPO/})"
prev=""; offline=0; polls=0
while true; do
  if ! cur="$(probe)"; then
    [ "$offline" -eq 0 ] && log "phone unreachable over adb; still polling"
    offline=1
  else
    [ "$offline" -eq 1 ] && log "phone reachable again"
    offline=0
    read -r task pid <<<"$cur"
    if [ -z "$prev" ]; then
      log "start: task=$task pid=$pid"
    elif [ "$cur" != "$prev" ]; then
      read -r ptask ppid <<<"$prev"
      reason=""
      [ "$ptask" != "-" ] && [ "$task" = "-" ] && reason="task-left-recents"
      [ -z "$reason" ] && [ "$ptask" != "-" ] && [ "$task" != "$ptask" ] && reason="task-replaced"
      [ -z "$reason" ] && [ "$ppid" != "-" ] && [ "$pid" != "$ppid" ] && reason="process-died"
      log "change: task $ptask -> $task, pid $ppid -> $pid${reason:+ ($reason)}"
      [ -n "$reason" ] && snapshot "$reason"
    fi
    prev="$cur"
  fi
  polls=$((polls + 1))
  [ $((polls % HEARTBEAT_POLLS)) -eq 0 ] && log "alive: ${polls} polls, last task=${prev%% *} pid=${prev##* }"
  sleep "$POLL_SECONDS"
done
