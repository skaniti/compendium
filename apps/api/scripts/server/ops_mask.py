#!/usr/bin/env python3
"""Mask secrets in a text stream (stdin -> stdout), line-buffered.

Used by ops-run.sh so the ops journal's run logs never hold secret values.
Pure stdlib; runs on the server's system python3 with no repo imports.

Two passes per line:
  1. Exact values from $OPS_MASK_SECRETS (default ~/.secrets), KEY=VALUE lines,
     values of 8+ chars, longest first -> <SECRET:KEY>
  2. Known token/credential shapes -> <REDACTED:kind>

SECRET_SHAPE_PATTERNS is mirrored by backend/db/audit_repo.py; a test keeps
the two tuples equal.
"""

import os
import re
import sys

MIN_SECRET_LEN = 8

SECRET_SHAPE_PATTERNS = (
    r"sk-ant-[A-Za-z0-9_-]{20,}",
    r"sk-[A-Za-z0-9_-]{20,}",
    r"cmp_[A-Za-z0-9_-]{20,}",
    r"hf_[A-Za-z0-9]{20,}",
    r"ghp_[A-Za-z0-9]{20,}",
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}",
    r"(?i)\b(password|pgpassword|passwd|secret|token)=\S+",
    r"postgres(?:ql)?://[^:\s/]+:[^@\s]+@",
    r"\b[A-Fa-f0-9]{48,}\b",
    r"\b[A-Za-z0-9_-]{48,}\b",
)

# One kind label per pattern above, same order.
SHAPE_KINDS = (
    "token",
    "token",
    "token",
    "token",
    "token",
    "jwt",
    "bearer",
    "assignment",
    "dsn",
    "hex",
    "b64",
)

_SHAPES = tuple(
    (re.compile(p), f"<REDACTED:{k}>")
    for p, k in zip(SECRET_SHAPE_PATTERNS, SHAPE_KINDS, strict=True)
)


def load_secrets(path=None):
    """Return [(KEY, value)] for values >= MIN_SECRET_LEN, longest first."""
    path = path or os.environ.get("OPS_MASK_SECRETS") or os.path.expanduser("~/.secrets")
    pairs = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].lstrip()
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                quoted = re.match(r"""^(["'])(.*?)\1(?:\s+#.*)?$""", val)
                if quoted:
                    val = quoted.group(2)
                else:
                    val = re.sub(r"\s+#.*$", "", val)
                if key and len(val) >= MIN_SECRET_LEN:
                    pairs.append((key, val))
    except OSError:
        return []
    pairs.sort(key=lambda kv: len(kv[1]), reverse=True)
    return pairs


def mask_line(line, secrets):
    for key, val in secrets:
        if val in line:
            line = line.replace(val, f"<SECRET:{key}>")
    for rx, repl in _SHAPES:
        line = rx.sub(repl, line)
    return line


def main():
    secrets = load_secrets()
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    for raw in iter(stdin.readline, b""):
        text = raw.decode("utf-8", errors="replace")
        stdout.write(mask_line(text, secrets).encode("utf-8", errors="replace"))
        stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
