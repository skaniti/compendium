#!/bin/bash
#
# section-14-baseline.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 14
# Captures a born-on-date hardware + performance snapshot to serve as the
# comparison baseline for quarterly re-runs (section 22 maintenance cadence).
#
# PREREQUISITE: assumes the system disk is /dev/nvme0n1 (correct for the
# IdeaPad 720S this server runs on). The SMART snapshot and fio targets are
# hardcoded to /dev/nvme0n1; on different hardware, update those references
# before running (grep nvme0n1 in this file -- ~5 sites).
#
# Run from server. Estimated time: ~8-10 min (dominated by 5-min CPU stress).
# Writes a markdown report to ~/server-setup-logs/14-baseline-<timestamp>.md.
# Tees a stdout execution trace to ~/server-setup-logs/14-baseline-<timestamp>.log.
# Prints a paste-friendly summary block at the end for sharing in chat.
#
# Idempotent: each run writes a new timestamped report.

set -euo pipefail

# --- Setup ---
OUTDIR="$HOME/server-setup-logs"
mkdir -p "$OUTDIR"
TS="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUTDIR/14-baseline-$TS.md"
LOGFILE="$OUTDIR/14-baseline-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-14-baseline.sh  start: $TS"
echo "host:     $(hostname)"
echo "report:   $REPORT"
echo "log:      $LOGFILE"
echo "duration: ~8-10 min (5-min CPU stress + fio + iperf3 + assorted)"
echo "=========================================="

# Cache sudo creds up front so subsequent sudos don't re-prompt
sudo -v

# --- 14.1: Install benchmark tools ---
echo ""
echo "--- 14.1: install benchmark tools (idempotent) ---"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  inxi smartmontools stress-ng lm-sensors fio iperf3 sysbench >/dev/null
echo "Tools installed."

# --- Build the markdown report ---
echo ""
echo "--- generating baseline report ---"

# Header
{
  echo "# Server baseline snapshot: $(hostname)"
  echo ""
  echo "**Generated:** $(date)"
  echo "**Host:** $(hostname)"
  echo "**Kernel:** $(uname -r)"
  echo "**Distro:** $(lsb_release -d 2>/dev/null | cut -f2 || echo 'unknown')"
  echo "**Uptime at capture:** $(uptime -p)"
  echo ""
  echo "Captures baseline thermal, disk, CPU, and network characteristics for comparison against future quarterly re-runs (plan section 22). Re-run via \`bash section-14-baseline.sh\` and diff against this file."
  echo ""
} > "$REPORT"

# --- Hardware inventory ---
echo "  - inxi hardware/software inventory..."
{
  echo "## Hardware + software inventory"
  echo ""
  echo '```'
  inxi -Fxxxz 2>&1 | grep -v "Smartctl open device" || true
  echo '```'
  echo ""
} >> "$REPORT"

# --- Disk SMART ---
echo "  - smartctl NVMe SMART..."
{
  echo "## Disk SMART (/dev/nvme0n1)"
  echo ""
  echo '```'
  sudo smartctl -a /dev/nvme0n1
  echo '```'
  echo ""
} >> "$REPORT"

# --- Idle thermals ---
echo "  - idle thermals..."
IDLE_TEMPS=$(sensors 2>/dev/null | grep -E "Package|Core")
{
  echo "## Thermal sensors (idle, pre-stress)"
  echo ""
  echo '```'
  sensors
  echo '```'
  echo ""
} >> "$REPORT"

# --- CPU stress with thermal sampling ---
echo "  - CPU stress test 5 min (this is the long phase)..."
{
  echo "## CPU stress test (stress-ng 5 min, all logical cores)"
  echo ""
  echo "**Pre-stress thermals:**"
  echo '```'
  sensors | grep -E "Package|Core"
  echo '```'
  echo ""
} >> "$REPORT"

stress-ng --cpu "$(nproc)" --timeout 5m --quiet &
STRESS_PID=$!

# Sample 2.5 min in
sleep 150
MID_TEMPS=$(sensors | grep -E "Package|Core")
{
  echo "**Mid-stress thermals (~2.5 min in, thermal equilibrium expected):**"
  echo '```'
  sensors | grep -E "Package|Core"
  echo '```'
  echo ""
} >> "$REPORT"

wait "$STRESS_PID"

# Post-stress (immediate)
POST_TEMPS=$(sensors | grep -E "Package|Core")
{
  echo "**Post-stress thermals (immediately after stress-ng exit):**"
  echo '```'
  sensors | grep -E "Package|Core"
  echo '```'
  echo ""
} >> "$REPORT"

# --- Disk I/O bench (fio) ---
FIO_TEST_FILE="$HOME/.fio-test"
echo "  - fio random read (1 GiB, 4k, 30 sec)..."
FIO_RANDREAD_OUT=$(fio --name=randread --size=1G --rw=randread --bs=4k \
  --ioengine=libaio --direct=1 --runtime=30 --time_based --group_reporting \
  --filename="$FIO_TEST_FILE" 2>&1 || echo "fio randread failed")
{
  echo "## Disk I/O (fio against $FIO_TEST_FILE, direct=1 bypassing OS cache)"
  echo ""
  echo "### Random read (4k blocks, 30 sec time-based)"
  echo '```'
  echo "$FIO_RANDREAD_OUT" | grep -E "(read:|IOPS|bw=|lat \()" | head -10
  echo '```'
  echo ""
} >> "$REPORT"

