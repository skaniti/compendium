"""Bootstrap the primary + demo users for a deployment.

Idempotent: safe to run on every deploy. Behaviour:

  0. ``BOOTSTRAP_DEMO_ONLY=1`` (the public demo stack): skip step 1 entirely --
     no primary/admin user is created, and BOOTSTRAP_EMAIL/PASSWORD are not
     required.

  0b. ``BOOTSTRAP_PRIMARY_ONLY=1`` (the root docker-compose.yml stack): run
      step 1 only -- no demo user. Refuses a BOOTSTRAP_PASSWORD under 8
      characters, refuses to combine with BOOTSTRAP_DEMO_ONLY, and warns when
      a demo-role user is already on the database (a volume from the older,
      demo-seeded version of that stack).

  1. Primary user (driven by env vars ``BOOTSTRAP_EMAIL`` + ``BOOTSTRAP_PASSWORD``):
     - If a user with ``BOOTSTRAP_EMAIL`` already exists -> just refresh the
       password hash (so a redeploy with a rotated password takes effect).
     - Else if the legacy default user (email ``BOOTSTRAP_LEGACY_EMAIL``,
       default ``dev@localhost``) exists -> rename them to
       ``BOOTSTRAP_EMAIL`` / ``BOOTSTRAP_NAME`` and set the password.
       This is the path that preserves all existing captures because all
       FKs (pages.user_id etc.) stay pointed at the same row.
     - Else -> create a fresh user.
     - Role is set to 'admin' (migration 029).

  2. Demo user (curated empty compendium for showcasing the app):
     - If ``demo@traversal.local`` (overridable via ``BOOTSTRAP_DEMO_EMAIL``)
       does not exist, create it. Password defaults to ``demo`` for the
       local dev DB; production should override via
       ``BOOTSTRAP_DEMO_PASSWORD``.
     - Role is set to 'demo' (migration 029).
     - Username (the published login name): ``BOOTSTRAP_DEMO_USERNAME``
       (default ``demo``; empty string disables). Set only when the demo row's
       username is NULL and no other user holds it (case-insensitive);
       otherwise left alone with a one-line message.

Run locally (uses your local docker-compose Postgres):

    BOOTSTRAP_EMAIL=you@example.com \\
    BOOTSTRAP_PASSWORD='your-strong-password' \\
    python -m backend.scripts.bootstrap_user
"""

from __future__ import annotations

import os
import sys

from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.services.auth_service import hash_password


