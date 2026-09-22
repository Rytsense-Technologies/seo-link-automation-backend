"""HTML-level redirects (Next.js NEXT_REDIRECT, meta refresh) and empty 200 pages."""

from __future__ import annotations

from pathlib import Path

import pytest
from bs4 import BeautifulSoup

from app.crawler.extract import extract_page, is_unusable
from app.crawler.html_redirects import (
    META_REFRESH,
    NEXT_REDIRECT,
    detect_html_redirect,
    detect_meta_refresh,
    detect_next_redirect,
    is_next_error_shell,
)
from app.crawler.schemas import CrawlRequest
from tests.crawler_fakes import (
    BASE,
    ROBOTS_ALLOW_ALL,
    MockSite,
    html_page,
    make_crawler,
    make_site,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "next_redirect_error_shell.html"
PROD_URL = "https://rytsensetech.com/ai-readiness-assessment/"


def next_shell(target: str, *, mode: str = "replace", code: str = "307") -> str:
    """Minimal Next.js static-export error shell carrying a redirect digest."""
    digest = f'6:E{{\\"digest\\":\\"NEXT_REDIRECT;{mode};{target};{code};\\"}}\\n'
    return (
        '<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/></head><body>'
        "<script>(self.__next_f=self.__next_f||[]).push([0])</script>"
        f'<script>self.__next_f.push([1,"{digest}"])</script></body></html>'
    )


def meta_refresh(content: str, *, body: str = "") -> str:
    return (
        f'<html><head><meta http-equiv="refresh" content="{content}"><title>Moved</title>'
        f"</head><body>{body}</body></html>"
    )


# ---------------------------------------------------------------- detection


def test_next_redirect_is_detected_with_target_and_status() -> None:
    found = detect_next_redirect(next_shell("/us/ai-readiness-assessment/"))
    assert found is not None
    assert found.detected
    assert found.target == "/us/ai-readiness-assessment/"
    assert found.status_code == 307
    assert found.type == NEXT_REDIRECT
    assert found.mode == "replace"


@pytest.mark.parametrize(
    ("mode", "code", "status"),
    [
        ("push", "308", 308),
        ("replace", "303", 303),
        ("replace", "true", 308),
        ("push", "false", 307),
    ],
)
def test_next_redirect_variants(mode: str, code: str, status: int) -> None:
    found = detect_next_redirect(next_shell("/somewhere/else/", mode=mode, code=code))
    assert found is not None and found.target == "/somewhere/else/"
    assert found.status_code == status and found.mode == mode


def test_next_redirect_target_is_extracted_dynamically_and_unescaped() -> None:
    found = detect_next_redirect(next_shell("\\/pricing\\/?plan=pro\\u0026ref=x"))
    assert found is not None and found.target == "/pricing/?plan=pro&ref=x"
    absolute = detect_next_redirect(
        next_shell("https://rytsensetech.com/us/ai-readiness-assessment/")
    )
    assert absolute is not None
    assert absolute.target == "https://rytsensetech.com/us/ai-readiness-assessment/"


def test_unescaped_digest_json_is_also_detected() -> None:
    html = '<script>{"digest":"NEXT_REDIRECT;replace;/plain/;307;"}</script>'
    found = detect_next_redirect(html)
    assert found is not None and found.target == "/plain/"


def test_article_text_mentioning_next_redirect_is_not_a_redirect() -> None:
    html = html_page(
        "Next.js redirects",
        "<p>When redirect() runs, Next.js throws NEXT_REDIRECT;replace;/x/;307; internally.</p>",
    )
    assert detect_next_redirect(html) is None
    page = extract_page(html, f"{BASE}/blog/next-redirects/")
    assert page.html_redirect is None and not page.is_empty


@pytest.mark.parametrize(
    ("content", "target", "delay"),
    [
        ("0;url=/us/example/", "/us/example/", 0.0),
        ("0; URL=/us/example/", "/us/example/", 0.0),
        ("  5 ;  url = '/us/example/' ", "/us/example/", 5.0),
        (
            "3,url='https://rytsensetech.com/us/example/'",
            "https://rytsensetech.com/us/example/",
            3.0,
        ),
        ("0;/us/example/", "/us/example/", 0.0),
    ],
)
def test_meta_refresh_variants(content: str, target: str, delay: float) -> None:
    html = meta_refresh(content).replace('http-equiv="refresh"', 'HTTP-EQUIV="Refresh"')
    found = detect_meta_refresh(BeautifulSoup(html, "html.parser"))
    assert found is not None
    assert found.type == META_REFRESH and found.target == target and found.delay_seconds == delay


def test_meta_refresh_without_target_or_inside_noscript_is_ignored() -> None:
    assert detect_html_redirect(meta_refresh("30")) is None  # reload same page
    noscript = (
        '<html><head><noscript><meta http-equiv="refresh" content="0;url=/nojs/"></noscript>'
        "</head><body><p>App</p></body></html>"
    )
    assert detect_html_redirect(noscript) is None


@pytest.mark.parametrize(
    "target", ["javascript:alert(1)", "JavaScript:alert(document.cookie)", "data:text/html,hi"]
)
def test_unsafe_schemes_are_flagged(target: str) -> None:
    found = detect_html_redirect(meta_refresh(f"0;url={target}"))
    assert found is not None and found.has_unsafe_scheme
    shell = detect_next_redirect(next_shell("javascript:alert(1)"))
    assert shell is not None and shell.has_unsafe_scheme


# ---------------------------------------------------------------- empty / valid pages


def test_normal_page_is_valid_and_not_a_redirect() -> None:
    page = extract_page(
        html_page("AI Voice Agent", "<h1>AI Voice Agents</h1><p>We automate calls.</p>"),
        f"{BASE}/ai-voice-agent/",
    )
    assert page.html_redirect is None and not page.is_error_shell and not page.is_empty


@pytest.mark.parametrize(
    "html",
    [
        # no canonical + useful content
        "<html><head><title>T</title></head><body><main><h1>H</h1><p>Body.</p></main></body></html>",
        # no H1 + useful content
        "<html><head><title>T</title></head><body><main><p>Body copy.</p></main></body></html>",
        # no title + useful content
        "<html><body><main><h1>Heading</h1><p>Body copy.</p></main></body></html>",
        # content only
        "<html><body><p>Just some useful body copy.</p></body></html>",
    ],
)
def test_pages_missing_one_field_are_still_valid(html: str) -> None:
    assert not extract_page(html, f"{BASE}/x/").is_empty


def test_empty_200_page_is_unusable() -> None:
    html = (
        '<!doctype html><html><head><meta charset="utf-8"><script src="/app.js"></script></head>'
        '<body><div id="root"></div><script>window.boot()</script></body></html>'
    )
    page = extract_page(html, f"{BASE}/app/")
    assert page.title is None and page.h1 is None and page.canonical_url is None
    assert page.content_text == "" and page.is_empty and page.html_redirect is None


def test_canonical_alone_does_not_make_a_page_usable() -> None:
    html = f'<html><head><link rel="canonical" href="{BASE}/x/"></head><body></body></html>'
    assert extract_page(html, f"{BASE}/x/").is_empty


def test_next_error_shell_with_and_without_redirect() -> None:
    with_redirect = extract_page(next_shell("/us/x/"), f"{BASE}/x/")
    assert with_redirect.is_error_shell and with_redirect.html_redirect is not None
    without = next_shell("/us/x/").replace("NEXT_REDIRECT", "SOME_OTHER_ERROR")
    page = extract_page(without, f"{BASE}/x/")
    assert page.is_error_shell and page.html_redirect is None and page.is_empty
    # An error shell is unusable even when it happens to carry a title.
    assert is_unusable(title="Error", h1=None, content_text="", error_shell=True)
    assert not is_unusable(title=None, h1=None, content_text="Real text", error_shell=True)
    assert is_next_error_shell('<html id="__next_error__">') and not is_next_error_shell("<html>")


def test_real_production_response_fixture() -> None:
    """Regression: the observed live response of /ai-readiness-assessment/ (static fixture)."""
    html = FIXTURE.read_text(encoding="utf-8")
    page = extract_page(html, PROD_URL)
    assert page.title is None and page.h1 is None and page.canonical_url is None
    assert page.content_html == "" and page.links == []
    assert page.is_error_shell and page.is_empty
    assert page.html_redirect is not None
    assert page.html_redirect.target == "/us/ai-readiness-assessment/"
    assert page.html_redirect.status_code == 307
    assert page.html_redirect.type == NEXT_REDIRECT


# ---------------------------------------------------------------- crawler behaviour


def _site(**routes: str) -> MockSite:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    for path, html in routes.items():
        mock.routes[path] = (200, html, {"content-type": "text/html"})
    return mock


def _crawl(mock: MockSite, **request: object):  # type: ignore[no-untyped-def]
    crawler, store, _ = make_crawler(mock)
    report = crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False, **request))  # type: ignore[arg-type]
    return report, store


