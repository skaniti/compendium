#!/usr/bin/env bash
# scripts/setup-env.sh -- write the Docker stack's .env from .env.example.
#
# A shortcut for step 1 of "Full-stack (Docker)" in README.md: it asks for
# your login and OpenAI key, generates the two random secrets, and writes
# .env next to docker-compose.yml. The hand-edit path in the README works
# the same way and stays the primary instructions.
#
# Usage:
#   bash scripts/setup-env.sh
#   BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD=... OPENAI_API_KEY=... \
#     bash scripts/setup-env.sh        # no prompts
#
# .env.example is the template, read on every run, so the two cannot drift:
# every uncommented `KEY=` line with an empty value is a required key, and
# every comment is copied across unchanged. JWT_SECRET_KEY and
# SESSION_INGRESS_TRUSTED_VALUE are generated here (openssl rand -hex 32,
# or /dev/urandom when openssl is missing). Any other required key comes
# from an environment variable of the same name, or from a prompt on stdin
# (hidden when stdin is a terminal).
#
# It never overwrites: if .env already exists it stops and changes nothing.
# It never prints the password, the API key or the generated secrets.
#
# bash only (macOS, Linux, WSL). Native Windows without WSL is not
# supported; follow the hand-edit steps in the README there.
#
# Options:
#   --example FILE   template to read (default: <repo>/.env.example)
#   --output FILE    file to write   (default: <repo>/.env)
#   -h, --help       this text
#
# Exit codes: 0 written; 1 refused (the output file exists); 2 bad input,
# no input, or an unusable template (nothing written).

set -u
# A write that exceeds a file-size limit (quota, ulimit -f) should come back as
# an ordinary write error that is reported, not kill the script mid-write.
trap '' XFSZ

PROG=setup-env
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXAMPLE="$ROOT/.env.example"
OUT="$ROOT/.env"
# Required keys this script generates itself rather than asking for.
GENERATED=" JWT_SECRET_KEY SESSION_INGRESS_TRUSTED_VALUE "

re_required='^([A-Za-z_][A-Za-z0-9_]*)=$'
re_bind='^#[[:space:]]*API_BIND_ADDRESS='
re_email='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
re_bare='^[A-Za-z0-9_@%+=:,./-]+$'

usage() {
  cat <<'USAGE'
Usage: scripts/setup-env.sh [--example FILE] [--output FILE]

Writes the Docker stack's .env from .env.example: prompts for your login and
OpenAI key, generates JWT_SECRET_KEY and SESSION_INGRESS_TRUSTED_VALUE, and
refuses to overwrite an existing .env. A value already set in the environment
under the key's own name (BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, OPENAI_API_KEY,
API_BIND_ADDRESS) is used instead of asking.

bash only (macOS, Linux, WSL); native Windows is not supported.
USAGE
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

# ---- arguments --------------------------------------------------------

while [ $# -gt 0 ]; do
  case $1 in
    --example) [ $# -ge 2 ] || die "--example needs a file"; EXAMPLE=$2; shift 2 ;;
    --output)  [ $# -ge 2 ] || die "--output needs a file";  OUT=$2;     shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---- helpers ----------------------------------------------------------

# Prompt on stderr, read a line from stdin into REPLY_VAL. Hidden when stdin
# is a terminal and $2 is 1. Returns 1 at end of input.
ask() {
  local rc
  printf '%s' "$1" >&2
  if [ "$2" = 1 ] && [ -t 0 ]; then
    IFS= read -r -s REPLY_VAL
    rc=$?
    printf '\n' >&2
  else
    IFS= read -r REPLY_VAL
    rc=$?
  fi
  if [ $rc -ne 0 ] && [ -z "$REPLY_VAL" ]; then
    return 1
  fi
  REPLY_VAL=${REPLY_VAL%$'\r'}
  return 0
}

# 64 hex characters from openssl, else from /dev/urandom.
gen_secret() {
  local s=
  if command -v openssl >/dev/null 2>&1; then
    s=$(openssl rand -hex 32 2>/dev/null) || s=
  fi
  if ! [[ $s =~ ^[0-9a-f]{64}$ ]]; then
    s=$(head -c 32 /dev/urandom 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
  fi
  [[ $s =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$s"
}

# IPv4 dotted quad, or IPv6 with or without [brackets]. Docker compose puts
# this in a ports entry, which takes an IP address, not a hostname.
valid_ipv4() {
  local octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  [[ $1 =~ ^$octet\.$octet\.$octet\.$octet$ ]]
}

valid_ipv6() {
  local v=$1 g count=0 parts
  [[ $v =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  case $v in
    *:::*|*::*::*) return 1 ;;
    :[!:]*|*[!:]:) return 1 ;;
  esac
  IFS=: read -r -a parts <<< "$v"
  for g in "${parts[@]}"; do
    [ -z "$g" ] && continue
    [ ${#g} -le 4 ] || return 1
    count=$((count + 1))
  done
  case $v in
    *::*) [ $count -le 7 ] ;;
    *)    [ $count -eq 8 ] ;;
  esac
}

valid_bind() {
  local v=$1
  case $v in
    \[*\]) v=${v#\[}; v=${v%\]}; valid_ipv6 "$v" ;;
    *:*)    valid_ipv6 "$v" ;;
    *)      valid_ipv4 "$v" ;;
  esac
}

# Prints the reason and returns 1 when $2 is not a usable value for key $1.
# Never prints the value itself.
validate() {
  local key=$1 v=$2 len
  case $v in
    *$'\n'*|*$'\r'*) echo "must be a single line"; return 1 ;;
  esac
  if [ -z "$v" ]; then
    echo "must not be empty"
    return 1
  fi
  len=${#v}
  case $key in
    BOOTSTRAP_EMAIL)
      if [ "$len" -gt 254 ] || ! [[ $v =~ $re_email ]]; then
        echo "not an email address (expected name@domain.tld)"
        return 1
      fi ;;
    BOOTSTRAP_PASSWORD)
      # The API's bootstrap refuses under 8; its login endpoint caps at 128.
      if [ "$len" -lt 8 ] || [ "$len" -gt 128 ]; then
        echo "must be 8 to 128 characters"
        return 1
      fi ;;
    OPENAI_API_KEY)
      case $v in
        *[[:space:]]*) echo "must not contain whitespace"; return 1 ;;
      esac ;;
    API_BIND_ADDRESS)
      if ! valid_bind "$v"; then
        echo "must be an IPv4 or IPv6 address such as 0.0.0.0 or 127.0.0.1 (docker compose does not accept a hostname)"
        return 1
      fi ;;
  esac
  return 0
}

