#!/usr/bin/env bash
# Update API keys in ~/.secrets with verification.
#
# Behavior:
#   - Prompts silently (read -rs) for OPENAI_API_KEY, ANTHROPIC_API_KEY, HF_TOKEN.
#     Empty input keeps the existing value untouched.
#   - Strips whitespace / CR / quotes from pasted values to defend against
#     copy-paste artifacts (Windows clipboard CRLF, smart-quote wrapping, etc.)
#   - Validates expected prefix per provider (sk-, sk-ant-, hf_) so a
#     wrong-clipboard paste fails fast instead of writing junk to ~/.secrets.
#   - Backs up to ~/.secrets.bak before any edit. Roll back via
#     `cp ~/.secrets.bak ~/.secrets` if anything is wrong.
#   - Uses `sed -i` for in-place atomic replacement.
#   - Prints before/after first-12-char prefixes to visually confirm the
#     change took effect (no ambiguity about "did the file actually change").
#   - Live-validates each updated key by curling the provider's `whoami` /
#     `models` endpoint.
#
# Re-runnable. No secrets land in shell history (read -rs), terminal
# scrollback, or /tmp.

set -euo pipefail

SECRETS_FILE="$HOME/.secrets"
BACKUP_FILE="$HOME/.secrets.bak"

if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "ERROR: $SECRETS_FILE does not exist." >&2
    echo "Create it first: touch ~/.secrets && chmod 600 ~/.secrets" >&2
    exit 1
fi

cp "$SECRETS_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "Backup saved at: $BACKUP_FILE"
echo ""

# Read first 12 chars of an existing value (or empty if not set)
get_prefix() {
    local KEY_NAME="$1"
    grep "^${KEY_NAME}=" "$SECRETS_FILE" 2>/dev/null \
        | head -1 \
        | cut -d= -f2- \
        | tr -d '"' \
        | head -c 12
}

# Prompt + validate + replace one key. Empty input = skip.
update_key() {
    local KEY_NAME="$1"
    local EXPECTED_PREFIX="$2"

    local OLD_PREFIX
    OLD_PREFIX=$(get_prefix "$KEY_NAME")

    echo "--- ${KEY_NAME} ---"
    if [[ -n "$OLD_PREFIX" ]]; then
        echo "  Current prefix: ${OLD_PREFIX}..."
    else
        echo "  Current: (not set)"
    fi
    printf "  Paste new value (or Enter to skip): "
    local NEW_VALUE
    read -rs NEW_VALUE
    echo ""

    if [[ -z "$NEW_VALUE" ]]; then
        echo "  [skip] kept existing"
        echo ""
        return
    fi

    # Strip whitespace, CR/LF, straight quotes (typical paste artifacts)
    NEW_VALUE="$(printf '%s' "$NEW_VALUE" | tr -d '"\r\n\t ')"

    # Prefix sanity check
    if [[ "$NEW_VALUE" != "${EXPECTED_PREFIX}"* ]]; then
        echo "  [error] new value does not start with '${EXPECTED_PREFIX}'"
        echo "          got prefix: ${NEW_VALUE:0:12}..."
        echo "  [skip] kept existing; check your paste and re-run"
        echo ""
        return
    fi

    # Escape special chars for sed: \ & |
    local ESCAPED_VALUE
    ESCAPED_VALUE="$(printf '%s' "$NEW_VALUE" | sed 's/[\\&|]/\\&/g')"

    # In-place replace whole line. If the key already exists in the file we
    # replace it; if not we append.
    if grep -q "^${KEY_NAME}=" "$SECRETS_FILE"; then
        sed -i "s|^${KEY_NAME}=.*|${KEY_NAME}=${ESCAPED_VALUE}|" "$SECRETS_FILE"
    else
        printf '%s=%s\n' "$KEY_NAME" "$NEW_VALUE" >> "$SECRETS_FILE"
    fi

    local NEW_PREFIX
    NEW_PREFIX=$(get_prefix "$KEY_NAME")

    if [[ "$OLD_PREFIX" == "$NEW_PREFIX" && -n "$OLD_PREFIX" ]]; then
        echo "  [warn] prefix unchanged after edit (${OLD_PREFIX}...)"
        echo "         either you pasted the same value, or sed didn't apply"
    else
        echo "  [ok] ${OLD_PREFIX:-(none)}... -> ${NEW_PREFIX}..."
    fi
    echo ""
}

echo "=== Update keys in ${SECRETS_FILE} ==="
echo "(Empty input on any prompt = skip that key, keep existing)"
echo ""

update_key OPENAI_API_KEY    "sk-"
update_key ANTHROPIC_API_KEY "sk-ant-"
update_key HF_TOKEN          "hf_"

# Live validation: hit each provider's lightweight endpoint
echo "=== Live validation against each provider ==="

validate_openai() {
    local K
    K=$(grep "^OPENAI_API_KEY=" "$SECRETS_FILE" | head -1 | cut -d= -f2- | tr -d '"')
    if [[ -z "$K" ]]; then echo "  OpenAI:    (not set, skipping)"; return; fi
    local CODE
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
        https://api.openai.com/v1/models -H "Authorization: Bearer $K")
    if [[ "$CODE" == "200" ]]; then
        echo "  OpenAI:    [ok] $CODE"
    else
        echo "  OpenAI:    [FAIL] $CODE (key may be invalid)"
    fi
}

validate_anthropic() {
    local K
    K=$(grep "^ANTHROPIC_API_KEY=" "$SECRETS_FILE" | head -1 | cut -d= -f2- | tr -d '"')
    if [[ -z "$K" ]]; then echo "  Anthropic: (not set, skipping)"; return; fi
    local CODE
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
        https://api.anthropic.com/v1/models \
        -H "x-api-key: $K" -H "anthropic-version: 2023-06-01")
    if [[ "$CODE" == "200" ]]; then
        echo "  Anthropic: [ok] $CODE"
    else
        echo "  Anthropic: [FAIL] $CODE (key may be invalid)"
    fi
}

validate_hf() {
    local K
    K=$(grep "^HF_TOKEN=" "$SECRETS_FILE" | head -1 | cut -d= -f2- | tr -d '"')
    if [[ -z "$K" ]]; then echo "  HF:        (not set, skipping)"; return; fi
    local CODE
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
        https://huggingface.co/api/whoami-v2 \
        -H "Authorization: Bearer $K")
    if [[ "$CODE" == "200" ]]; then
        echo "  HF:        [ok] $CODE"
    else
        echo "  HF:        [FAIL] $CODE (token may be invalid)"
    fi
}

validate_openai
validate_anthropic
validate_hf

echo ""
echo "=== Done ==="
echo "  Backup: ${BACKUP_FILE}"
echo "  Roll back: cp ${BACKUP_FILE} ${SECRETS_FILE}"
echo "  Clean up after verifying app works: rm ${BACKUP_FILE}"