def test_crawler_follows_production_next_redirect_and_excludes_source() -> None:
    mock = _site()
    mock.html("/", "Home", '<p><a href="/ai-readiness-assessment/">Assessment</a></p>')
    mock.routes["/ai-readiness-assessment/"] = (
        200,
        FIXTURE.read_text(encoding="utf-8"),
        {"content-type": "text/html"},
    )
    mock.html(
        "/us/ai-readiness-assessment/",
        "AI Readiness Assessment",
        "<h1>Is Your Business Ready for AI?</h1><p>Take the assessment.</p>",
    )
    report, store = _crawl(mock)

    source = store.pages[f"{BASE}/ai-readiness-assessment/"]
    assert source.http_status == 200  # the true HTTP status is kept
    assert source.redirect_url == f"{BASE}/us/ai-readiness-assessment/"
    assert source.is_indexable is False  # never a normal content page
    target = store.pages[f"{BASE}/us/ai-readiness-assessment/"]
    assert target.title == "AI Readiness Assessment" and target.is_indexable
    assert target.redirect_url is None
    assert report.html_redirects == 1 and report.unusable_pages == 0
    assert report.errors == []


def test_absolute_same_host_target_is_normalised_and_followed() -> None:
    mock = _site(**{"/old/": next_shell(f"{BASE}/us/new/?utm_source=x#top")})
    mock.html("/", "Home", '<p><a href="/old/">old</a></p>')
    mock.html("/us/new/", "New", "<p>new page</p>")
    _, store = _crawl(mock)
    assert store.pages[f"{BASE}/old/"].redirect_url == f"{BASE}/us/new/"
    assert f"{BASE}/us/new/" in store.pages


