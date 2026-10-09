"""List and revoke browsers trusted for automatic tailnet sign-in.

Run inside the owner API container:

    docker exec compendium-api python scripts/trusted_browsers.py list
    docker exec compendium-api python scripts/trusted_browsers.py revoke <id>
    docker exec compendium-api python scripts/trusted_browsers.py revoke-all [--user <email>] [--sessions]

--sessions also revokes the affected accounts' refresh tokens, ending every
session they hold now. Without it, sessions already issued run until they
expire or sign out. Exit 1 on an unknown id or account.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure project root is on sys.path (same preamble as backfill_trends.py):
# `python scripts/trusted_browsers.py` puts scripts/ first, not apps/api.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.db import auth_repo, trusted_browser_repo  # noqa: E402


def _fmt(value) -> str:
    return "-" if value is None else str(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    revoke = sub.add_parser("revoke")
    revoke.add_argument("browser_id", type=int)
    revoke_all = sub.add_parser("revoke-all")
    revoke_all.add_argument("--user", help="email or username; default: every account")
    revoke_all.add_argument("--sessions", action="store_true")
    args = parser.parse_args(argv)

    if args.cmd == "list":
        rows = trusted_browser_repo.list_all()
        print(f"[trusted_browsers] {len(rows)} row(s)")
        for r in rows:
            state = "revoked " + _fmt(r["revoked_at"]) if r["revoked_at"] else "active"
            print(
                f"  id={r['id']} user={r['user_id']} {state} "
                f"created={_fmt(r['created_at'])} last_used={_fmt(r['last_used_at'])} "
                f"label={_fmt(r['label'])}"
            )
        return 0

    if args.cmd == "revoke":
        if trusted_browser_repo.revoke(args.browser_id):
            print(f"[trusted_browsers] revoked id={args.browser_id}")
            return 0
        print(f"[trusted_browsers] no active row with id={args.browser_id}", file=sys.stderr)
        return 1

    user_id = None
    if args.user:
        user = auth_repo.get_user_by_login(args.user)
        if user is None:
            print(f"[trusted_browsers] no account {args.user!r}", file=sys.stderr)
            return 1
        user_id = user["id"]
    affected = {
        r["user_id"]
        for r in trusted_browser_repo.list_all()
        if r["revoked_at"] is None and (user_id is None or r["user_id"] == user_id)
    }
    n = trusted_browser_repo.revoke_all(user_id)
    print(f"[trusted_browsers] revoked {n} browser(s)")
    if args.sessions:
        for uid in sorted(affected | ({user_id} if user_id else set())):
            ended = auth_repo.revoke_all_user_tokens(uid)
            print(f"[trusted_browsers] user={uid}: revoked {ended} refresh token(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
