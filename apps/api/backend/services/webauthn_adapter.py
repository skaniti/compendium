"""The only module that calls py_webauthn (owner-passkeys).

Options go out as JSON-ready dicts (what @simplewebauthn/browser expects as
optionsJSON), browser responses come in as their JSON, and every refusal or
parse failure becomes WebAuthnError, so callers never see library types or
library exceptions. The relying party comes from settings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    CredentialDeviceType,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from backend.config.settings import settings

TIMEOUT_MS = 60_000
_ALGORITHMS = [
    COSEAlgorithmIdentifier.ECDSA_SHA_256,
    COSEAlgorithmIdentifier.EDDSA,
    COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
]
_TRANSPORTS = frozenset(t.value for t in AuthenticatorTransport)
MAX_CREDENTIAL_ID_BYTES = 1023  # WebAuthn spec limit


class WebAuthnError(Exception):
    """A browser response py_webauthn refused or could not parse."""


@dataclass(frozen=True)
class NewCredential:
    credential_id: bytes
    public_key: bytes
    sign_count: int
    aaguid: str
    backup_eligible: bool
    backed_up: bool
    transports: list[str]


@dataclass(frozen=True)
class Assertion:
    new_sign_count: int
    backed_up: bool


def registration_options(
    *, user_handle: bytes, user_name: str, display_name: str, exclude: list[bytes]
) -> tuple[dict, bytes]:
    options = generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_name=user_name,
        user_id=user_handle,
        user_display_name=display_name,
        timeout=TIMEOUT_MS,
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=cid) for cid in exclude],
        supported_pub_key_algs=_ALGORITHMS,
    )
    return json.loads(options_to_json(options)), options.challenge


def authentication_options() -> tuple[dict, bytes]:
    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        timeout=TIMEOUT_MS,
        allow_credentials=[],
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return json.loads(options_to_json(options)), options.challenge


def verify_registration(response: dict, *, challenge: bytes) -> NewCredential:
    try:
        verified = verify_registration_response(
            credential=response,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_expected_origin,
            require_user_verification=True,
            supported_pub_key_algs=_ALGORITHMS,
        )
        raw_transports = response["response"].get("transports")
        transports = (
            [t for t in raw_transports if isinstance(t, str) and t in _TRANSPORTS][:8]
            if isinstance(raw_transports, list)
            else []
        )
        if len(verified.credential_id) > MAX_CREDENTIAL_ID_BYTES:
            raise WebAuthnError("credential id too long")
        return NewCredential(
            credential_id=verified.credential_id,
            public_key=verified.credential_public_key,
            sign_count=verified.sign_count,
            aaguid=str(verified.aaguid),
            backup_eligible=verified.credential_device_type == CredentialDeviceType.MULTI_DEVICE,
            backed_up=bool(verified.credential_backed_up),
            transports=transports,
        )
    except WebAuthnError:
        raise
    except Exception as exc:
        raise WebAuthnError(str(exc)) from exc


def verify_authentication(response: dict, *, challenge: bytes, public_key: bytes) -> Assertion:
    try:
        verified = verify_authentication_response(
            credential=response,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_expected_origin,
            credential_public_key=public_key,
            # 0 switches off the library's own counter check; the service
            # applies the WebAuthn rule (refuse when either counter is nonzero
            # and the new one is not larger; see services/passkeys.py).
            credential_current_sign_count=0,
            require_user_verification=True,
        )
        return Assertion(new_sign_count=verified.new_sign_count, backed_up=bool(verified.credential_backed_up))
    except Exception as exc:
        raise WebAuthnError(str(exc)) from exc


def _b64(value) -> bytes | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return base64url_to_bytes(value)
    except Exception:
        return None


def challenge_of(response) -> bytes | None:
    """The challenge inside the response's clientDataJSON, or None."""
    try:
        raw = _b64(response["response"]["clientDataJSON"])
        if raw is None:
            return None
        return _b64(json.loads(raw).get("challenge"))
    except Exception:
        return None


def credential_id_of(response) -> bytes | None:
    try:
        return _b64(response.get("rawId"))
    except Exception:
        return None


def user_handle_of(response) -> bytes | None:
    try:
        return _b64(response["response"].get("userHandle"))
    except Exception:
        return None
