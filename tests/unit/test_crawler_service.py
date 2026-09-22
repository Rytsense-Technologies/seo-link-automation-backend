from __future__ import annotations

import httpx
import pytest

from app.core.exceptions import UnprocessableError
from app.crawler.schemas import CrawlRequest
from tests.crawler_fakes import (
    BASE,
    ROBOTS_ALLOW_ALL,
    FakeCrawlStore,
    MockSite,
    html_page,
    make_crawler,
    make_site,
)


def site_with_pages() -> MockSite:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html(
        "/",
        "Home",
        '<h1>Welcome</h1><p>See <a href="/services/">services</a>, '
        '<a href="/services/ai-voice-agent/">voice agents</a> and '
        '<a href="https://facebook.com/example">Facebook</a>, '
        '<a href="/logo.png">logo</a>, <a href="mailto:a@example.com">mail</a>.</p>',
    )
    mock.html(
        "/services/", "Services", '<p><a href="/services/ai-voice-agent/#pricing">Voice</a></p>'
    )
    mock.html(
        "/services/ai-voice-agent/",
        "AI Voice Agent",
        "<h1>AI Voice Agents</h1><p>We automate calls.</p>",
        canonical=f"{BASE}/services/ai-voice-agent/",
    )
    return mock


def _crawl(mock: MockSite, store: FakeCrawlStore | None = None, **request: object):  # type: ignore[no-untyped-def]
    crawler, store, _ = make_crawler(mock, store)
    report = crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False, **request))  # type: ignore[arg-type]
    return report, store


def test_new_pages_are_inserted_with_extracted_data() -> None:
    report, store = _crawl(site_with_pages())
    assert report.pages_crawled == 3
    assert report.pages_created == 3 and report.pages_updated == 0
    assert set(store.pages) == {
        f"{BASE}/",
        f"{BASE}/services/",
        f"{BASE}/services/ai-voice-agent/",
    }
    voice = store.pages[f"{BASE}/services/ai-voice-agent/"]
    assert voice.title == "AI Voice Agent"
    assert voice.h1 == "AI Voice Agents"
    assert voice.http_status == 200 and voice.redirect_url is None
    assert voice.canonical_url == f"{BASE}/services/ai-voice-agent/"
    assert voice.language == "en" and voice.is_indexable and not voice.has_noindex
    assert "We automate calls." in (voice.content_html or "")
    assert "© Example" not in (voice.content_html or "")  # footer excluded from content
    home = store.pages[f"{BASE}/"]
    assert home.outgoing_links == [f"{BASE}/services/", f"{BASE}/services/ai-voice-agent/"]
    assert report.errors == []


def test_navigation_and_footer_links_are_used_for_discovery_only() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html(
        "/",
        "Home",
        "<p>Body copy.</p>",
        nav='<a href="/nav-only/">Nav</a>',
        footer='<a href="/footer-only/">Footer</a>',
    )
    mock.html("/nav-only/", "Nav only", "<p>x</p>")
    mock.html("/footer-only/", "Footer only", "<p>y</p>")
    _report, store = _crawl(mock)
    assert {f"{BASE}/nav-only/", f"{BASE}/footer-only/"} <= set(store.pages)
    # Chrome links are not counted as the page's contextual (content) links.
    assert store.pages[f"{BASE}/"].outgoing_links == []
    assert "Nav" not in (store.pages[f"{BASE}/"].content_html or "")


def test_same_domain_only_and_no_assets_or_special_schemes() -> None:
    mock = site_with_pages()
    _crawl(mock)
    assert all(u.startswith(BASE) for u in mock.requests)
    assert not any("facebook" in u or u.endswith(".png") for u in mock.requests)


def test_recrawl_updates_existing_pages_without_duplicates() -> None:
    mock = site_with_pages()
    _report, store = _crawl(mock)
    mock.html("/services/", "Services (updated)", "<p>New copy.</p>")
    second, store = _crawl(mock, store)
    assert second.pages_created == 0
    assert second.pages_updated == 3
    assert len(store.pages) == 3
    assert store.pages[f"{BASE}/services/"].title == "Services (updated)"


