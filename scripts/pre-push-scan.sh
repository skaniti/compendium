#!/usr/bin/env bash
# Pre-push scan: gitleaks over the outgoing commits + a tracked-file grep for
# private plan-doc path citations + the personal-identifier grep matrix.
# Fails CLOSED: a missing scanner or a missing terms file refuses the push.
#
# Modes:
#   scripts/pre-push-scan.sh --hook            git pre-push stdin protocol
#   scripts/pre-push-scan.sh --check [TIP [BASE]]
#       dry run against TIP (default HEAD); commits scanned = BASE..TIP, or
#       every commit of TIP not already on a remote when BASE is omitted.
#
# Env:
#   GITLEAKS_BIN     gitleaks binary (default: PATH, then $GOBIN, $GOPATH/bin, ~/go/bin)
#   SCAN_TERMS_FILE  identifier-matrix terms, one ERE per line, # comments
#                    (default .claude/identifier-terms.local.md; untracked,
#                    because the terms are themselves personal identifiers)
#
# Recipe source: the 08a publish-flip evidence gate (gitleaks `git` history
# scan from the repo root so .gitleaksignore fingerprints match; D3-B plan-path
# grep; identifier grep matrix).
set -u

root=$(git rev-parse --show-toplevel) || { echo 'pre-push-scan: not in a git repo' >&2; exit 1; }
# Resolve caller-relative overrides before moving to the repo root.
abspath() { case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
[ -n "${GITLEAKS_BIN:-}" ] && GITLEAKS_BIN=$(abspath "$GITLEAKS_BIN")
[ -n "${SCAN_TERMS_FILE:-}" ] && SCAN_TERMS_FILE=$(abspath "$SCAN_TERMS_FILE")
cd "$root" || exit 1
zero=0000000000000000000000000000000000000000
terms_file=${SCAN_TERMS_FILE:-.claude/identifier-terms.local.md}
fail=0
pat=
trap '[ -n "$pat" ] && rm -f "$pat"' EXIT
# The plan-path literal is assembled at runtime so this file does not match
# its own grep (the gate must pass on the commit that adds it).
plan_lit="docs/project-""plans"

find_gitleaks() {
  if [ -n "${GITLEAKS_BIN:-}" ]; then
    [ -x "$GITLEAKS_BIN" ] && printf '%s\n' "$GITLEAKS_BIN"
    return
  fi
  command -v gitleaks 2>/dev/null && return
  local d
  for d in "${GOBIN:-}" "${GOPATH:-$HOME/go}/bin" "$HOME/go/bin"; do
    [ -n "$d" ] && [ -x "$d/gitleaks" ] && { printf '%s\n' "$d/gitleaks"; return; }
  done
}

# scan_tip TIP BASE  (BASE may be empty)
scan_tip() {
  local tip=$1 base=$2 range gl n
  if [ -n "$base" ] && [ "$base" != "$zero" ]; then range="$base..$tip"; else range="$tip --not --remotes"; fi
  echo "pre-push-scan: start tip=$(git rev-parse --short "$tip") range=[$range]"

  # (a) gitleaks over the outgoing commits
  gl=$(find_gitleaks || true)
  if [ -z "$gl" ]; then
    echo 'pre-push-scan: gitleaks not found (PATH, $GOBIN, ~/go/bin). Refusing: install it (go install github.com/zricethezav/gitleaks/v8@latest) or set GITLEAKS_BIN.' >&2
    fail=1
  else
    "$gl" git --no-banner --redact --log-opts "$range" . >&2 </dev/null
    case $? in
      0) echo 'pre-push-scan: gitleaks clean' ;;
      1) echo 'pre-push-scan: gitleaks FINDINGS (above)' >&2; fail=1 ;;
      *) echo 'pre-push-scan: gitleaks failed to run' >&2; fail=1 ;;
    esac
  fi

  # (b) private plan-path citations in tracked non-doc files at the tip (08a D3-B)
  if n=$(git grep -nI -e "$plan_lit" "$tip" -- . ':!docs' ':!.claude' ':!.gitignore' ':!README.md' </dev/null); then
    printf '%s\n' "$n" >&2
    echo 'pre-push-scan: private plan-path citation(s) above' >&2; fail=1
  else
    [ $? -eq 1 ] && echo 'pre-push-scan: plan-path grep clean' || { echo 'pre-push-scan: plan-path grep failed to run' >&2; fail=1; }
  fi

  # (c) identifier grep matrix (terms live in an untracked file)
  if [ ! -s "$terms_file" ]; then
    echo "pre-push-scan: identifier terms file missing or empty: $terms_file. Refusing (fail closed). Format: one ERE per line, # comments; see the script header." >&2
    fail=1
  else
    pat=$(mktemp) || { fail=1; return; }
    grep -vE '^[[:space:]]*(#|$)' "$terms_file" > "$pat"
    if [ ! -s "$pat" ]; then
      echo "pre-push-scan: identifier terms file has no terms (comments only): $terms_file. Refusing (fail closed). Format: one ERE per line, # comments; see the script header." >&2
      fail=1
      return
    fi
    # Suppressions, matching the 08a grep-matrix record (three benign hits):
    #  - `scan-ok: test-ip` lines ONLY in apps/api/tests/test_url_guard.py
    #    (SSRF-guard private-IP fixture, 08a results: grep matrix row 1)
    #  - apps/web/demo/tools/build-fixtures.mjs lines 20 and 655 ONLY (the
    #    hygiene-gate term list and its grep call, 08a rows 2-3). If those
    #    lines move, the scan refuses and the pin must be updated with a
    #    fresh justification.
    n=$(git grep -nIE -f "$pat" "$tip" -- . ':!*.png' ':!*.jpg' ':!*.ttf' </dev/null \
        | grep -vE "^$tip:apps/api/tests/test_url_guard\.py:[0-9]+:.*scan-ok: test-ip" \
        | grep -vE "^$tip:apps/web/demo/tools/build-fixtures\.mjs:(20|655):")
    if [ -n "$n" ]; then
      printf '%s\n' "$n" >&2
      echo 'pre-push-scan: identifier matrix hit(s) above' >&2; fail=1
    else
      echo 'pre-push-scan: identifier grep clean'
    fi
  fi
}

case "${1:-}" in
  --check) scan_tip "${2:-HEAD}" "${3:-}" ;;
  --hook)
    seen=0
    while read -r lref lsha rref rsha; do
      [ -z "${lsha:-}" ] && continue
      [ "$lsha" = "$zero" ] && continue   # branch deletion: nothing to scan
      seen=1
      scan_tip "$lsha" "$rsha"
    done
    [ "$seen" -eq 0 ] && echo 'pre-push-scan: nothing to scan'
    ;;
  *) echo 'usage: pre-push-scan.sh --hook | --check [TIP [BASE]]' >&2; exit 2 ;;
esac

if [ "$fail" -ne 0 ]; then echo 'pre-push-scan: REFUSED' >&2; exit 1; fi
echo 'pre-push-scan: OK'
