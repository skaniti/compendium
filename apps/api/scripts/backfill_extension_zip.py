#!/usr/bin/env python3
"""Backfill captures from extension cache ZIPs.

Reads one or more ZIPs produced by the extension's cache.html "Download All
as ZIP" button and re-POSTs each capture JSON to the corresponding backend
endpoint:
    cached_*.json, pending_*.json  ->  /api/passive-captures
    active_*.json                  ->  /api/captures  (rate-limited 20/min)

Idempotent: the server returns 409 when capture_id already exists. Re-runs are
safe; only genuinely-new captures count as inserts.

Usage:
    set -a; source ~/.secrets; set +a     # exports COMPENDIUM_API_KEY
    python scripts/backfill_extension_zip.py \\
        traversal-cache-2026-05-18.zip \\
        traversal-cache-2026-05-24.zip

    # Sanity-check pass without POSTing anything:
    python scripts/backfill_extension_zip.py --dry-run *.zip

Stdlib only -- no extra deps.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

# Override via COMPENDIUM_BACKFILL_BACKEND_URL; falls back to a local dev
# server. Point this at your deployed backend's public URL when backfilling
# against production.
DEFAULT_BACKEND = os.environ.get(
    "COMPENDIUM_BACKFILL_BACKEND_URL", "http://localhost:8000"
)

# Cloudflare's WAF blocks bare `Python-urllib/X.Y` with error 1010
# ("browser signature ban"). The extension + Android client get through
# because they send real-browser User-Agents; mimic one here for the
# same reason.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/127.0.0.0 Safari/537.36"
)


def post_capture(
    backend: str, path: str, body: dict, api_key: str, timeout: float = 30.0
) -> tuple[int, str]:
    req = urllib.request.Request(
        url=f"{backend}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key,
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return (resp.status, resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode("utf-8", errors="replace"))


def classify(filename: str) -> tuple[str | None, str]:
    base = filename.rsplit("/", 1)[-1]
    if base.startswith("cached_") or base.startswith("pending_"):
        return ("/api/passive-captures", "passive")
    if base.startswith("active_"):
        return ("/api/captures", "active")
    return (None, "skip")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("zips", nargs="+", type=Path, help="Path(s) to extension cache ZIP files")
    parser.add_argument(
        "--backend", default=DEFAULT_BACKEND, help=f"Backend URL (default: {DEFAULT_BACKEND})"
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse + classify, do not POST")
    parser.add_argument("--verbose", action="store_true", help="Log every item, not just summary")
    args = parser.parse_args()

    api_key = os.getenv("COMPENDIUM_API_KEY")
    if not args.dry_run and not api_key:
        sys.exit(
            "ERROR: COMPENDIUM_API_KEY not set. Run `set -a; source ~/.secrets; set +a` first."
        )

    counter: Counter[str] = Counter()
    seen_ids: set[str] = set()  # de-dup across ZIPs in the same run

    for zip_path in args.zips:
        if not zip_path.exists():
            print(f"[skip] {zip_path} not found", file=sys.stderr)
            counter["zip_missing"] += 1
            continue

        with zipfile.ZipFile(zip_path) as zf:
            entries = sorted(n for n in zf.namelist() if n.endswith(".json"))
            print(f"[zip] {zip_path.name}: {len(entries)} JSON entries")

            for name in entries:
                path, kind = classify(name)
                if path is None:
                    if args.verbose:
                        print(f"  [skip] unknown prefix: {name}")
                    counter["skipped_unknown_prefix"] += 1
                    continue

                try:
                    body = json.loads(zf.read(name).decode("utf-8"))
                except Exception as e:
                    print(f"  [error] parse failure {name}: {e}", file=sys.stderr)
                    counter["parse_error"] += 1
                    continue

                capture_id = body.get("captureId", "?")

                # Skip if we already submitted this capture_id earlier this run
                # (cross-ZIP overlap; the server would 409 anyway but avoid the
                # round-trip).
                if capture_id in seen_ids:
                    counter[f"{kind}_run_dupe"] += 1
                    if args.verbose:
                        print(f"  [run-dupe] {kind} {capture_id} (already sent this run)")
                    continue
                seen_ids.add(capture_id)

                if args.dry_run:
                    counter[f"{kind}_dryrun"] += 1
                    if args.verbose:
                        pages = len(body.get("pages", []))
                        print(f"  [dryrun] {kind} {capture_id} ({pages} pages)")
                    continue

                status, resp_text = post_capture(args.backend, path, body, api_key)

                if status == 409:
                    counter[f"{kind}_dupe_409"] += 1
                    if args.verbose:
                        print(f"  [409 dupe] {kind} {capture_id}")
                elif 200 <= status < 300:
                    counter[f"{kind}_inserted"] += 1
                    if args.verbose:
                        print(f"  [{status}] {kind} {capture_id}")
                else:
                    counter[f"{kind}_error_{status}"] += 1
                    print(
                        f"  [{status} ERROR] {kind} {capture_id}: {resp_text[:200]}",
                        file=sys.stderr,
                    )

                # Polite throttle. /api/captures is rate-limited 20/min
                # (one every 3s); /api/passive-captures has no documented
                # limit but the polite client still doesn't fire-hose.
                time.sleep(3.5 if kind == "active" else 0.05)

    print("\n=== Summary ===")
    for key, count in sorted(counter.items()):
        print(f"  {key}: {count}")

    error_keys = [k for k in counter if "error" in k]
    return 1 if error_keys else 0


if __name__ == "__main__":
    sys.exit(main())
