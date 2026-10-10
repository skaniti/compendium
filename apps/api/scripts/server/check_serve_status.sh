#!/usr/bin/env bash
# Read-only evaluator for `tailscale serve status` text on stdin (used by
# diagnose_server.sh section 4). Prints [PASS]/[FAIL] lines in diagnose's
# style; exits 1 if any check fails.
#
# A block starts at a line beginning with http:// or https:// and runs to the
# next such line. After the owner gateway cutover the only block must be
# :8443 proxying to 127.0.0.1:8001 (the collectors' API route).
set -uo pipefail

input=$(cat)

if [ -z "$(printf '%s' "$input" | tr -d '[:space:]')" ] || printf '%s\n' "$input" | grep -qi 'no serve config'; then
    echo "[FAIL] tailscale serve has no config (the collectors need :8443)"
    exit 1
fi

printf '%s\n' "$input" | awk '
function port_of(url,    u) {
    u = url
    sub(/^[a-z]+:\/\//, "", u)
    sub(/[\/ ].*$/, "", u)
    if (match(u, /:[0-9]+$/)) return substr(u, RSTART + 1)
    return (url ~ /^http:/) ? "80" : "443"
}
/^https?:\/\// {
    n++
    url[n] = $1
    port[n] = port_of($1)
    next
}
/^tcp:\/\// {
    # a tcp:// handler line inside a block counts as that port too
    if (n > 0) extra[n] = extra[n] " " $1
    else { n++; url[n] = $1; port[n] = port_of($1) }
    next
}
n > 0 && /127\.0\.0\.1:8001/ { h8001[n] = 1 }
END {
    fail = 0; keeps = 0; stray = 0
    for (i = 1; i <= n; i++) {
        if (port[i] == "8443") { if (h8001[i]) keeps = 1 }
        else {
            stray = 1
            printf "[FAIL] tailscale serve still holds :%s (%s)\n", port[i], url[i]
            fail = 1
        }
    }
    if (keeps) print "[PASS] tailscale serve keeps :8443 -> 127.0.0.1:8001"
    else { print "[FAIL] tailscale serve has no :8443 -> 127.0.0.1:8001 block (collectors need it)"; fail = 1 }
    if (!stray) print "[PASS] tailscale serve holds nothing but :8443"
    exit fail
}'