def test_external_target_is_recorded_but_not_followed() -> None:
    mock = _site(**{"/out/": next_shell("https://example.org/landing/")})
    mock.html("/", "Home", '<p><a href="/out/">out</a></p>')
    _, store = _crawl(mock)
    out = store.pages[f"{BASE}/out/"]
    assert out.redirect_url == "https://example.org/landing/" and not out.is_indexable
    assert not any("example.org" in u for u in mock.requests)


@pytest.mark.parametrize(
    "html",
    [
        next_shell("javascript:alert(1)"),
        meta_refresh("0;url=javascript:alert(1)"),
        meta_refresh("0;url=data:text/html,hi"),
    ],
)
def test_unsafe_targets_are_rejected(html: str) -> None:
    mock = _site(**{"/bad/": html})
    mock.html("/", "Home", '<p><a href="/bad/">bad</a></p>')
    report, store = _crawl(mock)
    bad = store.pages[f"{BASE}/bad/"]
    assert bad.redirect_url is None  # never stored/followed as a redirect
    assert any(e.url == f"{BASE}/bad/" and "unsafe" in e.error for e in report.errors)
    assert len([p for p in mock.requested_paths() if p not in ("/robots.txt",)]) == 2


def test_ssrf_target_is_not_followed() -> None:
    mock = _site(**{"/meta/": meta_refresh("0;url=http://127.0.0.1/admin")})
    mock.html("/", "Home", '<p><a href="/meta/">m</a></p>')
    report, store = _crawl(mock)
    assert not any("127.0.0.1" in u for u in mock.requests)
    assert store.pages[f"{BASE}/meta/"].is_indexable is False
    assert any("SSRF" in e.error for e in report.errors)


def test_meta_refresh_redirect_is_followed() -> None:
    mock = _site(**{"/moved/": meta_refresh("0;url=/us/example/")})
    mock.html("/", "Home", '<p><a href="/moved/">moved</a></p>')
    mock.html("/us/example/", "Example", "<p>example</p>")
    report, store = _crawl(mock)
    assert store.pages[f"{BASE}/moved/"].redirect_url == f"{BASE}/us/example/"
    assert store.pages[f"{BASE}/us/example/"].title == "Example"
    assert report.html_redirects == 1


def test_empty_200_page_is_stored_as_not_indexable() -> None:
    empty = '<html><head></head><body><div id="app"></div><script>boot()</script></body></html>'
    mock = _site(**{"/empty/": empty})
    mock.html("/", "Home", '<p><a href="/empty/">empty</a></p>')
    report, store = _crawl(mock)
    page = store.pages[f"{BASE}/empty/"]
    assert page.http_status == 200 and page.is_indexable is False and page.redirect_url is None
    assert store.pages[f"{BASE}/"].is_indexable is True
    assert report.unusable_pages == 1 and report.html_redirects == 0


def test_html_redirect_loop_terminates() -> None:
    mock = _site(**{"/a/": next_shell("/b/"), "/b/": meta_refresh("0;url=/a/")})
    mock.html("/", "Home", '<p><a href="/a/">a</a></p>')
    report, store = _crawl(mock)
    paths = mock.requested_paths()
    assert paths.count("/a/") == 1 and paths.count("/b/") == 1
    assert store.pages[f"{BASE}/a/"].redirect_url == f"{BASE}/b/"
    assert store.pages[f"{BASE}/b/"].redirect_url == f"{BASE}/a/"
    assert report.pages_crawled == 3


def test_robots_disallowed_redirect_target_is_not_fetched() -> None:
    mock = _site(**{"/r/": next_shell("/private/x/")})
    mock.add("/robots.txt", 200, "User-agent: *\nDisallow: /private/\n")
    mock.html("/", "Home", '<p><a href="/r/">r</a></p>')
    report, _ = _crawl(mock)
    assert "/private/x/" not in mock.requested_paths()
    assert report.skipped_reasons.get("ROBOTS_DISALLOWED") == 1
