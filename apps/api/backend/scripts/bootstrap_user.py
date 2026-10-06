"""Bootstrap the primary + demo users for a deployment.

Idempotent: safe to run on every deploy. Behaviour:

  0. ``BOOTSTRAP_DEMO_ONLY=1`` (the public demo stack): skip step 1 entirely --
     no primary/admin user is created, and BOOTSTRAP_EMAIL/PASSWORD are not
     required.

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


def _demo_only() -> bool:
    return os.environ.get("BOOTSTRAP_DEMO_ONLY", "").strip().lower() in {"1", "true", "yes"}


def bootstrap() -> None:
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
