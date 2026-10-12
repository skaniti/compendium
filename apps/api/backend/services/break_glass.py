"""One-time break-glass codes (owner-passkeys, spec 4.3).

With passkeys on, the only password-style sign-in for a non-demo account is
a code a server command just issued: printed once, stored only as a bcrypt
hash, single use, valid for DEFAULT_MINUTES (MAX_MINUTES at most). The
alphabet drops I, L, O, U, 0 and 1 so a code typed on a phone is unambiguous;
20 symbols of 30 give about 98 bits.
"""

from __future__ import annotations

import secrets

from backend.db import break_glass_repo
from backend.services import auth_service

ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
DEFAULT_MINUTES = 15
MAX_MINUTES = 60
_GROUPS, _GROUP_LEN = 4, 5
# Spent when no live code can match, so timing does not reveal whether one is live.
_DUMMY_HASH = auth_service.hash_password("break-glass-timing")


def new_code() -> str:
    return "-".join(
        "".join(secrets.choice(ALPHABET) for _ in range(_GROUP_LEN)) for _ in range(_GROUPS)
    )


def normalize(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch in ALPHABET)


def issue(user_id: int, minutes: int = DEFAULT_MINUTES) -> tuple[str, int]:
    if not 1 <= minutes <= MAX_MINUTES:
        raise ValueError(f"minutes must be 1..{MAX_MINUTES}")
    code = new_code()
    code_id = break_glass_repo.issue(user_id, auth_service.hash_password(normalize(code)), minutes)
    return code, code_id


def use_code(user_id: int, presented: str) -> int | None:
    """The code row id when `presented` matches the live code and it is now
    used up; None otherwise. Malformed input never reaches bcrypt, and a
    miss still costs one bcrypt check."""
    candidate = normalize(presented)
    well_formed = len(candidate) == _GROUPS * _GROUP_LEN and len(presented) <= 64
    row = break_glass_repo.live(user_id) if well_formed else None
    if row is None:
        auth_service.verify_password(candidate if well_formed else "x", _DUMMY_HASH)
        return None
    if not auth_service.verify_password(candidate, row["code_hash"]):
        return None
    return row["id"] if break_glass_repo.use(row["id"]) else None
