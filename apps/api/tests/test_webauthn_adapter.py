"""The py_webauthn adapter (owner-passkeys, Task 3)."""
import pytest

from backend.config.settings import settings
from backend.services import webauthn_adapter as wa
from tests.soft_authenticator import SoftAuthenticator

RP = "localhost"
ORIGIN = "http://localhost:3012"


@pytest.fixture(autouse=True)
def rp(monkeypatch):
    monkeypatch.setattr(settings, "webauthn_rp_id", RP)
    monkeypatch.setattr(settings, "webauthn_origin", ORIGIN)


def _register(auth, exclude=()):
    options, challenge = wa.registration_options(
        user_handle=b"h" * 64, user_name="owner@test.local", display_name="Owner", exclude=list(exclude)
    )
    return options, challenge, auth.register(options)


def test_registration_options_require_a_discoverable_verified_passkey():
    options, challenge = wa.registration_options(
        user_handle=b"h" * 64, user_name="owner@test.local", display_name="Owner", exclude=[b"x" * 16]
    )
    assert options["rp"]["id"] == RP
    assert options["authenticatorSelection"]["residentKey"] == "required"
    assert options["authenticatorSelection"]["userVerification"] == "required"
    assert options["attestation"] == "none"
    assert len(options["excludeCredentials"]) == 1
    assert len(challenge) >= 16


def test_authentication_options_allow_any_discoverable_credential():
    options, challenge = wa.authentication_options()
    assert options["rpId"] == RP
    assert options["userVerification"] == "required"
    assert options.get("allowCredentials", []) == []
    assert wa.challenge_of({"response": {"clientDataJSON": ""}}) is None
    assert len(challenge) >= 16


def test_register_then_authenticate_round_trip():
    auth = SoftAuthenticator(RP, ORIGIN)
    _, challenge, response = _register(auth)
    assert wa.challenge_of(response) == challenge
    cred = wa.verify_registration(response, challenge=challenge)
    assert cred.credential_id == auth.credential_id
    assert cred.backup_eligible is True and cred.backed_up is True
    assert cred.transports == ["internal", "hybrid"]

    options, challenge = wa.authentication_options()
    assertion = auth.authenticate(options)
    assert wa.credential_id_of(assertion) == auth.credential_id
    assert wa.user_handle_of(assertion) == b"h" * 64
    result = wa.verify_authentication(assertion, challenge=challenge, public_key=cred.public_key)
    assert result.new_sign_count == 0 and result.backed_up is True


def test_wrong_origin_is_refused():
    auth = SoftAuthenticator(RP, ORIGIN)
    options, challenge = wa.registration_options(
        user_handle=b"h" * 64, user_name="o", display_name="o", exclude=[]
    )
    response = auth.register(options, origin="https://evil.example.com")
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(response, challenge=challenge)


def test_wrong_challenge_is_refused():
    auth = SoftAuthenticator(RP, ORIGIN)
    _, _, response = _register(auth)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(response, challenge=b"z" * 32)


def test_signature_from_another_key_is_refused():
    auth = SoftAuthenticator(RP, ORIGIN)
    _, challenge, response = _register(auth)
    cred = wa.verify_registration(response, challenge=challenge)
    other = SoftAuthenticator(RP, ORIGIN)
    other.credential_id, other.user_handle = auth.credential_id, auth.user_handle
    options, challenge = wa.authentication_options()
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(other.authenticate(options), challenge=challenge, public_key=cred.public_key)


@pytest.mark.parametrize(
    "garbage",
    [
        {},
        {"response": {}},
        {"id": "!!", "rawId": "!!", "type": "public-key", "response": {"clientDataJSON": "%%%"}},
        {"id": "AA", "rawId": "AA", "type": "public-key", "response": {"clientDataJSON": "AA", "attestationObject": "AA"}},
        {"response": "not-a-dict"},
    ],
)
def test_garbage_responses_never_raise_anything_but_webauthn_error(garbage):
    assert wa.challenge_of(garbage) is None
    assert wa.user_handle_of(garbage) is None
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(garbage, challenge=b"c" * 32)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(garbage, challenge=b"c" * 32, public_key=b"k" * 77)


