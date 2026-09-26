#!/usr/bin/env bash
# scripts/smoke.sh -- production smoke test for the Compendium API
# (apps/api), run directly against the API's own hostname (never through
# the Next.js proxy).
#
# Walks: login -> whoami -> graph -> diary windows -> agent stream (first
# SSE line, then abort) -> logout -> verify the session is really gone.
# Prints a start line per step, then either "PASS <step> (<ms> ms)" or
# "FAIL <step>: <reason>" with the HTTP status. The first failure aborts
# the run -- but if a session was already established (login succeeded),
# logout is still attempted before exiting, so a failed run never leaves
# a live refresh token behind.
#
# Usage:
#   SMOKE_EMAIL=<email> SMOKE_PASSWORD=<password> bash scripts/smoke.sh
#
# Env vars:
#   SMOKE_BASE_URL       API base URL.
#                         Default: https://compendium-api.skaniti.dev
#   SMOKE_EMAIL           Login email/username. Required -- exported by the
#                         caller's shell, never hardcoded here.
#   SMOKE_PASSWORD        Login password. Required, same rule as above.
#   SMOKE_STREAM_TIMEOUT  Seconds to wait for the first `data:` SSE line
#                         from /api/agent/query-stream. Default: 30.
#   SMOKE_QUESTION        The chat question sent to the stream step.
#                         Default: a short question about the compendium
#                         itself.
#   SMOKE_SKIP_STREAM     Set to 1 to skip the query-stream step entirely
#                         (it spends one LLM call otherwise). Default: 0.
#
# Exit codes:
#   2  usage/environment error (SMOKE_EMAIL/SMOKE_PASSWORD unset, or a
#      required tool -- curl/jq/mktemp -- is missing). Not one of the
#      seven numbered steps below; nothing has run yet.
#   1  step 1  POST /api/auth/login             failed
#   2  step 2  GET  /api/auth/me                 failed
#   3  step 3  GET  /api/graph                   failed
#   4  step 4  GET  /api/diary/windows           failed
#   5  step 5  POST /api/agent/query-stream      failed
#   6  step 6  POST /api/auth/logout             failed
#   7  step 7  post-logout session-gone check    failed
#   0  every step passed (or step 5 was skipped)
#
# The login endpoint is rate-limited (~5/minute, backend/api/main.py). This
# script logs in exactly once per invocation and never retries login in a
# loop -- re-run the whole script by hand if you need another attempt.
#
# Secrets discipline: SMOKE_PASSWORD, the access token, and the refresh
# token are never printed and never written anywhere except inside a
# mktemp -d directory that a trap removes on exit (success, failure, or
# signal). The API itself authenticates via a JSON access token in the
# response body, not cookies (confirmed by reading backend/api/main.py's
# login/me/logout handlers and backend/services/auth_service.py -- there
# is no Set-Cookie anywhere in this API); a curl cookie jar is still
# wired up on every request below for forward-compatibility and because
# it costs nothing, but the actual credential lives in the token files
# next to it, under the same trap-cleaned directory.

set -euo pipefail

SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://compendium-api.skaniti.dev}"
SMOKE_STREAM_TIMEOUT="${SMOKE_STREAM_TIMEOUT:-30}"
SMOKE_QUESTION="${SMOKE_QUESTION:-What is this compendium about?}"
SMOKE_SKIP_STREAM="${SMOKE_SKIP_STREAM:-0}"

if [[ -z "${SMOKE_EMAIL:-}" || -z "${SMOKE_PASSWORD:-}" ]]; then
  echo "usage: SMOKE_EMAIL=<email> SMOKE_PASSWORD=<password> [SMOKE_BASE_URL=...] bash scripts/smoke.sh" >&2
  exit 2
fi

for tool in curl jq mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "smoke.sh requires '$tool' on PATH" >&2
    exit 2
  fi
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

COOKIE_JAR="$WORKDIR/cookies.txt"
ACCESS_TOKEN_FILE="$WORKDIR/access_token"
REFRESH_TOKEN_FILE="$WORKDIR/refresh_token"
: > "$COOKIE_JAR"

SESSION_ESTABLISHED=0