def test_duplicate_url_variants_are_crawled_once() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html(
        "/",
        "Home",
        '<a href="/page">a</a> <a href="/page/">b</a> <a href="/page/#s">c</a> '
        '<a href="/page?utm_source=x">d</a> <a href="/page?utm_campaign=y&gclid=1">e</a>',
    )
    mock.html("/page/", "Page", "<p>page</p>")
    mock.html("/page", "Page", "<p>page</p>")
    report, store = _crawl(mock)
    page_requests = [p for p in mock.requested_paths() if p.startswith("/page")]
    assert len(page_requests) == 1
    assert report.pages_discovered == 2  # "/" and one "/page"
    assert len([u for u in store.pages if "/page" in u]) == 1


def test_existing_url_form_is_reused() -> None:
    store = FakeCrawlStore()
    store.upsert_page(make_site().id, _page(f"{BASE}/page"))  # stored without trailing slash
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/page/">p</a>')
    mock.html("/page/", "Page", "<p>page</p>")
    report, store = _crawl(mock, store)
    assert f"{BASE}/page/" not in store.pages
    assert store.pages[f"{BASE}/page"].title == "Page"
    assert report.pages_updated == 1 and report.pages_created == 1


def _page(url: str):  # type: ignore[no-untyped-def]
    from app.pages.schemas import PageUpsert

    return PageUpsert(url=url, title="old", content_html="<p>old content</p>")


def test_crawl_continues_after_errors() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html(
        "/",
        "Home",
        '<a href="/broken/">x</a> <a href="/down/">y</a> '
        '<a href="/boom/">z</a> <a href="/ok/">ok</a>',
    )
    mock.add("/broken/", 404, "nope", content_type="text/html")
    mock.add("/down/", 500, "err", content_type="text/html")

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset", request=request)

    mock.routes["/boom/"] = boom
    mock.html("/ok/", "OK", "<p>fine</p>")
    report, store = _crawl(mock)
    assert f"{BASE}/ok/" in store.pages  # later pages still crawled
    errors = {e.url.removeprefix(BASE): e for e in report.errors}
    assert errors["/broken/"].status == 404 and "404" in errors["/broken/"].error
    assert errors["/down/"].status == 500
    assert "ConnectError" in errors["/boom/"].error and errors["/boom/"].status is None
    # 5xx and connection errors were retried (max_retries=2 -> 3 attempts each).
    assert mock.requested_paths().count("/down/") == 3
    assert mock.requested_paths().count("/boom/") == 3
    assert mock.requested_paths().count("/broken/") == 1


def test_database_failure_for_one_page_does_not_stop_crawl() -> None:
    store = FakeCrawlStore()
    store.fail_on = {f"{BASE}/services/"}
    report, store = _crawl(site_with_pages(), store)
    assert f"{BASE}/services/ai-voice-agent/" in store.pages
    assert any(
        e.url == f"{BASE}/services/" and "Failed to store page" in e.error for e in report.errors
    )


def test_existing_page_that_now_404s_keeps_content() -> None:
    store = FakeCrawlStore()
    store.upsert_page(make_site().id, _page(f"{BASE}/gone/"))
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/gone/">gone</a>')
    _report, store = _crawl(mock, store)
    gone = store.pages[f"{BASE}/gone/"]
    assert gone.http_status == 404
    assert gone.content_html == "<p>old content</p>"  # not wiped by an error response
    assert (f"{BASE}/gone/", 404, None) in store.status_updates


def test_new_404_pages_are_not_inserted() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/missing/">m</a>')
    report, store = _crawl(mock)
    assert f"{BASE}/missing/" not in store.pages
    assert report.errors[0].status == 404


def test_max_pages_limit() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    links = " ".join(f'<a href="/p{i}/">{i}</a>' for i in range(20))
    mock.html("/", "Home", links)
    for i in range(20):
        mock.html(f"/p{i}/", f"P{i}", "<p>x</p>")
    report, store = _crawl(mock, max_pages=5)
    assert report.pages_crawled == 5
    assert len(store.pages) == 5
    assert report.max_pages_reached
    assert report.skipped_reasons["MAX_PAGES_REACHED"] == 16
    assert report.pages_discovered == 21
    page_requests = [p for p in mock.requested_paths() if p != "/robots.txt"]
    assert len(page_requests) == 5


