"""Rotate a user's API key.

Rotation invalidates the OLD key everywhere it's used the instant it
commits -- the browser extension, the Android collector, any saved
~/.secrets copy. Every client holding the old key starts 401-ing until
reconfigured with the new one (collectors save-and-retry locally, so
nothing is lost, but nothing delivers until reconfigured).

Safe by default: with no ``ROTATE_EMAIL`` set, this only lists users and
their current key prefix -- no writes. Set ``ROTATE_EMAIL`` to the target
user's email to actually rotate. Each run generates a *fresh* key --
re-running rotates again, it is not idempotent.

Run locally (uses your local docker-compose Postgres):

    python -m backend.scripts.rotate_api_key                       # dry run
    ROTATE_EMAIL=you@example.com python -m backend.scripts.rotate_api_key

Run against the deployed server (script ships inside backend/, which is
baked into the image -- needs a `git pull` + redeploy first if this is a
fresh addition; see the canonical redeploy command in the project's
CLAUDE.md):

    docker compose -f docker/server/docker-compose.yml exec app \\
      python -m backend.scripts.rotate_api_key                     # dry run

    docker compose -f docker/server/docker-compose.yml exec \\
      -e ROTATE_EMAIL=you@example.com app \\
      python -m backend.scripts.rotate_api_key                     # rotates
"""

from __future__ import annotations

import os
import sys

from backend.db import user_repo
from backend.db.connection import get_conn


def _list_users() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, email, name, api_key_prefix FROM users ORDER BY id")
            rows = cur.fetchall()
    print("\n== users ==")
    for uid, email, name, prefix in rows:
        print(f"  id={uid}  {email!r}  name={name!r}  prefix={prefix}")


def rotate() -> None:
    email = os.environ.get("ROTATE_EMAIL", "").strip()

    _list_users()

    if not email:
        print(
            "\n[dry run] No ROTATE_EMAIL set -- nothing changed.\n"
            "          Set ROTATE_EMAIL=<email> and re-run to rotate."
        )
        return

    result = user_repo.rotate_api_key(email)

    if result is None:
        sys.exit(f"\n[!] No user with email {email!r} -- nothing changed.")

    print(
        f"\n[OK] Rotated API key for id={result['id']} {result['email']!r} "
        f"(new prefix {result['api_key_prefix']})"
    )
    print(
        "\n    NEW KEY -- shown once, save it now, then reconfigure every "
        "client (browser extension popup, Android collector settings, "
        f"~/.secrets):\n\n    {result['api_key']}\n"
    )
    print(
        "    The OLD key stopped working the moment this ran. Any client "
        "still holding it will get 401s until reconfigured."
    )


if __name__ == "__main__":
    rotate()