# ---- helpers ---------------------------------------------------------------

# Minimal JSON string escaping for values we interpolate into request
# bodies (backslash and double-quote only -- SMOKE_EMAIL/SMOKE_PASSWORD/
# SMOKE_QUESTION are expected to be plain single-line strings).
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Millisecond wall-clock timestamp. `date +%s%3N` is a GNU-ism; fall back
# to whole seconds * 1000 on a date(1) that doesn't understand %N.
now_ms() {
  local t
  t="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$t" =~ ^[0-9]+$ ]]; then
    printf '%s' "$t"
  else
    printf '%s' "$(($(date +%s) * 1000))"
  fi
}

# http_request METHOD URL BODY_JSON_OR_EMPTY BEARER_TOKEN_OR_EMPTY OUTFILE
# Prints the HTTP status code on stdout; writes the response body to
# OUTFILE. Never lets curl's own exit status escape -- a transport-level
# failure (DNS, connection refused, TLS, timeout) normalizes to "000"
# instead of aborting the script, so callers can treat "000" as just
# another failing status code. curl itself already writes "000" via
# %{http_code} on most transport failures, so this does NOT also append
# a fallback "000" on top (that double-fires and produces "000000" --
# caught by testing against a closed port before this shipped); it only
# replaces whatever curl printed if that output isn't a clean 3-digit
# code.
http_request() {
  local method=$1 url=$2 body=$3 token=$4 outfile=$5
  local args=(-sS --max-time 30 -o "$outfile" -w '%{http_code}' -X "$method" "$url" -c "$COOKIE_JAR" -b "$COOKIE_JAR")
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local status
  status="$(curl "${args[@]}" 2>/dev/null)" || true
  if [[ ! "$status" =~ ^[0-9]{3}$ ]]; then
    status="000"
  fi
  printf '%s' "$status"
}

# Best-effort logout used both on the happy path (step 6) and as cleanup
# after an earlier failure. Never lets a cleanup failure mask the
# original failure's exit code -- callers pass that code through to us.
run_logout() {
  local out="$1"
  local rt
  rt="$(cat "$REFRESH_TOKEN_FILE" 2>/dev/null || true)"
  if [[ -z "$rt" ]]; then
    return 1
  fi
  local body
  body="{\"refresh_token\":\"$(json_escape "$rt")\"}"
  http_request POST "$SMOKE_BASE_URL/api/auth/logout" "$body" "" "$out"
}

# Attempt logout (only if a session exists) then exit with the ORIGINAL
# failing step's code -- logout's own outcome here is cleanup, not the
# reason for the non-zero exit.
attempt_logout_and_exit() {
  local code=$1
  if [[ "$SESSION_ESTABLISHED" == "1" ]]; then
    echo "step 6: POST /api/auth/logout (cleanup after the step $code failure above)"
    local out="$WORKDIR/logout-cleanup.json"
    local status
    status="$(run_logout "$out")" || status="000"
    if [[ "$status" == "200" ]]; then
      echo "PASS step 6 (cleanup logout ok)"
    else
      echo "FAIL step 6: cleanup logout returned HTTP $status" >&2
    fi
  fi
  exit "$code"
}

echo "smoke: base_url=$SMOKE_BASE_URL stream=$([[ "$SMOKE_SKIP_STREAM" == "1" ]] && echo skip || echo "timeout=${SMOKE_STREAM_TIMEOUT}s")"

# ---- step 1: login ----------------------------------------------------------

echo "step 1: POST /api/auth/login"
T0=$(now_ms)
LOGIN_BODY="{\"email\":\"$(json_escape "$SMOKE_EMAIL")\",\"password\":\"$(json_escape "$SMOKE_PASSWORD")\"}"
LOGIN_OUT="$WORKDIR/login.json"
STATUS="$(http_request POST "$SMOKE_BASE_URL/api/auth/login" "$LOGIN_BODY" "" "$LOGIN_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "200" ]]; then
  echo "FAIL step 1: POST /api/auth/login returned HTTP $STATUS" >&2
  exit 1