echo "  - fio sequential read (1 GiB, 1M, 30 sec)..."
FIO_SEQREAD_OUT=$(fio --name=seqread --size=1G --rw=read --bs=1M \
  --ioengine=libaio --direct=1 --runtime=30 --time_based --group_reporting \
  --filename="$FIO_TEST_FILE" 2>&1 || echo "fio seqread failed")
{
  echo "### Sequential read (1M blocks, 30 sec time-based)"
  echo '```'
  echo "$FIO_SEQREAD_OUT" | grep -E "(read:|IOPS|bw=|lat \()" | head -10
  echo '```'
  echo ""
} >> "$REPORT"

rm -f "$FIO_TEST_FILE"

# --- Network bench (iperf3) ---
echo "  - iperf3 network test (download + upload, 10 sec each)..."
IPERF_DL_OUT=$(timeout 30 iperf3 -c iperf3.he.net -p 5201 -t 10 -R 2>&1 || echo "iperf3 download test failed (public server may be unavailable)")
IPERF_UL_OUT=$(timeout 30 iperf3 -c iperf3.he.net -p 5201 -t 10 2>&1 || echo "iperf3 upload test failed (public server may be unavailable)")
{
  echo "## Network bandwidth (iperf3 against iperf3.he.net Fremont CA)"
  echo ""
  echo "### Download (server-to-client)"
  echo '```'
  echo "$IPERF_DL_OUT" | tail -20
  echo '```'
  echo ""
  echo "### Upload (client-to-server)"
  echo '```'
  echo "$IPERF_UL_OUT" | tail -20
  echo '```'
  echo ""
} >> "$REPORT"

# --- Memory + disk space ---
echo "  - memory + disk space..."
{
  echo "## Memory"
  echo ""
  echo '```'
  free -h
  echo '```'
  echo ""

  echo "## Disk space"
  echo ""
  echo '```'
  df -h / /home /var 2>/dev/null | head -10
  echo '```'
  echo ""

  echo "---"
  echo ""
  echo "*Generated by \`scripts/server-setup/section-14-baseline.sh\` at $TS.*"
} >> "$REPORT"

# --- Extract paste-ready summary ---
echo ""
echo "=========================================="
echo "DONE -- baseline report at: $REPORT"
echo "$(wc -l < "$REPORT") lines, $(stat -c%s "$REPORT") bytes"
echo "=========================================="
echo ""

# Pull out summary numbers from the data we captured
IDLE_PKG=$(echo "$IDLE_TEMPS" | grep "Package id 0" | grep -oE "\+[0-9.]+" | head -1)
PEAK_PKG=$(echo "$MID_TEMPS" | grep "Package id 0" | grep -oE "\+[0-9.]+" | head -1)
POST_PKG=$(echo "$POST_TEMPS" | grep "Package id 0" | grep -oE "\+[0-9.]+" | head -1)

SMART_HEALTH=$(sudo smartctl -H /dev/nvme0n1 2>&1 | grep "overall-health" | awk '{print $NF}')
SMART_WEAR=$(sudo smartctl -a /dev/nvme0n1 2>&1 | grep "Percentage Used" | grep -oE "[0-9]+%")
SMART_SPARE=$(sudo smartctl -a /dev/nvme0n1 2>&1 | grep "Available Spare:" | grep -oE "[0-9]+%" | head -1)

FIO_RAND_BW=$(echo "$FIO_RANDREAD_OUT" | grep -oE "bw=[^ ]+" | head -1)
FIO_SEQ_BW=$(echo "$FIO_SEQREAD_OUT" | grep -oE "bw=[^ ]+" | head -1)

IPERF_DL_BW=$(echo "$IPERF_DL_OUT" | grep "receiver" | grep -oE "[0-9.]+ [GM]bits/sec" | tail -1)
IPERF_UL_BW=$(echo "$IPERF_UL_OUT" | grep "sender" | grep -oE "[0-9.]+ [GM]bits/sec" | tail -1)

MEM_INFO=$(free -h | awk '/^Mem:/ {print $7 " free of " $2}')
DISK_INFO=$(df -h / | awk 'NR==2 {print $4 " free of " $2}')

echo "### PASTE-READY SUMMARY ###"
echo ""
echo "host:           $(hostname)"
echo "captured:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "kernel:         $(uname -r)"
echo ""
echo "thermal idle:   ${IDLE_PKG:-(parse failed)} (Package id 0)"
echo "thermal mid:    ${PEAK_PKG:-(parse failed)} (Package id 0, ~2.5 min into stress)"
echo "thermal post:   ${POST_PKG:-(parse failed)} (Package id 0, immediately after stress)"
echo ""
echo "SMART:          ${SMART_HEALTH:-(unknown)} | wear ${SMART_WEAR:-?} | spare ${SMART_SPARE:-?}"
echo ""
echo "fio randread:   ${FIO_RAND_BW:-(parse failed)}"
echo "fio seqread:    ${FIO_SEQ_BW:-(parse failed)}"
echo ""
echo "iperf3 down:    ${IPERF_DL_BW:-(failed or unavailable)}"
echo "iperf3 up:      ${IPERF_UL_BW:-(failed or unavailable)}"
echo ""
echo "memory:         ${MEM_INFO}"
echo "disk (/):       ${DISK_INFO}"
echo ""
echo "report path:    $REPORT"
echo "### END SUMMARY ###"
echo ""
echo "Per plan 14.3 DECISION: report is in ~/server-setup-logs/. Move to private ops repo (recommended) or docs/server/ when ready."