def _get_user_by_email(email: str) -> dict | None:
    """Lighter than auth_repo.get_user_by_email (no password hash)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE email = %s", (email,))
            row = cur.fetchone()
    if row is None:
        return None
    return user_repo.get_user_by_id(row[0])


def _rename_user(user_id: int, *, new_email: str, new_name: str) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET email = %s, name = %s WHERE id = %s",
                (new_email, new_name, user_id),
            )


def _bootstrap_primary() -> None:
    primary_email = os.environ.get("BOOTSTRAP_EMAIL")
    primary_password = os.environ.get("BOOTSTRAP_PASSWORD")
    primary_name = os.environ.get("BOOTSTRAP_NAME", "user")
    legacy_email = os.environ.get("BOOTSTRAP_LEGACY_EMAIL", "dev@localhost")

    if not primary_email or not primary_password:
        sys.exit(
            "ERROR: BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD must be set.\n"
            "Example:\n"
            "  BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD=xxx \\\n"
            "    python -m backend.scripts.bootstrap_user"
        )

    # ── Primary user ──────────────────────────────────────────────────
    existing_primary = _get_user_by_email(primary_email)
    legacy_user = _get_user_by_email(legacy_email)

    if existing_primary is not None:
        auth_repo.set_password(existing_primary["id"], hash_password(primary_password))
        print(
            f"[primary] {primary_email} already exists (id={existing_primary['id']}); "
            "refreshed password"
        )
    elif legacy_user is not None:
        _rename_user(legacy_user["id"], new_email=primary_email, new_name=primary_name)
        auth_repo.set_password(legacy_user["id"], hash_password(primary_password))
        print(
            f"[primary] renamed legacy user (id={legacy_user['id']}) "
            f"{legacy_email} -> {primary_email} ({primary_name}); password set. "
            "Existing captures retained."
        )
    else:
        user = user_repo.create_user(primary_email, name=primary_name)
        auth_repo.set_password(user["id"], hash_password(primary_password))
        print(
            f"[primary] created fresh user {primary_email} (id={user['id']}, "
            f"{primary_name}); password set. NOTE: no existing data attached."
        )

    # Tag the primary as admin so the role-gated admin-only surfaces
    # (e.g. the tuner panel's copy-current-config-to-clipboard button)
    # appear for them. Re-resolve the user id to cover the legacy-rename
    # path. Migration 029 added the role column.
    primary_after = _get_user_by_email(primary_email)
    if primary_after is not None:
        auth_repo.set_role(primary_after["id"], "admin")
        print(f"[primary] role -> admin")


def _bootstrap_demo(demo_email: str, demo_password: str, demo_name: str) -> None:
    # ── Demo user ─────────────────────────────────────────────────────
    existing_demo = _get_user_by_email(demo_email)
    if existing_demo is not None:
        # Refresh password (idempotent re-run); leave email/name alone in case
        # you've curated the demo user's data.
        auth_repo.set_password(existing_demo["id"], hash_password(demo_password))
        print(
            f"[demo]    {demo_email} already exists (id={existing_demo['id']}); "
            "refreshed password"
        )
    else:
        demo = user_repo.create_user(demo_email, name=demo_name)
        auth_repo.set_password(demo["id"], hash_password(demo_password))
        print(
            f"[demo]    created {demo_email} (id={demo['id']}, {demo_name}); "
            "empty compendium ready for curation"
        )

    # Tag the demo account as 'demo' so any future demo-specific UI
    # gating (suppress destructive actions, different splash, etc.)
    # can branch on it without hardcoding the demo email.
    demo_after = _get_user_by_email(demo_email)
    if demo_after is not None:
        auth_repo.set_role(demo_after["id"], "demo")
        print(f"[demo]    role -> demo")
        _ensure_demo_username(
            demo_after["id"], os.environ.get("BOOTSTRAP_DEMO_USERNAME", "demo")
        )


def _ensure_demo_username(demo_id: int, username: str) -> None:
    """Give the demo row its login username (get_user_by_login matches
    email OR lower(username)); never steals one another user holds."""
    username = username.strip()
    if not username:
        print("[demo]    username skipped (BOOTSTRAP_DEMO_USERNAME empty)")
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT username FROM users WHERE id = %s", (demo_id,))
            row = cur.fetchone()
            if row is not None and row[0] is not None:
                print(f"[demo]    username kept ({row[0]})")
                return
            cur.execute(
                "SELECT 1 FROM users WHERE lower(username) = lower(%s) AND id <> %s",
                (username, demo_id),
            )
            if cur.fetchone() is not None:
                print(f"[demo]    username {username} skipped (held by another user)")
                return
            cur.execute(
                "UPDATE users SET username = %s WHERE id = %s", (username, demo_id)
            )
    print(f"[demo]    username -> {username}")


_MIN_PASSWORD_LEN = 8  # matches POST /api/auth/register's minimum


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def _demo_only() -> bool:
    return _flag("BOOTSTRAP_DEMO_ONLY")


def _primary_only() -> bool:
    return _flag("BOOTSTRAP_PRIMARY_ONLY")


def _warn_if_demo_users_exist() -> None:
    """The root Docker stack used to create a demo login (demo/demo); a
    volume carried over from that version still has it."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM users WHERE role = 'demo'")
        count = cur.fetchone()[0]
    if count:
        print(
            f"[primary] WARNING: {count} demo-role user(s) already exist on this "
            "database, probably from an older version of this stack. Their "
            "logins still work. Start fresh with `docker compose down -v` "
            "(deletes all data) or remove them."
        )


def bootstrap() -> None:
    if _demo_only() and _primary_only():
        sys.exit(
            "ERROR: BOOTSTRAP_DEMO_ONLY and BOOTSTRAP_PRIMARY_ONLY are mutually "
            "exclusive; set at most one."
        )

    if _primary_only():
        # Root Docker stack (docker-own-data-stack): only the owner's login,
        # no demo user. A weak password is refused here because this stack's
        # API listens on the network.
        password = os.environ.get("BOOTSTRAP_PASSWORD") or ""
        if password and len(password) < _MIN_PASSWORD_LEN:
            sys.exit(
                f"ERROR: BOOTSTRAP_PASSWORD must be at least {_MIN_PASSWORD_LEN} "
                "characters."
            )
        _bootstrap_primary()
        _warn_if_demo_users_exist()
        print("[demo]    BOOTSTRAP_PRIMARY_ONLY set -- no demo user on this database")
        return

    demo_email = os.environ.get("BOOTSTRAP_DEMO_EMAIL", "demo@traversal.local")
    demo_password = os.environ.get("BOOTSTRAP_DEMO_PASSWORD", "demo")
    demo_name = os.environ.get("BOOTSTRAP_DEMO_NAME", "demo")

    if _demo_only():
        # Public demo stack (tailnet-owner-demo-split): no primary/admin
        # account exists on this database at all, so nothing here accepts a
        # credential other than the published demo one.
        print("[primary] BOOTSTRAP_DEMO_ONLY set -- no primary/admin user on this database")
    else:
        _bootstrap_primary()

    _bootstrap_demo(demo_email, demo_password, demo_name)


if __name__ == "__main__":
    bootstrap()