# Quote a value for a docker compose .env file. Checked against
# `docker compose config`: bare when only safe characters; single quotes
# (literal, so $ # and spaces are fine) when there is no ' or backslash;
# otherwise double quotes with \ " and $ escaped.
env_quote() {
  local v=$1
  if [[ $v =~ $re_bare ]]; then
    printf '%s' "$v"
  elif [[ $v != *"'"* && $v != *'\'* ]]; then
    printf "'%s'" "$v"
  else
    printf '"%s"' "$(printf '%s' "$v" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g')"
  fi
}

is_secret_key() {
  case $1 in
    *PASSWORD*|*SECRET*|*TOKEN*|*KEY*) return 0 ;;
  esac
  return 1
}

prompt_text() {
  case $1 in
    BOOTSTRAP_EMAIL)    printf 'Email for your login: ' ;;
    BOOTSTRAP_PASSWORD) printf 'Password (at least 8 characters): ' ;;
    OPENAI_API_KEY)     printf 'OpenAI API key: ' ;;
    *)                  printf '%s: ' "$1" ;;
  esac
}

# Sets VALUE and SOURCE for key $1, or exits.
obtain() {
  local key=$1 envval attempt=0 reason hidden=0
  case $GENERATED in
    *" $key "*)
      VALUE=$(gen_secret) || die "could not generate a random value for $key (needs openssl or /dev/urandom)"
      SOURCE=generated
      return 0 ;;
  esac
  envval=${!key-}
  if [ -n "$envval" ]; then
    reason=$(validate "$key" "$envval") || die "$key (from the environment): $reason"
    VALUE=$envval
    SOURCE="from the environment"
    return 0
  fi
  if is_secret_key "$key"; then hidden=1; fi
  while [ $attempt -lt 3 ]; do
    ask "$(prompt_text "$key")" "$hidden" ||
      die "no value for $key (run this in a terminal, pipe the answers in, or set $key in the environment)"
    if reason=$(validate "$key" "$REPLY_VAL"); then
      VALUE=$REPLY_VAL
      SOURCE="typed"
      return 0
    fi
    printf '%s: %s: %s\n' "$PROG" "$key" "$reason" >&2
    attempt=$((attempt + 1))
  done
  die "$key: giving up after 3 invalid answers"
}

# ---- output path ------------------------------------------------------

refuse() {
  printf '%s: REFUSED: %s already exists; not overwriting it. Edit it by hand, or move it aside and run this again.\n' "$PROG" "$OUT" >&2
  exit 1
}

if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  refuse
fi
out_dir=$(dirname "$OUT")
[ -d "$out_dir" ] || die "output directory does not exist: $out_dir"
out_abs="$(cd "$out_dir" && pwd)/$(basename "$OUT")"

# ---- template ---------------------------------------------------------

