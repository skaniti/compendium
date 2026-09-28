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
cd "$root" || exit 1
zero=0000000000000000000000000000000000000000
terms_file=${SCAN_TERMS_FILE:-.claude/identifier-terms.local.md}
fail=0

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
    "$gl" git --no-banner --redact --log-opts "$range" . >&2
    case $? in
      0) echo 'pre-push-scan: gitleaks clean' ;;
      1) echo 'pre-push-scan: gitleaks FINDINGS (above)' >&2; fail=1 ;;
      *) echo 'pre-push-scan: gitleaks failed to run' >&2; fail=1 ;;
    esac
  fi

  # (b) private plan-path citations in tracked non-doc files at the tip (08a D3-B)
  if n=$(git grep -nI 'docs/project-plans' "$tip" -- . ':!docs' ':!.claude' ':!.gitignore' ':!README.md'); then
    printf '%s\n' "$n" >&2
    echo 'pre-push-scan: private plan-path citation(s) above' >&2; fail=1
  else
    [ $? -eq 1 ] && echo 'pre-push-scan: plan-path grep clean' || { echo 'pre-push-scan: plan-path grep failed to run' >&2; fail=1; }
  fi

  # (c) identifier grep matrix (terms live in an untracked file)
  if [ ! -s "$terms_file" ]; then
    echo "pre-push-scan: identifier terms file missing or empty: $terms_file. Refusing (fail closed)." >&2
    fail=1
  else
    local pat rc
    pat=$(mktemp) || { fail=1; return; }
    grep -vE '^[[:space:]]*(#|$)' "$terms_file" > "$pat"
    n=$(git grep -nIE -f "$pat" "$tip" -- . ':!*.png' ':!*.jpg' ':!*.ttf' \
        | grep -v 'scan-ok: test-ip' \
        | grep -vE "^$tip:apps/web/demo/tools/build-fixtures\.mjs:") ; rc=$?
    rm -f "$pat"
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
