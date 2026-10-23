"""Client naming for rejected requests (backlog #77): pure header parsing.

No DB. Headers are plain dicts (Starlette's Headers is case-insensitive;
describe() lowercases lookups itself via a CIMultiDict-like wrapper in the
tests below).
"""

from urllib.parse import quote

import pytest
from starlette.datastructures import Headers

from backend.api import client_identity as ci


def _h(**kw):
    return Headers({k.replace("_", "-"): v for k, v in kw.items()})


def test_declared_extension_with_version_and_device():
    out = ci.describe(
        _h(
            x_compendium_client="extension/0.5.1",
            x_compendium_device="Desktop%20Firefox",
            user_agent="Mozilla/5.0 Firefox/130",
            origin="moz-extension://abc",
        )
    )
    assert out == {
        "client": "extension",
        "client_version": "0.5.1",
        "device": "Desktop Firefox",
        "origin": "moz-extension://abc",
        "user_agent": "Mozilla/5.0 Firefox/130",
    }


def test_declared_android_without_version():
    assert ci.describe(_h(x_compendium_client="android"))["client"] == "android"
    assert "client_version" not in ci.describe(_h(x_compendium_client="android"))


def test_kind_is_case_insensitive():
    out = ci.describe(_h(x_compendium_client="Android/2.1"))
    assert (out["client"], out["client_version"]) == ("android", "2.1")


def test_unknown_declared_kind_is_not_echoed():
    out = ci.describe(_h(x_compendium_client="evil-scanner/9"))
    assert out["client"] == "unknown"
    assert "client_version" not in out
    assert "evil-scanner" not in str(out)


def test_malformed_declared_value_falls_back_to_inference():
    out = ci.describe(_h(x_compendium_client="extension/<script>", origin="https://app.example"))
    assert out["client"] == "web"
    assert "client_version" not in out


def test_extension_inferred_from_extension_origin():
    # An older build predating the header, or a preflight (no custom headers).
    for origin in ("moz-extension://uuid", "chrome-extension://id"):
        assert ci.describe(_h(origin=origin))["client"] == "extension"


def test_web_inferred_from_http_origin_or_sec_fetch_mode():
    assert ci.describe(_h(origin="https://x.example"))["client"] == "web"
    assert ci.describe(_h(sec_fetch_mode="cors"))["client"] == "web"


def test_no_signal_is_unknown():
    # Android's UA is browser-shaped, so a UA alone must not read as web.
    out = ci.describe(_h(user_agent="Mozilla/5.0 (Linux; Android 14) Chrome/120"))
    assert out["client"] == "unknown"
    assert out["user_agent"].startswith("Mozilla/5.0")
    assert ci.describe(_h())["client"] == "unknown"


def test_declared_header_wins_over_inference():
    out = ci.describe(_h(x_compendium_client="android/2.1", origin="https://x.example"))
    assert out["client"] == "android"
    assert out["origin"] == "https://x.example"


def test_values_are_truncated():
    # Dotted, so the 48+ char token shape (redacted whole) does not fire.
    out = ci.describe(
        _h(
            x_compendium_device="ab." * 200,
            origin="https://" + "ab." * 200,
            user_agent="ab." * 400,
        )
    )
    assert len(out["device"]) == 64
    assert len(out["origin"]) == 100
    assert len(out["user_agent"]) == 200


def test_control_and_bidi_characters_are_stripped():
    out = ci.describe(
        _h(
            x_compendium_device="Lap%0Atop%00%E2%80%AEevil",  # LF, NUL, U+202E
            user_agent="ua\x1b[31m\x7f-x",
        )
    )
    assert out["device"] == "Lap top evil"
    assert not any(c in out["user_agent"] for c in "\x1b\x7f")


def test_device_percent_decoding_is_utf8_and_never_raises():
    assert (
        ci.describe(_h(x_compendium_device="Caf%C3%A9%20%F0%9F%93%B1"))["device"]
        == "Caf\u00e9 \U0001f4f1"
    )
    # Invalid UTF-8 and a dangling escape degrade to replacement characters.
    out = ci.describe(_h(x_compendium_device="bad%FF%"))
    assert out["device"].startswith("bad")


def test_empty_device_and_blank_values_are_omitted():
    out = ci.describe(_h(x_compendium_device="   ", origin="", user_agent=""))
    assert set(out) == {"client"}


