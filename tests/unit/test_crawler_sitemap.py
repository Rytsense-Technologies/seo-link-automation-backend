from __future__ import annotations

import gzip

import pytest

from app.crawler.schemas import CrawlRequest
from app.crawler.sitemap import SitemapError, parse_sitemap
from tests.crawler_fakes import BASE, ROBOTS_ALLOW_ALL, MockSite, make_crawler, make_site

NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'


def urlset(*paths: str) -> str:
    urls = "".join(f"<url><loc>{BASE}{p}</loc><lastmod>2026-09-01</lastmod></url>" for p in paths)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset {NS}>{urls}</urlset>'


def index(*paths: str) -> str:
    maps = "".join(f"<sitemap><loc>{BASE}{p}</loc></sitemap>" for p in paths)
    return f'<?xml version="1.0"?><sitemapindex {NS}>{maps}</sitemapindex>'


def test_parse_urlset_and_index() -> None:
    parsed = parse_sitemap(urlset("/a/", "/b/").encode(), max_bytes=10**6)
    assert parsed.page_urls == [f"{BASE}/a/", f"{BASE}/b/"]
    parsed = parse_sitemap(index("/page-sitemap.xml").encode(), max_bytes=10**6)
    assert parsed.child_sitemaps == [f"{BASE}/page-sitemap.xml"] and parsed.page_urls == []


def test_parse_gzip_and_plain_text() -> None:
    parsed = parse_sitemap(gzip.compress(urlset("/gz/").encode()), max_bytes=10**6)
    assert parsed.page_urls == [f"{BASE}/gz/"]
    parsed = parse_sitemap(f"{BASE}/t1/\n{BASE}/t2/\n".encode(), max_bytes=10**6)
    assert parsed.page_urls == [f"{BASE}/t1/", f"{BASE}/t2/"]


def test_rejects_entities_bombs_and_garbage() -> None:
    evil = (
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>'
        "<urlset><url><loc>&a;</loc></url></urlset>"
    )
    with pytest.raises(SitemapError):
        parse_sitemap(evil.encode(), max_bytes=10**6)
    bomb = gzip.compress(b"<urlset>" + b" " * 2_000_000 + b"</urlset>")
    with pytest.raises(SitemapError, match="exceeds"):
        parse_sitemap(bomb, max_bytes=100_000)
    with pytest.raises(SitemapError):
        parse_sitemap(b"<html><body>not a sitemap</body></html>", max_bytes=10**6)
    with pytest.raises(SitemapError):
        parse_sitemap(b"<urlset><url>", max_bytes=10**6)


def test_sitemap_index_discovers_pages_not_linked_in_navigation() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, f"User-agent: *\nDisallow:\nSitemap: {BASE}/sitemap_index.xml\n")
    mock.add("/sitemap_index.xml", 200, index("/page-sitemap.xml", "/post-sitemap.xml.gz"))
    mock.add("/page-sitemap.xml", 200, urlset("/", "/orphan-service/"))
    mock.add(
        "/post-sitemap.xml.gz",
        200,
        gzip.compress(urlset("/blog/hidden-post/", "/blog/hidden-post/?utm_source=x").encode()),
    )
    mock.html("/", "Home", "<p>No links to the orphan pages here.</p>")
    mock.html("/orphan-service/", "Orphan service", "<p>Only in sitemap.</p>")
    mock.html("/blog/hidden-post/", "Hidden post", "<p>Only in sitemap.</p>")
    crawler, store, _ = make_crawler(mock)
    report = crawler.crawl(make_site(), CrawlRequest())
    assert report.sitemaps_processed == 3
    assert report.robots.sitemaps == [f"{BASE}/sitemap_index.xml"]
    assert {u.removeprefix(BASE) for u in store.pages} == {
        "/",
        "/orphan-service/",
        "/blog/hidden-post/",
    }
    assert report.pages_discovered == 3  # utm variant is not a separate page
    assert report.errors == []


def test_falls_back_to_conventional_sitemap_location() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.add("/sitemap.xml", 200, urlset("/from-default-sitemap/"))
    mock.html("/", "Home", "<p>x</p>")
    mock.html("/from-default-sitemap/", "Default", "<p>y</p>")
    crawler, store, _ = make_crawler(mock)
    report = crawler.crawl(make_site(), CrawlRequest())
    assert f"{BASE}/from-default-sitemap/" in store.pages
    assert report.sitemaps_processed == 1


def test_missing_default_sitemap_is_not_an_error_and_foreign_entries_ignored() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", "<p>x</p>")
    crawler, _, _ = make_crawler(mock)
    assert crawler.crawl(make_site(), CrawlRequest()).errors == []

    mock = MockSite()
    mock.add("/robots.txt", 200, "User-agent: *\nSitemap: https://other.com/sitemap.xml\n")
    mock.add(
        "/sitemap.xml",
        200,
        urlset("/ok/").replace("</urlset>", "<url><loc>https://evil.com/x</loc></url></urlset>"),
    )
    mock.html("/", "Home", "<p>x</p>")
    mock.html("/ok/", "Ok", "<p>x</p>")
    crawler, store, _ = make_crawler(mock)
    report = crawler.crawl(make_site(), CrawlRequest())
    assert all("other.com" not in u and "evil.com" not in u for u in mock.requests)
    assert any("outside the site scope" in e.error for e in report.errors)
    assert f"{BASE}/ok/" in store.pages


def test_use_sitemaps_false_skips_sitemaps() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.add("/sitemap.xml", 200, urlset("/x/"))
    mock.html("/", "Home", "<p>x</p>")
    crawler, _, _ = make_crawler(mock)
    report = crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False))
    assert "/sitemap.xml" not in mock.requested_paths()
    assert report.sitemaps_processed == 0
