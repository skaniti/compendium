"""A software WebAuthn authenticator for tests (owner-passkeys).

Produces real "none"-attestation registrations and ES256 assertions, so
py_webauthn's verification runs for real against them. Flags: user present,
user verified, and (by default) backup eligible + backed up, like a synced
1Password passkey.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class SoftAuthenticator:
    AAGUID = bytes(16)

    def __init__(self, rp_id: str, origin: str, *, backup_eligible: bool = True, sign_count_step: int = 0, user_verified: bool = True):
        self.rp_id = rp_id
        self.origin = origin
        self.backup_eligible = backup_eligible
        self.sign_count_step = sign_count_step
        self.user_verified = user_verified
        self.sign_count = 0
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.user_handle: bytes | None = None

    def _cose_public_key(self) -> bytes:
        nums = self.key.public_key().public_numbers()
        return cbor2.dumps(
            {1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")}
        )

    def _authenticator_data(self, *, attested: bool) -> bytes:
        flags = 0x01  # user present
        if self.user_verified:
            flags |= 0x04
        if self.backup_eligible:
            flags |= 0x08 | 0x10  # backup eligible, backed up
        if attested:
            flags |= 0x40  # attested credential data included
        data = hashlib.sha256(self.rp_id.encode()).digest() + bytes([flags]) + struct.pack(">I", self.sign_count)
        if attested:
            data += self.AAGUID + struct.pack(">H", len(self.credential_id)) + self.credential_id
            data += self._cose_public_key()
        return data

    def _client_data(self, kind: str, challenge: str, origin: str | None) -> bytes:
        return json.dumps(
            {"type": kind, "challenge": challenge, "origin": origin or self.origin, "crossOrigin": False}
        ).encode()

    def register(self, options: dict, *, origin: str | None = None) -> dict:
        self.user_handle = unb64u(options["user"]["id"])
        client_data = self._client_data("webauthn.create", options["challenge"], origin)
        attestation = cbor2.dumps(
            {"fmt": "none", "attStmt": {}, "authData": self._authenticator_data(attested=True)}
        )
        cid = b64u(self.credential_id)
        return {
            "id": cid,
            "rawId": cid,
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64u(client_data),
                "attestationObject": b64u(attestation),
                "transports": ["internal", "hybrid"],
            },
        }

    def authenticate(self, options: dict, *, origin: str | None = None, user_handle: bytes | None = None) -> dict:
        self.sign_count += self.sign_count_step
        client_data = self._client_data("webauthn.get", options["challenge"], origin)
        auth_data = self._authenticator_data(attested=False)
        signature = self.key.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        handle = user_handle if user_handle is not None else self.user_handle
        cid = b64u(self.credential_id)
        return {
            "id": cid,
            "rawId": cid,
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64u(client_data),
                "authenticatorData": b64u(auth_data),
                "signature": b64u(signature),
                "userHandle": b64u(handle) if handle else None,
            },
        }
