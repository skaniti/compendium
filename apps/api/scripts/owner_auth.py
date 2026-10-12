"""Owner sign-in recovery: passkeys, trusted browsers, sessions, enrollment
links and break-glass codes (owner-passkeys; replaces trusted_browsers.py).

Run inside the owner API container, directly -- not through `ops`, so the
printed link and code stay out of the ops journal:

    docker exec compendium-api python scripts/owner_auth.py passkeys list
    docker exec compendium-api python scripts/owner_auth.py passkeys revoke <id> [--sessions]
    docker exec compendium-api python scripts/owner_auth.py browsers list
    docker exec compendium-api python scripts/owner_auth.py browsers revoke <id> [--sessions]
    docker exec compendium-api python scripts/owner_auth.py browsers revoke-all [--sessions]
    docker exec compendium-api python scripts/owner_auth.py sessions end
    docker exec compendium-api python scripts/owner_auth.py enroll [--label LABEL]
    docker exec compendium-api python scripts/owner_auth.py break-glass [--minutes N]
    docker exec compendium-api python scripts/owner_auth.py password clear

Every subcommand takes --user <email or username>; without it the command
acts on the single admin account. --sessions also revokes the account's
refresh tokens, ending every session now (trusted browsers sign straight
back in; a revoked one cannot). Every change writes an audit event (origin
cli). Exit 1 on an unknown id or account, or when passkeys are off for
enroll and break-glass.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# `python scripts/owner_auth.py` puts scripts/ first on sys.path, not apps/api.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.api.audit_ctx import CLI  # noqa: E402
from backend.db import audit_repo, auth_repo, passkey_repo, trusted_browser_repo  # noqa: E402
from backend.services import break_glass, passkeys  # noqa: E402

_PREFIX = "[owner_auth]"
# Mirrors trusted_browser_repo.get_active: rows older than this stop working.
_BROWSER_EXPIRY = timedelta(days=400)


def _out(message: str) -> None:
    print(f"{_PREFIX} {message}")


def _err(message: str) -> int:
    print(f"{_PREFIX} {message}", file=sys.stderr)
    return 1


def _fmt(value) -> str:
    return "-" if value is None else str(value)


def _audit(event: str, user_id: int, detail: dict) -> None:
    audit_repo.record(
        event, subject_user_id=user_id, origin_class=CLI.origin_class, client_key=None, detail=detail
    )


def _account(login: str | None) -> dict | None:
    if login:
        return auth_repo.get_user_by_login(login)
    try:
        return auth_repo.get_user_by_role("admin")
    except RuntimeError:
        return None


def _end_sessions(user_id: int) -> int:
    ended = auth_repo.revoke_all_user_tokens(user_id)
    _out(f"user={user_id}: revoked {ended} refresh token(s)")
    _audit("auth.sessions.ended", user_id, {"refresh_tokens_revoked": ended})
    return ended


def _browser_state(row) -> str:
    if row["revoked_at"]:
        return "revoked " + _fmt(row["revoked_at"])
    created = row["created_at"]
    if created is not None:
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < datetime.now(timezone.utc) - _BROWSER_EXPIRY:
            return "expired"
    return "active"


def _passkeys(args, user: dict) -> int:
    rows = passkey_repo.list_credentials(user["id"])
    if args.cmd == "list":
        _out(f"{len(rows)} passkey(s) for {user['email']}")
        for r in rows:
            state = "revoked " + _fmt(r["revoked_at"]) if r["revoked_at"] else "active"
            _out(
                f"  id={r['id']} {state} label={_fmt(r['label'])} created={_fmt(r['created_at'])} "
                f"last_used={_fmt(r['last_used_at'])} synced={'yes' if r['backed_up'] else 'no'}"
            )
        return 0
    row = next((r for r in rows if r["id"] == args.passkey_id), None)
    if row is None:
        return _err(f"no passkey with id={args.passkey_id} for {user['email']}")
    if row["revoked_at"] is None and passkey_repo.revoke_credential(row["id"]):
        _out(f"revoked passkey id={row['id']}")
        _audit("auth.passkey.revoked", user["id"], {"passkey_id": row["id"], "sessions_ended": args.sessions})
    else:
        _out(f"passkey id={row['id']} already revoked {_fmt(row['revoked_at'])}")
    if args.sessions:
        _end_sessions(user["id"])
    if passkey_repo.count_active(user["id"]) == 0:
        _out("warning: no active passkey left; run `enroll` for a new one, or `break-glass` to sign in")
    return 0


def _browsers(args, user: dict) -> int:
    rows = [r for r in trusted_browser_repo.list_all() if r["user_id"] == user["id"]]
    if args.cmd == "list":
        _out(f"{len(rows)} trusted browser(s) for {user['email']}")
        for r in rows:
            _out(
                f"  id={r['id']} {_browser_state(r)} created={_fmt(r['created_at'])} "
                f"last_used={_fmt(r['last_used_at'])} label={_fmt(r['label'])}"
            )
        return 0
    if args.cmd == "revoke":
        row = next((r for r in rows if r["id"] == args.browser_id), None)
        if row is None:
            return _err(f"no browser with id={args.browser_id} for {user['email']}")
        if row["revoked_at"] is None and trusted_browser_repo.revoke(row["id"]):
            _out(f"revoked id={row['id']}")
            _audit(
                "auth.trusted_browser.revoked",
                user["id"],
                {"trusted_browser_ids": [row["id"]], "sessions_ended": args.sessions},
            )
        else:
            _out(f"id={row['id']} already revoked {_fmt(row['revoked_at'])}")
    else:  # revoke-all
        active = [r["id"] for r in rows if r["revoked_at"] is None]
        n = trusted_browser_repo.revoke_all(user["id"])
        _out(f"revoked {n} browser(s)")
        if active:
            _audit(
                "auth.trusted_browser.revoked",
                user["id"],
                {"trusted_browser_ids": active, "sessions_ended": args.sessions},
            )
    if args.sessions:
        _end_sessions(user["id"])
    return 0


def _enroll(args, user: dict) -> int:
    if not passkeys.enabled():
        return _err("passkeys are off (WEBAUTHN_RP_ID and the tailnet login must be set)")
    raw, enrollment_id = passkeys.new_enrollment(user["id"], args.label)
    _audit(
        "auth.passkey.enroll_link_issued",
        user["id"],
        {"enrollment_id": enrollment_id, "label": args.label, "minutes": passkeys.ENROLL_MINUTES},
    )
    _out(f"enrollment link for {user['email']} (works once, within {passkeys.ENROLL_MINUTES} minutes):")
    print(passkeys.enrollment_link(raw))
    return 0


def _break_glass(args, user: dict) -> int:
    if not passkeys.enabled():
        return _err("passkeys are off (WEBAUTHN_RP_ID and the tailnet login must be set)")
    try:
        code, code_id = break_glass.issue(user["id"], args.minutes)
    except ValueError as exc:
        return _err(str(exc))
    _audit("auth.break_glass.issued", user["id"], {"break_glass_id": code_id, "minutes": args.minutes})
    _out(
        f"break-glass code for {user['email']} (works once, within {args.minutes} minutes; "
        "login page > Use a break-glass code):"
    )
    print(code)
    return 0


def _parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--user", help="email or username; default: the single admin account")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    groups = parser.add_subparsers(dest="group", required=True)

    pk = groups.add_parser("passkeys").add_subparsers(dest="cmd", required=True)
    pk.add_parser("list", parents=[common])
    revoke = pk.add_parser("revoke", parents=[common])
    revoke.add_argument("passkey_id", type=int)
    revoke.add_argument("--sessions", action="store_true")

    br = groups.add_parser("browsers").add_subparsers(dest="cmd", required=True)
    br.add_parser("list", parents=[common])
    revoke = br.add_parser("revoke", parents=[common])
    revoke.add_argument("browser_id", type=int)
    revoke.add_argument("--sessions", action="store_true")
    revoke_all = br.add_parser("revoke-all", parents=[common])
    revoke_all.add_argument("--sessions", action="store_true")

    se = groups.add_parser("sessions").add_subparsers(dest="cmd", required=True)
    se.add_parser("end", parents=[common])

    enroll = groups.add_parser("enroll", parents=[common])
    enroll.add_argument("--label", default=None)

    bg = groups.add_parser("break-glass", parents=[common])
    bg.add_argument("--minutes", type=int, default=break_glass.DEFAULT_MINUTES)

    pw = groups.add_parser("password").add_subparsers(dest="cmd", required=True)
    pw.add_parser("clear", parents=[common])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.user:
        try:
            auth_repo.get_user_by_role("admin")
        except RuntimeError:
            return _err("more than one admin account; pass --user")
    user = _account(args.user)
    if user is None:
        return _err(f"no account {args.user!r}" if args.user else "no admin account; pass --user")

    if args.group == "passkeys":
        return _passkeys(args, user)
    if args.group == "browsers":
        return _browsers(args, user)
    if args.group == "sessions":
        _end_sessions(user["id"])
        return 0
    if args.group == "enroll":
        return _enroll(args, user)
    if args.group == "break-glass":
        return _break_glass(args, user)
    auth_repo.set_password(user["id"], None, audit_ctx=CLI, via="cleared")
    _out(f"cleared the password of {user['email']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