def test_describe_never_raises():
    class Boom:
        def get(self, *_a, **_k):
            raise RuntimeError("no headers for you")

    assert ci.describe(Boom()) == {"client": "unknown"}


def test_rejection_fields_for_a_plain_4xx_are_just_the_identity():
    out = ci.rejection_log_fields(
        method="POST",
        status_code=401,
        headers=_h(x_compendium_client="extension/0.5.1"),
        allowed_origins=["*"],
    )
    assert out["client"] == "extension"
    assert "cors_preflight_rejected" not in out


def test_rejected_preflight_is_flagged_with_requested_method_and_headers():
    out = ci.rejection_log_fields(
        method="OPTIONS",
        status_code=400,
        headers=_h(
            origin="https://stale.example",
            access_control_request_method="POST",
            access_control_request_headers="content-type,x-api-key",
        ),
        allowed_origins=["https://app.example"],
    )
    assert out["cors_preflight_rejected"] is True
    assert out["cors_origin_allowed"] is False
    assert out["cors_request_method"] == "POST"
    assert out["cors_request_headers"] == "content-type,x-api-key"
    assert out["origin"] == "https://stale.example"
    assert out["client"] == "web"


def test_preflight_for_an_allowed_origin_that_still_400s_reports_origin_allowed():
    out = ci.rejection_log_fields(
        method="OPTIONS",
        status_code=400,
        headers=_h(origin="https://app.example", access_control_request_method="PATCH"),
        allowed_origins=["https://app.example"],
    )
    assert out["cors_origin_allowed"] is True


def test_options_without_preflight_headers_is_not_flagged():
    out = ci.rejection_log_fields(
        method="OPTIONS",
        status_code=400,
        headers=_h(origin="https://x.example"),
        allowed_origins=[],
    )
    assert "cors_preflight_rejected" not in out


def test_rejection_fields_redact_credential_shaped_values():
    key = "cmp_" + "ab12" * 8  # assembled at runtime; shape only
    out = ci.rejection_log_fields(
        method="POST",
        status_code=401,
        headers=_h(x_compendium_device=key, user_agent=key, origin="https://" + key),
        allowed_origins=["*"],
    )
    assert key not in str(out)
    assert out["device"] == "<redacted>"
    assert out["user_agent"] == "<redacted>"


def _straddling(limit):
    """41-char-style prefix sized so a cmp_ key crosses the cap with 23 of its
    36 characters (cmp_ + 19) on the kept side: too short to match
    cmp_[A-Za-z0-9_-]{20,} on its own, which is what a truncate-then-redact
    order would leave behind."""
    key = "cmp_" + "ab12" * 8
    prefix = ("x. " * limit)[: limit - 23]
    return key, prefix + key


@pytest.mark.parametrize(
    ("header", "field", "limit"),
    [
        ("x-compendium-device", "device", 64),
        ("origin", "origin", 100),
        ("user-agent", "user_agent", 200),
    ],
)
def test_key_straddling_the_cap_is_redacted_whole_not_half_kept(header, field, limit):
    key, value = _straddling(limit)
    sent = quote(value) if header == "x-compendium-device" else value
    out = ci.describe(_h(**{header.replace("-", "_"): sent}))
    assert out[field] == "<redacted>"
    assert "cmp_" not in str(out)
    # Same through the log-line path.
    fields = ci.rejection_log_fields(
        method="GET",
        status_code=401,
        headers=_h(**{header.replace("-", "_"): sent}),
        allowed_origins=["*"],
    )
    assert fields[field] == "<redacted>"
    assert key[:12] not in str(fields)


def test_a_long_unbroken_token_is_redacted_whole():
    out = ci.describe(_h(user_agent="u" * 500))
    assert out["user_agent"] == "<redacted>"


def test_redaction_does_not_change_the_inferred_kind():
    key = "cmp_" + "ab12" * 8
    assert ci.describe(_h(origin="https://" + key)) == {"client": "web", "origin": "<redacted>"}


def test_line_paragraph_and_arabic_letter_marks_are_stripped():
    # U+2028, U+2029, U+061C percent-decoded from a device label.
    out = ci.describe(_h(x_compendium_device="a%E2%80%A8b%E2%80%A9c%D8%9Cd"))
    assert out["device"] == "abcd"
