"""Passkey ceremonies for the owner (owner-passkeys): enrollment links,
registration and sign-in. The router does HTTP, audit and the session; this
module decides, and raises PasskeyFailure(reason) for every refusal. Reasons
are audit vocabulary (spec 5.2): enrollment -- unknown, expired, used,
identity, verify; sign-in -- no_passkey, challenge, credential,
account_mismatch, verify, counter.
"""

from __future__ import annotations

import hashlib
import logging
import secrets

from psycopg2 import errors as pg_errors

from backend.config.settings import settings
from backend.db import passkey_repo
from backend.services import tailnet_login, webauthn_adapter

logger = logging.getLogger(__name__)

ENROLL_MINUTES = 10
CHALLENGE_MINUTES = 5


class PasskeyFailure(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def enabled() -> bool:
    """Passkeys are on only with a relying party AND the tailnet login."""
    return bool(settings.webauthn_rp_id) and tailnet_login.enabled()


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_enrollment(user_id: int, label: str | None, minutes: int = ENROLL_MINUTES) -> tuple[str, int]:
    raw = secrets.token_urlsafe(32)
    return raw, passkey_repo.create_enrollment(user_id, hash_token(raw), label, minutes)


def enrollment_link(raw: str) -> str:
    # The token sits in the fragment, so it never reaches a server log.
    return f"{settings.webauthn_expected_origin}/passkey/enroll#{raw}"


def _usable_enrollment(user: dict, raw_token: str) -> dict:
    enrollment = passkey_repo.get_enrollment(hash_token(raw_token))
    if enrollment is None:
        raise PasskeyFailure("unknown")
    if enrollment["consumed"]:
        raise PasskeyFailure("used")
    if enrollment["expired"]:
        raise PasskeyFailure("expired")
    if enrollment["user_id"] != user["id"]:
        raise PasskeyFailure("identity")
    return enrollment


def enroll_options(user: dict, raw_token: str) -> dict:
    enrollment = _usable_enrollment(user, raw_token)
    options, challenge = webauthn_adapter.registration_options(
        user_handle=passkey_repo.get_or_create_user_handle(user["id"]),
        user_name=user["email"],
        display_name=user.get("name") or user["email"],
        exclude=passkey_repo.active_credential_ids(user["id"]),
    )
    passkey_repo.create_challenge(
        "register", challenge, user["id"], enrollment_id=enrollment["id"], minutes=CHALLENGE_MINUTES
    )
    return options


def enroll_verify(user: dict, raw_token: str, response: dict) -> tuple[int, str | None, bool]:
    enrollment = _usable_enrollment(user, raw_token)
    challenge = webauthn_adapter.challenge_of(response)
    issued = passkey_repo.consume_challenge("register", challenge) if challenge else None
    if issued is None or issued["enrollment_id"] != enrollment["id"] or issued["user_id"] != user["id"]:
        raise PasskeyFailure("verify")
    try:
        cred = webauthn_adapter.verify_registration(response, challenge=challenge)
    except webauthn_adapter.WebAuthnError as exc:
        logger.warning("passkey %s refused by verifier: %s", "registration", str(exc)[:200])
        raise PasskeyFailure("verify") from None
    # Consumed only after a verified response, so a failed attempt can retry
    # with the same link; the atomic consume makes a second success a "used".
    if not passkey_repo.consume_enrollment(enrollment["id"]):
        raise PasskeyFailure("used")
    try:
        row_id = passkey_repo.add_credential(
            user["id"],
            credential_id=cred.credential_id,
            public_key=cred.public_key,
            sign_count=cred.sign_count,
            transports=cred.transports,
            aaguid=cred.aaguid,
            backup_eligible=cred.backup_eligible,
            backed_up=cred.backed_up,
            label=enrollment["label"],
        )
    except pg_errors.UniqueViolation:
        raise PasskeyFailure("verify") from None
    return row_id, enrollment["label"], cred.backup_eligible


def login_options(user: dict) -> dict:
    if passkey_repo.count_active(user["id"]) == 0:
        raise PasskeyFailure("no_passkey")
    options, challenge = webauthn_adapter.authentication_options()
    passkey_repo.create_challenge("authenticate", challenge, user["id"], minutes=CHALLENGE_MINUTES)
    return options


def login_verify(user: dict, response: dict) -> dict:
    challenge = webauthn_adapter.challenge_of(response)
    issued = passkey_repo.consume_challenge("authenticate", challenge) if challenge else None
    if issued is None or issued["user_id"] != user["id"]:
        raise PasskeyFailure("challenge")
    credential_id = webauthn_adapter.credential_id_of(response)
    cred = passkey_repo.get_active_credential(credential_id) if credential_id else None
    if cred is None:
        raise PasskeyFailure("credential")
    if cred["user_id"] != user["id"]:
        raise PasskeyFailure("account_mismatch")
    handle = webauthn_adapter.user_handle_of(response)
    if handle is None or handle != passkey_repo.get_user_handle(user["id"]):
        raise PasskeyFailure("account_mismatch")
    try:
        result = webauthn_adapter.verify_authentication(
            response, challenge=challenge, public_key=cred["public_key"]
        )
    except webauthn_adapter.WebAuthnError as exc:
        logger.warning("passkey %s refused by verifier: %s", "authentication", str(exc)[:200])
        raise PasskeyFailure("verify") from None
    # WebAuthn's standard rule: when either counter is nonzero the new one must
    # be larger. Synced passkeys that never count (both 0) still pass.
    if (cred["sign_count"] > 0 or result.new_sign_count > 0) and result.new_sign_count <= cred["sign_count"]:
        raise PasskeyFailure("counter")
    passkey_repo.record_use(cred["id"], result.new_sign_count, result.backed_up)
    return cred
