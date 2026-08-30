"""Tests for backend.utils.url_normalize.

Every fixture here doubles as a parity spec: the JS implementation in
``extension/modules/utils.js::normalizeUrlForDedup`` (after Phase 2 upgrades)
must produce identical output on these same inputs. If you change either
implementation, run both against this fixture list.
"""

import pytest

from backend.utils.url_normalize import TRACKING_PARAMS, normalize_url


class TestBasics:
    def test_empty_string_returns_empty(self):
        assert normalize_url("") == ""

    def test_plain_url_unchanged(self):
        assert normalize_url("https://example.com/foo") == "https://example.com/foo"

    def test_root_path_keeps_slash(self):
        assert normalize_url("https://example.com/") == "https://example.com/"

    def test_trailing_slash_stripped(self):
        assert normalize_url("https://example.com/foo/") == "https://example.com/foo"

    def test_nested_trailing_slash_stripped(self):
        assert normalize_url("https://example.com/a/b/c/") == "https://example.com/a/b/c"


class TestFragment:
    def test_fragment_stripped(self):
        assert normalize_url("https://example.com/page#section") == "https://example.com/page"

    def test_fragment_with_query_stripped(self):
        assert (
            normalize_url("https://example.com/page?x=1#section") == "https://example.com/page?x=1"
        )

    def test_empty_fragment_stripped(self):
        assert normalize_url("https://example.com/page#") == "https://example.com/page"


class TestHostCasing:
    def test_uppercase_host_lowercased(self):
        assert normalize_url("https://Example.COM/path") == "https://example.com/path"

    def test_mixed_case_host_lowercased(self):
        assert normalize_url("https://WWW.Example.Com/Foo/Bar") == "https://www.example.com/Foo/Bar"

    def test_path_case_preserved(self):
        # GitHub URLs are case-sensitive on the path — this invariant is load-bearing.
        assert (
            normalize_url("https://github.com/SomeOrg/SomeRepo")
            == "https://github.com/SomeOrg/SomeRepo"
        )

    def test_port_preserved(self):
        assert normalize_url("https://Example.com:8080/foo") == "https://example.com:8080/foo"

    def test_userinfo_preserved(self):
        assert (
            normalize_url("https://user:pass@Example.com/foo")
            == "https://user:pass@example.com/foo"
        )

    def test_ipv6_host_preserved(self):
        assert normalize_url("https://[::1]:8080/foo") == "https://[::1]:8080/foo"


class TestTrackingParams:
    @pytest.mark.parametrize("param", sorted(TRACKING_PARAMS))
    def test_each_tracking_param_stripped(self, param):
        url = f"https://example.com/page?{param}=xyz"
        assert normalize_url(url) == "https://example.com/page"

    def test_mixed_tracking_and_real_params(self):
        assert (
            normalize_url("https://example.com/page?utm_source=google&id=42&fbclid=abc")
            == "https://example.com/page?id=42"
        )

    def test_all_tracking_removes_query(self):
        assert (
            normalize_url("https://example.com/page?utm_source=a&utm_medium=b")
            == "https://example.com/page"
        )


class TestQueryParamSorting:
    def test_params_sorted_alphabetically(self):
        assert (
            normalize_url("https://example.com/?z=3&a=1&m=2") == "https://example.com/?a=1&m=2&z=3"
        )

    def test_sort_is_stable_for_repeated_keys(self):
        # Two ?a values should retain their relative order (1 before 2).
        assert (
            normalize_url("https://example.com/?a=1&a=2&b=3") == "https://example.com/?a=1&a=2&b=3"
        )

    def test_different_param_orders_normalize_identically(self):
        # The whole point of sorting.
        a = normalize_url("https://example.com/?x=1&y=2")
        b = normalize_url("https://example.com/?y=2&x=1")
        assert a == b


class TestBlankValues:
    def test_blank_param_value_preserved(self):
        # "?foo=" is distinct from "?foo" and both are distinct from no param.
        # Some sites use blank-valued keys as feature flags.
        assert normalize_url("https://example.com/?foo=") == "https://example.com/?foo="


class TestMalformed:
    def test_malformed_url_returned_unchanged(self):
        # urlsplit is quite permissive and will happily parse "not a url" as a path.
        # We don't try to validate — we just round-trip through urlsplit/urlunsplit.
        result = normalize_url("not a url")
        # Will normalize to "not a url" (path-only, no scheme/host)
        assert "not a url" in result

    def test_chrome_internal_url_passes_through(self):
        # about: / chrome: / etc. have no netloc. urlsplit handles them.
        assert normalize_url("about:blank") == "about:blank"


class TestDedupScenarios:
    """Integration-style tests mirroring real failure modes from the plan."""

    def test_utm_variants_collapse(self):
        # The canonical cross-capture dup case.
        a = normalize_url("https://example.com/page?utm_source=a")
        b = normalize_url("https://example.com/page?utm_source=b")
        assert a == b == "https://example.com/page"

    def test_trailing_slash_variants_collapse(self):
        a = normalize_url("https://example.com/article")
        b = normalize_url("https://example.com/article/")
        assert a == b

    def test_host_case_variants_collapse(self):
        a = normalize_url("https://Zillow.com/homedetails/123")
        b = normalize_url("https://zillow.com/homedetails/123")
        assert a == b

    def test_param_reorder_variants_collapse(self):
        a = normalize_url("https://example.com/s?q=foo&page=2")
        b = normalize_url("https://example.com/s?page=2&q=foo")
        assert a == b


