"""Unit tests for backend.services.asset_urls (signed /captured-assets URLs)."""

from urllib.parse import parse_qs, urlsplit

import pytest

from backend.config.settings import settings
from backend.services import asset_urls

DAY = 86400
NOW = 1_800_000_000.0  # arbitrary fixed instant


def _parts(url):
    split = urlsplit(url)
    q = {k: v[0] for k, v in parse_qs(split.query).items()}
    return split.path, q


def _verify(url, **kw):
    path, q = _parts(url)
    rel = path[len("/captured-assets/") :]
    return asset_urls.verify_asset_signature(rel, q.get("u"), q.get("exp"), q.get("sig"), **kw)


class TestSigner:
    def test_url_shape_and_round_trip(self):
        sign = asset_urls.asset_url_signer(7, now=NOW)
        url = sign("user_7/ab/abcdef.png")
        assert url.startswith("/captured-assets/user_7/ab/abcdef.png?u=7&exp=")
        assert _verify(url, now=NOW) == 7

    def test_file_path_not_quoted(self):
        url = asset_urls.asset_url_signer(1, now=NOW)("a b/c+d.png")
        assert url.startswith("/captured-assets/a b/c+d.png?")

    def test_exp_constant_within_utc_day_and_24_to_48h_ahead(self):
        day_start = (int(NOW) // DAY) * DAY
        for offset in (0, 1, DAY // 2, DAY - 1):
            now = day_start + offset
            _, q = _parts(asset_urls.asset_url_signer(1, now=now)("x.png"))
            assert int(q["exp"]) == day_start + 2 * DAY
            assert DAY < int(q["exp"]) - now <= 2 * DAY

    def test_one_signer_shares_exp(self):
        sign = asset_urls.asset_url_signer(1, now=NOW)
        assert _parts(sign("a.png"))[1]["exp"] == _parts(sign("b.png"))[1]["exp"]


class TestVerify:
    def test_tampered_path_fails(self):
        url = asset_urls.asset_url_signer(1, now=NOW)("a.png")
        _, q = _parts(url)
        assert (
            asset_urls.verify_asset_signature("b.png", q["u"], q["exp"], q["sig"], now=NOW) is None
        )

    def test_tampered_user_fails(self):
        _, q = _parts(asset_urls.asset_url_signer(1, now=NOW)("a.png"))
        assert asset_urls.verify_asset_signature("a.png", "2", q["exp"], q["sig"], now=NOW) is None

    def test_tampered_exp_fails(self):
        _, q = _parts(asset_urls.asset_url_signer(1, now=NOW)("a.png"))
        assert (
            asset_urls.verify_asset_signature(
                "a.png", q["u"], str(int(q["exp"]) + 1), q["sig"], now=NOW
            )
            is None
        )

    def test_expired_fails(self):
        url = asset_urls.asset_url_signer(1, now=NOW)("a.png")
        _, q = _parts(url)
        assert _verify(url, now=int(q["exp"]) - 1) == 1
        assert _verify(url, now=int(q["exp"])) is None
        assert _verify(url, now=int(q["exp"]) + 10) is None

    def test_other_jwt_secret_fails(self, monkeypatch):
        url = asset_urls.asset_url_signer(1, now=NOW)("a.png")
        monkeypatch.setattr(settings, "jwt_secret_key", "a-different-secret")
        assert _verify(url, now=NOW) is None

    @pytest.mark.parametrize(
        "u,exp,sig",
        [
            (None, "1", "x"),
            ("1", None, "x"),
            ("1", "9999999999", None),
            ("abc", "9999999999", "x"),
            ("1", "abc", "x"),
            ("1", "9999999999", "!!!"),
            ("", "", ""),
            ("1", "9999999999", "x" * 10000),
        ],
    )
    def test_garbage_fails(self, u, exp, sig):
        assert asset_urls.verify_asset_signature("a.png", u, exp, sig, now=NOW) is None

    @pytest.mark.parametrize("bad", ["+7", " 7", "0_7", "\u0667", "7\n", "-7"])
    def test_non_ascii_digit_user_or_exp_fails(self, bad):
        _, q = _parts(asset_urls.asset_url_signer(7, now=NOW)("a.png"))
        assert asset_urls.verify_asset_signature("a.png", bad, q["exp"], q["sig"], now=NOW) is None
        assert asset_urls.verify_asset_signature("a.png", q["u"], bad, q["sig"], now=NOW) is None
