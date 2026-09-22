from __future__ import annotations

import pytest

from app.core.urls import url_key
from app.crawler.urls import SiteScope, is_asset, looks_like_trap, normalize_crawl_url


@pytest.mark.parametrize(
    "variant",
    [
        "https://example.com/page",
        "https://example.com/page/",
        "https://example.com/page/#section",
        "https://example.com/page?utm_source=x",
        "https://example.com/page?utm_campaign=x&utm_medium=y",
        "https://example.com/page/?gclid=abc&fbclid=def",
        "HTTPS://EXAMPLE.COM:443/page#top",
        "https://example.com//page",
    ],
)
def test_variants_normalise_to_one_page(variant: str) -> None:
    normalised = normalize_crawl_url(variant)
    assert normalised is not None
    assert "#" not in normalised and "utm_" not in normalised and "clid" not in normalised
    assert url_key(normalised) == url_key("https://example.com/page")


def test_meaningful_query_parameters_are_kept_and_sorted() -> None:
    assert normalize_crawl_url("https://example.com/list?page=2&utm_source=x&cat=ai") == (
        "https://example.com/list?cat=ai&page=2"
    )
    assert url_key(normalize_crawl_url("/list?page=2", "https://example.com/") or "") != url_key(
        "https://example.com/list"
    )


@pytest.mark.parametrize(
    "raw", ["mailto:a@example.com", "tel:+123", "javascript:void(0)", "ftp://example.com/x", ""]
)
def test_unsupported_schemes(raw: str) -> None:
    assert normalize_crawl_url(raw, "https://example.com/") is None


def test_relative_urls_resolve_against_base() -> None:
    assert normalize_crawl_url("../about/", "https://example.com/blog/post/") == (
        "https://example.com/blog/about/"
    )


def test_same_domain_scope() -> None:
    scope = SiteScope.for_site("https://rytsensetech.com/")
    assert scope.contains("https://rytsensetech.com/services/")
    assert scope.contains("http://rytsensetech.com/")
    assert not scope.contains("https://www.rytsensetech.com/services/")  # not permitted by default
    for external in (
        "https://facebook.com/rytsense",
        "https://www.linkedin.com/company/rytsense",
        "https://rytsensetech.com.evil.com/",
        "https://evilrytsensetech.com/",
        "https://sub.rytsensetech.com/",
        "mailto:hello@rytsensetech.com",
    ):
        assert not scope.contains(external), external


def test_www_variant_only_when_explicitly_permitted() -> None:
    scope = SiteScope.for_site("https://rytsensetech.com/", include_www_variant=True)
    assert scope.contains("https://www.rytsensetech.com/x")
    assert scope.contains("https://rytsensetech.com/x")
    reverse = SiteScope.for_site("https://www.example.com/", include_www_variant=True)
    assert reverse.contains("https://example.com/")


@pytest.mark.parametrize(
    ("url", "asset"),
    [
        ("https://example.com/logo.png", True),
        ("https://example.com/_next/static/app.js", True),
        ("https://example.com/styles/site.css", True),
        ("https://example.com/fonts/inter.woff2", True),
        ("https://example.com/brochure.PDF", True),
        ("https://example.com/sitemap.xml", True),
        ("https://example.com/services/", False),
        ("https://example.com/v2.0/release-notes", False),
        ("https://example.com/about", False),
    ],
)
def test_asset_detection(url: str, asset: bool) -> None:
    assert is_asset(url) is asset


def test_crawler_trap_detection() -> None:
    assert looks_like_trap("https://example.com/a/a/a/a/")
    assert looks_like_trap("https://example.com/" + "/".join(f"s{i}" for i in range(20)))
    assert looks_like_trap("https://example.com/x?" + "&".join(f"p{i}=1" for i in range(8)))
    assert looks_like_trap("https://example.com/" + "a" * 2100)
    assert not looks_like_trap("https://example.com/blog/2026/09/post/")