def test_non_dict_responses_are_tolerated_by_the_readers():
    for value in (None, "x", 3, []):
        assert wa.challenge_of(value) is None
        assert wa.credential_id_of(value) is None
        assert wa.user_handle_of(value) is None


def test_over_nested_client_data_never_escapes():
    nested = "[" * 100000
    import base64

    cd = base64.urlsafe_b64encode(nested.encode()).rstrip(b"=").decode()
    resp = {"id": "AA", "rawId": "AA", "type": "public-key", "response": {"clientDataJSON": cd}}
    assert wa.challenge_of(resp) is None
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(resp, challenge=b"c" * 32)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(resp, challenge=b"c" * 32, public_key=b"k" * 77)


def _registration_with(auth, mutate):
    options, challenge = wa.registration_options(
        user_handle=b"h" * 64, user_name="o", display_name="o", exclude=[]
    )
    response = auth.register(options)
    mutate(response)
    return response, challenge


def test_non_map_cose_key_is_refused(monkeypatch):
    auth = SoftAuthenticator(RP, ORIGIN)
    monkeypatch.setattr(auth, "_cose_public_key", lambda: __import__("cbor2").dumps([1, 2, 3]))
    response, challenge = _registration_with(auth, lambda r: None)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(response, challenge=challenge)


def test_non_list_transports_are_dropped():
    auth = SoftAuthenticator(RP, ORIGIN)
    response, challenge = _registration_with(auth, lambda r: r["response"].__setitem__("transports", 5))
    assert wa.verify_registration(response, challenge=challenge).transports == []


def test_transports_are_filtered_to_known_values():
    auth = SoftAuthenticator(RP, ORIGIN)
    response, challenge = _registration_with(
        auth, lambda r: r["response"].__setitem__("transports", ["usb", "bogus", 3, "hybrid"])
    )
    assert wa.verify_registration(response, challenge=challenge).transports == ["usb", "hybrid"]
    response, challenge = _registration_with(auth, lambda r: r["response"].__setitem__("transports", "usb"))
    assert wa.verify_registration(response, challenge=challenge).transports == []


def test_oversized_credential_id_is_refused():
    auth = SoftAuthenticator(RP, ORIGIN)
    auth.credential_id = b"i" * 1024
    response, challenge = _registration_with(auth, lambda r: None)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(response, challenge=challenge)


def test_registration_without_user_verification_is_refused():
    auth = SoftAuthenticator(RP, ORIGIN, user_verified=False)
    response, challenge = _registration_with(auth, lambda r: None)
    with pytest.raises(wa.WebAuthnError):
        wa.verify_registration(response, challenge=challenge)


def _enrolled():
    auth = SoftAuthenticator(RP, ORIGIN)
    response, challenge = _registration_with(auth, lambda r: None)
    return auth, wa.verify_registration(response, challenge=challenge)


def test_authentication_without_user_verification_is_refused():
    auth, cred = _enrolled()
    auth.user_verified = False
    options, challenge = wa.authentication_options()
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(auth.authenticate(options), challenge=challenge, public_key=cred.public_key)


def test_authentication_wrong_origin_is_refused():
    auth, cred = _enrolled()
    options, challenge = wa.authentication_options()
    response = auth.authenticate(options, origin="https://evil.example.com")
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(response, challenge=challenge, public_key=cred.public_key)


def test_authentication_wrong_rp_id_hash_is_refused():
    auth, cred = _enrolled()
    auth.rp_id = "other.example.com"
    options, challenge = wa.authentication_options()
    with pytest.raises(wa.WebAuthnError):
        wa.verify_authentication(auth.authenticate(options), challenge=challenge, public_key=cred.public_key)