fi
ACCESS_TOKEN="$(jq -r '.access_token // empty' "$LOGIN_OUT" 2>/dev/null || true)"
REFRESH_TOKEN="$(jq -r '.refresh_token // empty' "$LOGIN_OUT" 2>/dev/null || true)"
if [[ -z "$ACCESS_TOKEN" || -z "$REFRESH_TOKEN" ]]; then
  echo "FAIL step 1: HTTP 200 but the response had no access_token/refresh_token" >&2
  exit 1
fi
printf '%s' "$ACCESS_TOKEN" > "$ACCESS_TOKEN_FILE"
printf '%s' "$REFRESH_TOKEN" > "$REFRESH_TOKEN_FILE"
chmod 600 "$ACCESS_TOKEN_FILE" "$REFRESH_TOKEN_FILE"
SESSION_ESTABLISHED=1
echo "PASS step 1 ($((T1 - T0)) ms)"

# ---- step 2: whoami ---------------------------------------------------------

echo "step 2: GET /api/auth/me"
T0=$(now_ms)
ME_OUT="$WORKDIR/me.json"
STATUS="$(http_request GET "$SMOKE_BASE_URL/api/auth/me" "" "$ACCESS_TOKEN" "$ME_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "200" ]]; then
  echo "FAIL step 2: GET /api/auth/me returned HTTP $STATUS" >&2
  attempt_logout_and_exit 2
fi
echo "PASS step 2 ($((T1 - T0)) ms)"

# ---- step 3: graph -----------------------------------------------------------

echo "step 3: GET /api/graph"
T0=$(now_ms)
GRAPH_OUT="$WORKDIR/graph.json"
STATUS="$(http_request GET "$SMOKE_BASE_URL/api/graph" "" "$ACCESS_TOKEN" "$GRAPH_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "200" ]]; then
  echo "FAIL step 3: GET /api/graph returned HTTP $STATUS" >&2
  attempt_logout_and_exit 3
fi
NODE_COUNT="$(jq -r '(.nodes | length)' "$GRAPH_OUT" 2>/dev/null || echo 0)"
if ! [[ "$NODE_COUNT" =~ ^[0-9]+$ ]] || [[ "$NODE_COUNT" -le 0 ]]; then
  echo "FAIL step 3: /api/graph returned $NODE_COUNT nodes (expected > 0)" >&2
  attempt_logout_and_exit 3
fi
echo "PASS step 3 ($((T1 - T0)) ms, $NODE_COUNT nodes)"

# ---- step 4: diary windows ---------------------------------------------------

echo "step 4: GET /api/diary/windows"
T0=$(now_ms)
DIARY_OUT="$WORKDIR/diary.json"
STATUS="$(http_request GET "$SMOKE_BASE_URL/api/diary/windows" "" "$ACCESS_TOKEN" "$DIARY_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "200" ]]; then
  echo "FAIL step 4: GET /api/diary/windows returned HTTP $STATUS" >&2
  attempt_logout_and_exit 4
fi
if ! jq -e 'type == "array"' "$DIARY_OUT" >/dev/null 2>&1; then
  echo "FAIL step 4: /api/diary/windows did not return a JSON array" >&2
  attempt_logout_and_exit 4
fi
echo "PASS step 4 ($((T1 - T0)) ms)"

# ---- step 5: agent chat stream ------------------------------------------------

if [[ "$SMOKE_SKIP_STREAM" == "1" ]]; then
  echo "step 5: POST /api/agent/query-stream -- SKIPPED (SMOKE_SKIP_STREAM=1)"
