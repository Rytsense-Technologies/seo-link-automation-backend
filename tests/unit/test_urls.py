from __future__ import annotations

from app.core.urls import normalize_url, same_host, site_relative, url_key


def test_normalize_url() -> None:
    assert normalize_url("HTTPS://Example.COM:443/a/b?x=1#frag") == "https://example.com/a/b?x=1"
    assert normalize_url("/about", "https://example.com/x/") == "https://example.com/about"
    assert normalize_url("https://example.com") == "https://example.com/"
    assert normalize_url("mailto:a@b.c") is None
    assert normalize_url("javascript:void(0)") is None
    assert normalize_url("") is None


def test_url_key_equivalence() -> None:
    assert url_key("https://www.example.com/a/") == url_key("http://example.com/a")
    assert url_key("https://example.com/a?x=1") != url_key("https://example.com/a")


def test_host_and_relative() -> None:
    assert same_host("https://www.example.com/a", "https://example.com/b")
    assert not same_host("https://example.com/a", "https://other.com/a")
    assert site_relative("https://example.com/a/b?x=1") == "/a/b?x=1"