class TestDomainSpecificParamStrips:
    """Per-domain param strips (RC-B), layered on top of TRACKING_PARAMS.

    Each rule gets a folding case (param dropped on the matching domain)
    and a non-matching guard (the same param survives on any other host).
    """

    def test_luma_tk_stripped(self):
        assert normalize_url("https://luma.com/ev1234?tk=aBcDeF") == "https://luma.com/ev1234"

    def test_luma_tk_stripped_on_subdomain(self):
        # luma.com is explicitly "+subdomains" per spec.
        assert (
            normalize_url("https://events.luma.com/ev1234?tk=aBcDeF")
            == "https://events.luma.com/ev1234"
        )

    def test_tk_preserved_on_non_luma_host(self):
        assert (
            normalize_url("https://example.com/page?tk=abc") == "https://example.com/page?tk=abc"
        )

    def test_zillow_mmlb_stripped(self):
        assert (
            normalize_url("https://www.zillow.com/homedetails/123_zpid/?mmlb=g,0")
            == "https://www.zillow.com/homedetails/123_zpid"
        )

    def test_zillow_mmlb_stripped_bare_apex(self):
        # Real capture data uses "www.zillow.com"; the bare apex must match too.
        assert (
            normalize_url("https://zillow.com/homedetails/123_zpid/?mmlb=g,1")
            == "https://zillow.com/homedetails/123_zpid"
        )

    def test_mmlb_preserved_on_non_zillow_host(self):
        # ',' round-trips through urlencode as '%2C' — value is otherwise untouched.
        assert (
            normalize_url("https://example.com/page?mmlb=g,0")
            == "https://example.com/page?mmlb=g%2C0"
        )

    def test_github_tab_stripped(self):
        assert (
            normalize_url("https://github.com/octocat/hello-world?tab=readme-ov-file")
            == "https://github.com/octocat/hello-world"
        )

    def test_tab_preserved_on_non_github_host(self):
        # Explicit guard from the plan: `tab` must survive elsewhere.
        assert (
            normalize_url("https://example.com/docs?tab=readme-ov-file")
            == "https://example.com/docs?tab=readme-ov-file"
        )

    def test_github_tab_stripped_alongside_other_params(self):
        a = normalize_url("https://github.com/octoexample?tab=repositories")
        b = normalize_url("https://github.com/octoexample?tab=overview&from=2021-12-01&to=2021-12-31")
        # Both retain their distinct real params after `tab` is dropped;
        # they should NOT collapse to the same normalized URL.
        assert a == "https://github.com/octoexample"
        assert b == "https://github.com/octoexample?from=2021-12-01&to=2021-12-31"
        assert a != b


class TestDomainSpecificPathFolds:
    """Per-domain path folds (RC-B): structural sub-paths collapsed onto
    their canonical parent. Each rule gets a folding case and a
    non-matching guard.
    """

    def test_thingiverse_comments_folded(self):
        assert (
            normalize_url("https://www.thingiverse.com/thing:1234567/comments")
            == "https://www.thingiverse.com/thing:1234567"
        )

    def test_thingiverse_thing_page_without_comments_unchanged(self):
        assert (
            normalize_url("https://www.thingiverse.com/thing:1234567")
            == "https://www.thingiverse.com/thing:1234567"
        )

    def test_thingiverse_fold_scoped_to_thingiverse_host(self):
        # Same /thing:<id>/comments shape on an unrelated host must not fold.
        assert (
            normalize_url("https://example.com/thing:1234567/comments")
            == "https://example.com/thing:1234567/comments"
        )

    def test_printables_comments_folded(self):
        assert (
            normalize_url(
                "https://www.printables.com/model/1000001-widget-stand-modular/comments"
            )
            == "https://www.printables.com/model/1000001-widget-stand-modular"
        )

    def test_printables_files_folded(self):
        assert (
            normalize_url("https://www.printables.com/model/1000002-cable-clip-parametric/files")
            == "https://www.printables.com/model/1000002-cable-clip-parametric"
        )

    def test_printables_bare_apex_also_folds(self):
        # Real capture data uses "www.printables.com"; the bare apex domain
        # entry must match it as a subdomain (and match itself too).
        assert (
            normalize_url("https://printables.com/model/1000001-widget-stand-modular/files")
            == "https://printables.com/model/1000001-widget-stand-modular"
        )

    def test_printables_model_root_without_tab_unchanged(self):
        assert (
            normalize_url("https://www.printables.com/model/1000001-widget-stand-modular")
            == "https://www.printables.com/model/1000001-widget-stand-modular"
        )

    def test_printables_unrelated_subpath_unchanged(self):
        # /collections is a real printables sub-path but not one we fold.
        assert (
            normalize_url(
                "https://www.printables.com/model/1000003-desk-organizer-stackable/collections"
            )
            == "https://www.printables.com/model/1000003-desk-organizer-stackable/collections"
        )


class TestPortPreservationUnaffected:
    """Domain-rule additions must not disturb the deliberate port-preservation
    invariant (localhost folding is explicitly out of scope — see spec.md)."""

    def test_port_preserved_on_domain_ruled_host(self):
        assert (
            normalize_url("https://github.com:8443/octocat/hello-world?tab=readme-ov-file")
            == "https://github.com:8443/octocat/hello-world"
        )

    def test_localhost_not_folded(self):
        a = normalize_url("http://localhost:8050/page")
        b = normalize_url("http://localhost:8051/page")
        assert a != b