else
  echo "step 5: POST /api/agent/query-stream"
  T0=$(now_ms)
  STREAM_OUT="$WORKDIR/stream.out"
  STREAM_ERR="$WORKDIR/stream.err"
  : > "$STREAM_OUT"
  QUERY_BODY="{\"query\":\"$(json_escape "$SMOKE_QUESTION")\"}"

  # Backgrounded directly (no subshell) so $! is curl's own PID.
  # --max-time is a hard backstop in case the poll/kill loop below can't
  # reach the process for any reason; the poll loop is what actually
  # implements "wait up to N seconds for the first `data:` line, then
  # abort" -- it kills curl the moment that line shows up rather than
  # waiting for the whole SSE response (tokens + complete event) to
  # finish.
  curl -sS -N --no-buffer --max-time "$((SMOKE_STREAM_TIMEOUT + 5))" \
    -X POST "$SMOKE_BASE_URL/api/agent/query-stream" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$QUERY_BODY" \
    >> "$STREAM_OUT" 2>> "$STREAM_ERR" &
  STREAM_PID=$!

  FOUND=0
  ITERS=$((SMOKE_STREAM_TIMEOUT * 5))
  i=0
  while ((i < ITERS)); do
    if grep -q '^data:' "$STREAM_OUT" 2>/dev/null; then
      FOUND=1
      break
    fi
    if ! kill -0 "$STREAM_PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
    i=$((i + 1))
  done

  kill "$STREAM_PID" 2>/dev/null || true
  wait "$STREAM_PID" 2>/dev/null || true

  T1=$(now_ms)
  if [[ "$FOUND" != "1" ]]; then
    echo "FAIL step 5: no 'data:' line within ${SMOKE_STREAM_TIMEOUT}s" >&2
    attempt_logout_and_exit 5
  fi
  echo "PASS step 5 ($((T1 - T0)) ms)"
fi

# ---- step 6: logout -----------------------------------------------------------

echo "step 6: POST /api/auth/logout"
T0=$(now_ms)
LOGOUT_OUT="$WORKDIR/logout.json"
STATUS="$(run_logout "$LOGOUT_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "200" ]]; then
  echo "FAIL step 6: POST /api/auth/logout returned HTTP $STATUS" >&2
  exit 6
fi
echo "PASS step 6 ($((T1 - T0)) ms)"

# ---- step 7: verify the session is gone ---------------------------------------

# NOTE on what "session is gone" means here: access tokens are stateless
# signed JWTs (backend/services/auth_service.py::decode_access_token),
# verified purely by signature + `exp` -- logout only revokes the REFRESH
# token (auth_service.revoke_refresh_token / rotate_refresh_token's
# already-revoked branch). There is no code path anywhere in this API
# that blacklists an access token, so GET /api/auth/me with the
# pre-logout access token keeps returning 200 until that token's own
# short TTL (settings.jwt_access_token_expire_minutes, 15 minutes by
# default) elapses on its own -- confirmed by reading
# decode_access_token/verify_api_key and by there being no test anywhere
# in the suite asserting otherwise (see task-5-report.md). The gating
# check below is therefore the behaviorally correct "session is gone"
# signal: the just-revoked refresh token can no longer mint a new
# session (POST /api/auth/refresh 401s on it). An informational (non-
# gating) probe of the old access token is also printed so a reader can
# see the stateless-JWT behavior directly instead of just trusting this
# comment.

echo "step 7: verify session revoked"
T0=$(now_ms)

ME_AFTER_OUT="$WORKDIR/me-after-logout.json"
ME_AFTER_STATUS="$(http_request GET "$SMOKE_BASE_URL/api/auth/me" "" "$ACCESS_TOKEN" "$ME_AFTER_OUT")"
echo "  info: GET /api/auth/me with the pre-logout access token -> HTTP $ME_AFTER_STATUS (expected 200 until its own TTL elapses -- access tokens are not revoked at logout, see NOTE above; not part of the pass/fail gate)"

REFRESH_CHECK_OUT="$WORKDIR/refresh-check.json"
REFRESH_CHECK_BODY="{\"refresh_token\":\"$(json_escape "$REFRESH_TOKEN")\"}"
STATUS="$(http_request POST "$SMOKE_BASE_URL/api/auth/refresh" "$REFRESH_CHECK_BODY" "" "$REFRESH_CHECK_OUT")"
T1=$(now_ms)
if [[ "$STATUS" != "401" ]]; then
  echo "FAIL step 7: the revoked refresh token can still mint a new session (POST /api/auth/refresh returned HTTP $STATUS, expected 401)" >&2
  exit 7
fi
echo "PASS step 7 ($((T1 - T0)) ms)"

echo "SUMMARY: all smoke checks passed against $SMOKE_BASE_URL"