def test_redirects_are_recorded_and_final_page_stored() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/old-page/">old</a> <a href="/leaves/">x</a>')
    mock.add("/old-page/", 301, location="/new-page/")
    mock.html("/new-page/", "New page", "<p>new</p>")
    mock.add("/leaves/", 302, location="https://other.com/landing")
    _report, store = _crawl(mock)
    old = store.pages[f"{BASE}/old-page/"]
    assert old.http_status == 301 and old.redirect_url == f"{BASE}/new-page/"
    assert store.pages[f"{BASE}/new-page/"].title == "New page"
    assert store.pages[f"{BASE}/leaves/"].redirect_url == "https://other.com/landing"
    assert not any("other.com" in u for u in mock.requests)  # external target not fetched


def test_redirect_loop_is_bounded() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/loop-a/">a</a> <a href="/ok/">ok</a>')
    mock.add("/loop-a/", 302, location="/loop-b/")
    mock.add("/loop-b/", 302, location="/loop-a/")
    mock.html("/ok/", "OK", "<p>ok</p>")
    report, store = _crawl(mock)
    assert any("Too many redirects" in e.error for e in report.errors)
    assert f"{BASE}/ok/" in store.pages


def test_non_html_and_oversized_responses() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<a href="/feed/">feed</a> <a href="/huge/">huge</a>')
    mock.add("/feed/", 200, "{}", content_type="application/json")
    mock.add("/huge/", 200, html_page("Huge", "x" * 50_000), content_type="text/html")
    crawler, store, _ = make_crawler(mock, max_response_bytes=20_000)
    report = crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False))
    assert report.skipped_reasons["NOT_HTML"] == 1
    assert any(e.url.endswith("/huge/") and "too large" in e.error for e in report.errors)
    assert set(store.pages) == {f"{BASE}/"}


def test_noindex_pages_are_stored_but_marked() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.routes["/"] = (
        200,
        html_page("Home", "<p>x</p>", head_extra='<meta name="robots" content="noindex">'),
        {"content-type": "text/html"},
    )
    _report, store = _crawl(mock)
    home = store.pages[f"{BASE}/"]
    assert home.has_noindex and not home.is_indexable


def test_start_url_must_be_in_scope() -> None:
    crawler, _, _ = make_crawler(MockSite())
    for bad in ("https://other.com/", "https://www.example.com/"):
        with pytest.raises(UnprocessableError) as exc:
            crawler.crawl(make_site(), CrawlRequest(start_url=bad))  # type: ignore[arg-type]
        assert exc.value.code == "START_URL_OUT_OF_SCOPE"


def test_internal_site_base_url_is_blocked() -> None:
    crawler, _, _ = make_crawler(MockSite())
    with pytest.raises(UnprocessableError) as exc:
        crawler.crawl(make_site("http://127.0.0.1"), CrawlRequest())
    assert exc.value.code == "START_URL_BLOCKED"


def test_polite_delay_between_requests() -> None:
    crawler, _, sleeps = make_crawler(site_with_pages(), request_delay_seconds=0.25)
    crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False))
    # robots.txt + 3 pages = 4 requests -> 3 pauses.
    assert sleeps == [0.25, 0.25, 0.25]


def test_crawl_holds_site_lock() -> None:
    store = FakeCrawlStore()
    seen: list[bool] = []
    original = store.existing_urls

    def spy(site_id):  # type: ignore[no-untyped-def]
        seen.append(store.locked)
        return original(site_id)

    store.existing_urls = spy  # type: ignore[method-assign]
    _crawl(site_with_pages(), store)
    assert seen == [True] and store.locked is False


def test_discovery_tracking_is_bounded() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", " ".join(f'<a href="/p{i}/">{i}</a>' for i in range(30)))
    crawler, _, _ = make_crawler(mock, discovery_factor=2, min_discovery_limit=10)
    report = crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False, max_pages=1))
    assert report.pages_discovered == 10
    assert report.skipped_reasons["DISCOVERY_LIMIT"] == 21
