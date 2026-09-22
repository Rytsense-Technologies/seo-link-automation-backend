"""Crawler persistence against real PostgreSQL (mock website; no network)."""

from __future__ import annotations

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictError
from app.crawler.schemas import CrawlRequest
from app.crawler.store import SqlAlchemyCrawlStore
from app.pages.models import Page
from app.pages.schemas import SiteCreate
from app.pages.service import PageService
from tests.crawler_fakes import ROBOTS_ALLOW_ALL, MockSite, make_crawler
from tests.integration.test_postgres import DB_URL, engine, session  # noqa: F401 (fixtures)

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not DB_URL, reason="TEST_DATABASE_URL not set"),
]
BASE = "https://example.com"


def _mock_site() -> MockSite:
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html(
        "/",
        "Home",
        '<p><a href="/services/">Services</a> <a href="/services">again</a> '
        '<a href="/services/?utm_source=x#top">tracked</a></p>',
    )
    mock.html("/services/", "Services", "<p>We build AI voice agents.</p>")
    return mock


def _crawl(session: Session, engine: Engine, site_id, mock: MockSite):  # type: ignore[no-untyped-def]  # noqa: F811
    store = SqlAlchemyCrawlStore(session, engine)
    crawler, _, _ = make_crawler(mock, store)  # type: ignore[arg-type]
    site = PageService(session).get_site(site_id)
    return crawler.crawl(site, CrawlRequest(use_sitemaps=False))


def _pages(session: Session, site_id) -> dict[str, Page]:  # type: ignore[no-untyped-def]  # noqa: F811
    session.expire_all()
    return {p.url: p for p in session.scalars(select(Page).where(Page.site_id == site_id))}


def test_crawl_inserts_then_updates_without_duplicates(session: Session, engine: Engine) -> None:  # noqa: F811
    site = PageService(session).create_site(SiteCreate(name="Ex", base_url=BASE))  # type: ignore[arg-type]
    mock = _mock_site()

    first = _crawl(session, engine, site.id, mock)
    assert (first.pages_created, first.pages_updated) == (2, 0)
    pages = _pages(session, site.id)
    assert set(pages) == {f"{BASE}/", f"{BASE}/services/"}
    services = pages[f"{BASE}/services/"]
    assert services.title == "Services" and services.http_status == 200
    assert "AI voice agents" in (services.content_html or "")
    assert pages[f"{BASE}/"].outgoing_links == [f"{BASE}/services/"]
    assert services.content_version == 1

    # Unchanged re-crawl: same rows, no version bump.
    second = _crawl(session, engine, site.id, mock)
    assert (second.pages_created, second.pages_updated) == (0, 2)
    assert _pages(session, site.id)[f"{BASE}/services/"].content_version == 1

    # Changed content: row updated in place, version bumped.
    mock.html("/services/", "Services v2", "<p>Now with CRM integration.</p>")
    third = _crawl(session, engine, site.id, mock)
    assert third.pages_created == 0
    pages = _pages(session, site.id)
    assert len(pages) == 2
    assert pages[f"{BASE}/services/"].title == "Services v2"
    assert pages[f"{BASE}/services/"].content_version == 2
    count = session.scalar(select(func.count()).select_from(Page).where(Page.site_id == site.id))
    assert count == 2


def test_error_status_update_keeps_existing_content(session: Session, engine: Engine) -> None:  # noqa: F811
    site = PageService(session).create_site(SiteCreate(name="Ex", base_url=BASE))  # type: ignore[arg-type]
    mock = _mock_site()
    _crawl(session, engine, site.id, mock)
    mock.add("/services/", 404, "gone", content_type="text/html")
    report = _crawl(session, engine, site.id, mock)
    assert any(e.status == 404 for e in report.errors)
    services = _pages(session, site.id)[f"{BASE}/services/"]
    assert services.http_status == 404
    assert "AI voice agents" in (services.content_html or "")


def test_concurrent_crawl_of_same_site_is_rejected(session: Session, engine: Engine) -> None:  # noqa: F811
    site = PageService(session).create_site(SiteCreate(name="Ex", base_url=BASE))  # type: ignore[arg-type]
    first = SqlAlchemyCrawlStore(session, engine)
    second = SqlAlchemyCrawlStore(session, engine)
    with first.site_lock(site.id):
        with pytest.raises(ConflictError) as exc, second.site_lock(site.id):
            pass
        assert exc.value.code == "CRAWL_IN_PROGRESS"
    with second.site_lock(site.id):  # released after the first crawl finishes
        pass


def test_html_redirect_and_empty_pages_are_excluded_from_interlinking(
    session: Session,  # noqa: F811
    engine: Engine,  # noqa: F811
) -> None:
    from pathlib import Path

    from app.interlink.candidate_filter import ExclusionReason, filter_candidates
    from app.interlink.repository import SqlAlchemyInterlinkRepository
    from app.interlink.service import InterlinkConfig
    from app.pages.schemas import PageUpsert

    site = PageService(session).create_site(SiteCreate(name="Ex", base_url=BASE))  # type: ignore[arg-type]
    fixture = Path(__file__).parent.parent / "fixtures" / "next_redirect_error_shell.html"
    mock = MockSite()
    mock.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    mock.html("/", "Home", '<p>Try our <a href="/ai-readiness-assessment/">assessment</a>.</p>')
    mock.routes["/ai-readiness-assessment/"] = (
        200,
        fixture.read_text(encoding="utf-8"),
        {"content-type": "text/html"},
    )
    mock.html("/us/ai-readiness-assessment/", "AI Readiness Assessment", "<p>Assessment.</p>")
    report = _crawl(session, engine, site.id, mock)
    assert report.html_redirects == 1

    pages = _pages(session, site.id)
    redirecting = pages[f"{BASE}/ai-readiness-assessment/"]
    assert redirecting.http_status == 200 and not redirecting.is_indexable
    assert redirecting.redirect_url == f"{BASE}/us/ai-readiness-assessment/"
    assert pages[f"{BASE}/us/ai-readiness-assessment/"].is_indexable

    # Same shape as the pre-existing empty row: indexable=true, no title/H1, empty content.
    PageService(session).upsert_pages(
        site.id, [PageUpsert(url="/legacy-empty/", title=None, h1=None, content_html="")]
    )
    session.expire_all()
    repo = SqlAlchemyInterlinkRepository(session)
    source = repo.get_page(pages[f"{BASE}/"].id)
    assert source is not None
    pool = repo.list_candidate_pool(source)
    assert f"{BASE}/ai-readiness-assessment/" not in {p.url for p in pool}  # SQL pre-filter
    result = filter_candidates(source, pool, InterlinkConfig().filters)
    assert [p.url for p in result.excluded[ExclusionReason.EMPTY_CONTENT]] == [
        f"{BASE}/legacy-empty/"
    ]
    assert {p.url for p in result.accepted} == {f"{BASE}/us/ai-readiness-assessment/"}