[ -r "$EXAMPLE" ] || die "cannot read the template: $EXAMPLE"
tpl=()
while IFS= read -r line || [ -n "$line" ]; do
  tpl[${#tpl[@]}]=${line%$'\r'}
done < "$EXAMPLE"
n=${#tpl[@]}

req_keys=()
bind_idx=-1
for ((i = 0; i < n; i++)); do
  if [[ ${tpl[i]} =~ $re_required ]]; then
    req_keys[${#req_keys[@]}]=${BASH_REMATCH[1]}
  elif [ "$bind_idx" -lt 0 ] && [[ ${tpl[i]} =~ $re_bind ]]; then
    bind_idx=$i
  fi
done
[ ${#req_keys[@]} -gt 0 ] || die "no required keys (empty KEY= lines) found in $EXAMPLE; is it the right file?"

printf '%s: writing %s from %s\n' "$PROG" "$out_abs" "$EXAMPLE"
if [ -t 0 ]; then
  printf 'Nothing is written until every value is in. Typing is hidden for the password and keys.\n' >&2
fi

# ---- values -----------------------------------------------------------

keys=()
vals=()
srcs=()
for key in "${req_keys[@]}"; do
  dup=0
  for ((j = 0; j < ${#keys[@]}; j++)); do
    [ "${keys[j]}" = "$key" ] && dup=1
  done
  [ $dup -eq 1 ] && continue
  obtain "$key"
  keys[${#keys[@]}]=$key
  vals[${#vals[@]}]=$VALUE
  srcs[${#srcs[@]}]=$SOURCE
done

bind_value=
bind_src=
if [ "$bind_idx" -ge 0 ]; then
  envbind=${API_BIND_ADDRESS-}
  if [ -n "$envbind" ]; then
    reason=$(validate API_BIND_ADDRESS "$envbind") || die "API_BIND_ADDRESS (from the environment): $reason"
    bind_value=$envbind
    bind_src="from the environment"
  else
    printf 'The API listens on every network interface by default, so the Android collector can reach it from your phone.\nAnswer n to keep it on this machine only (127.0.0.1); the phone then cannot reach it.\n' >&2
    attempt=0
    while [ $attempt -lt 3 ]; do
      ask 'Let your phone and other devices on this network reach the API? [Y/n] ' 0 || break
      case $REPLY_VAL in
        ""|[yY]|[yY][eE][sS]) break ;;
        [nN]|[nN][oO]) bind_value=127.0.0.1; bind_src="typed"; break ;;
      esac
      printf '%s: please answer y or n\n' "$PROG" >&2
      attempt=$((attempt + 1))
    done
    [ $attempt -lt 3 ] || die "API_BIND_ADDRESS: giving up after 3 unusable answers"
  fi
fi

# ---- write ------------------------------------------------------------

content=
for ((i = 0; i < n; i++)); do
  line=${tpl[i]}
  if [[ $line =~ $re_required ]]; then
    k=${BASH_REMATCH[1]}
    for ((j = 0; j < ${#keys[@]}; j++)); do
      if [ "${keys[j]}" = "$k" ]; then
        line="$k=$(env_quote "${vals[j]}")"
        break
      fi
    done
  elif [ "$i" -eq "$bind_idx" ] && [ -n "$bind_value" ]; then
    line="API_BIND_ADDRESS=$(env_quote "$bind_value")"
  fi
  content+="$line"$'\n'
done

# Write to a private temp file beside the target, then hard-link it into
# place: ln fails if anything (a file, a dangling symlink) is already there,
# so a half-written or racing write can never replace or truncate a .env.
umask 077
trap 'if [ -n "${tmp:-}" ]; then rm -f -- "$tmp"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
tmp=$(mktemp "$out_dir/.env.XXXXXX") || die "could not create a temporary file in $out_dir"
if ! printf '%s' "$content" > "$tmp"; then
  die "could not write $OUT (see the error above; nothing was left behind)"
fi
if ! link_err=$(ln -- "$tmp" "$OUT" 2>&1); then
  if [ -e "$OUT" ] || [ -L "$OUT" ]; then
    refuse
  fi
  die "could not write $OUT: $link_err"
fi
rm -f -- "$tmp"
tmp=
chmod 600 "$OUT" 2>/dev/null || true

printf '%s: wrote %s (readable by you only). Values are not shown.\n' "$PROG" "$out_abs"
for ((j = 0; j < ${#keys[@]}; j++)); do
  printf '  %-32s %s\n' "${keys[j]}" "${srcs[j]}"
done
if [ -n "$bind_value" ]; then
  printf '  %-32s %s (%s)\n' API_BIND_ADDRESS "$bind_value" "$bind_src"
fi

if [ "$out_abs" != "$ROOT/.env" ]; then
  printf '\nNote: %s is not %s/.env, so docker compose will not read it. Move it there before the commands below.\n' "$out_abs" "$ROOT"
fi

cat <<'NEXT'

Next, from the folder with docker-compose.yml:

  docker compose up --build

It runs in the foreground. In a second terminal in the same folder, once it is up, get the collectors' API key:

  docker compose exec api sh -c 'ROTATE_EMAIL="$BOOTSTRAP_EMAIL" python -m backend.scripts.rotate_api_key'

Sign in at http://localhost:3000 with the email and password you chose. To change the password later, edit BOOTSTRAP_PASSWORD in .env and run `docker compose up -d`.
NEXT
