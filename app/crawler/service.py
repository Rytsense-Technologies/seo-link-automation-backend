"""Site crawler: robots.txt -> sitemaps -> BFS over same-site HTML pages -> `pages` table.

The crawler only reads the website and writes the local page inventory. It never modifies
the live site; internal links are still applied only through the manual approval workflow.
"""

from __future__ import annotations

import logging
import time
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.exc import SQLAlchemyError

from app.core.exceptions import AppError, UnprocessableError
from app.core.urls import url_key
from app.crawler.extract import extract_page
from app.crawler.fetcher import Fetcher, FetchError, FetchResult
from app.crawler.html_redirects import HtmlRedirect
from app.crawler.robots import RobotsRules, parse_robots
from app.crawler.schemas import CrawlError, CrawlRequest, CrawlResponse, RobotsSummary
from app.crawler.sitemap import SitemapError, parse_sitemap
from app.crawler.ssrf import SSRFError, validate_url
from app.crawler.store import CrawlStore
from app.crawler.urls import SiteScope, is_asset, looks_like_trap, normalize_crawl_url
from app.pages.models import Site
from app.pages.schemas import PageUpsert

logger = logging.getLogger(__name__)

MAX_REPORTED_ERRORS = 200
SITEMAP_ACCEPT = "application/xml,text/xml;q=0.9,*/*;q=0.5"


class SkipReason:
    ROBOTS_DISALLOWED = "ROBOTS_DISALLOWED"
    NOT_HTML = "NOT_HTML"
    MAX_PAGES_REACHED = "MAX_PAGES_REACHED"
    DUPLICATE_FINAL_URL = "DUPLICATE_FINAL_URL"
    UNEXPECTED_STATUS = "UNEXPECTED_STATUS"
    DISCOVERY_LIMIT = "DISCOVERY_LIMIT"


class PageCondition:
    """Informational classifications of stored pages (not skips)."""

    HTML_REDIRECT = "HTML_REDIRECT"
    UNUSABLE_CONTENT = "UNUSABLE_CONTENT"


@dataclass(frozen=True)
class CrawlConfig:
    request_delay_seconds: float = 0.5
    max_crawl_delay_seconds: float = 10.0
    max_pages_limit: int = 1000
    max_sitemaps: int = 50
    max_response_bytes: int = 5_000_000
    allowed_ports: tuple[int, ...] = (80, 443)
    user_agent: str = "SEOLinkAutomationBot/0.1"
    # URLs tracked for de-duplication/reporting: max(max_pages * factor, min_discovery_limit).
    # Only `max_pages` are fetched; this just bounds memory on huge/trap sites.
    discovery_factor: int = 10
    min_discovery_limit: int = 10_000


@dataclass
class _Report:
    robots: RobotsSummary | None = None
    sitemaps_processed: int = 0
    crawled: int = 0
    created: int = 0
    updated: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    conditions: Counter[str] = field(default_factory=Counter)
    errors: list[CrawlError] = field(default_factory=list)
    errors_truncated: bool = False

    def error(self, url: str, message: str, status: int | None = None) -> None:
        if len(self.errors) >= MAX_REPORTED_ERRORS:
            self.errors_truncated = True
            return
        self.errors.append(CrawlError(url=url, error=message, status=status))


class SiteCrawler:
    def __init__(
        self,
        store: CrawlStore,
        fetcher: Fetcher,
        config: CrawlConfig,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._fetcher = fetcher
        self._config = config
        self._sleep = sleep
        self._clock = clock
        self._requests_made = 0
        self._delay = config.request_delay_seconds
        self._discovered = 0

    # ------------------------------------------------------------------ entry point
    def crawl(self, site: Site, request: CrawlRequest) -> CrawlResponse:
        started = self._clock()
        scope = SiteScope.for_site(site.base_url, include_www_variant=request.include_www_variant)
        start_url = normalize_crawl_url(str(request.start_url or site.base_url))
        if start_url is None or not scope.contains(start_url):
            raise UnprocessableError(
                "start_url must be an http(s) URL on the site's host",
                code="START_URL_OUT_OF_SCOPE",
                details={"allowed_hosts": sorted(scope.hosts)},
            )
        try:
            validate_url(start_url, allowed_ports=self._config.allowed_ports)
        except SSRFError as exc:
            raise UnprocessableError(str(exc), code="START_URL_BLOCKED") from exc
        max_pages = min(request.max_pages, self._config.max_pages_limit)

        with self._store.site_lock(site.id):
            report = self._run(site, scope, start_url, max_pages, request.use_sitemaps)

        assert report.robots is not None
        return CrawlResponse(
            site_id=site.id,
            start_url=start_url,
            robots=report.robots,
            sitemaps_processed=report.sitemaps_processed,
            pages_discovered=self._discovered,
            pages_crawled=report.crawled,
            pages_created=report.created,
            pages_updated=report.updated,
            pages_skipped=sum(report.skipped.values()),
            skipped_reasons=dict(report.skipped),
            max_pages_reached=report.skipped.get(SkipReason.MAX_PAGES_REACHED, 0) > 0,
            html_redirects=report.conditions.get(PageCondition.HTML_REDIRECT, 0),
            unusable_pages=report.conditions.get(PageCondition.UNUSABLE_CONTENT, 0),
            errors=report.errors,
            errors_truncated=report.errors_truncated,
            duration_seconds=round(self._clock() - started, 3),
        )

    # ------------------------------------------------------------------ crawl
    def _run(
        self, site: Site, scope: SiteScope, start_url: str, max_pages: int, use_sitemaps: bool
    ) -> _Report:
        report = _Report()
        origin = urlunsplit((*urlsplit(start_url)[:2], "", "", ""))
        robots = self._load_robots(origin, scope, report)
        self._delay = max(
            self._config.request_delay_seconds,
            min(robots.crawl_delay or 0.0, self._config.max_crawl_delay_seconds),
        )
        self._discovered = 0
        if robots.disallow_all:
            report.error(f"{origin}/robots.txt", "robots.txt disallows crawling this site")
            return report

        existing = self._store.existing_urls(site.id)
        queue: deque[str] = deque()
        seen: set[str] = set()
        processed: set[str] = set()
        discovery_cap = max(
            max_pages * self._config.discovery_factor, self._config.min_discovery_limit
        )

        def enqueue(raw: str, base: str | None = None) -> None:
            url = normalize_crawl_url(raw, base)
            if url is None or not scope.contains(url) or is_asset(url) or looks_like_trap(url):
                return
            key = url_key(url)
            if key in seen:
                return
            if len(seen) >= discovery_cap:
                report.skipped[SkipReason.DISCOVERY_LIMIT] += 1
                return
            seen.add(key)
            self._discovered += 1
            if not robots.can_fetch(url):
                report.skipped[SkipReason.ROBOTS_DISALLOWED] += 1
                return
            queue.append(url)

        enqueue(start_url)
        if use_sitemaps:
            for page_url in self._discover_sitemap_urls(origin, scope, robots, report):
                enqueue(page_url)

        def may_follow(target: str) -> bool:
            normalised = normalize_crawl_url(target)
            return bool(
                normalised
                and scope.contains(normalised)
                and robots.can_fetch(normalised)
                and not is_asset(normalised)
            )

        while queue:
            if report.crawled >= max_pages:
                report.skipped[SkipReason.MAX_PAGES_REACHED] += len(queue)
                break
            url = queue.popleft()
            if url_key(url) in processed:
                continue
            processed.add(url_key(url))
            self._pause()
            report.crawled += 1
            try:
                result = self._fetcher.fetch(url, may_follow=may_follow)
            except FetchError as exc:
                report.error(url, str(exc), exc.status)
                continue
            except Exception as exc:  # one broken page must never stop the crawl
                logger.exception("Unexpected error fetching %s", url)
                report.error(url, f"Unexpected error: {type(exc).__name__}")
                continue
            try:
                self._handle_result(site, scope, url, result, existing, processed, enqueue, report)
            except (SQLAlchemyError, AppError) as exc:
                self._store.rollback()
                logger.warning("Failed to store %s: %s", url, exc)
                report.error(url, f"Failed to store page: {type(exc).__name__}", result.status)
            except Exception as exc:
                self._store.rollback()
                logger.exception("Unexpected error processing %s", url)
                report.error(url, f"Unexpected error: {type(exc).__name__}", result.status)

        logger.info(
            "Crawl of %s: discovered=%d crawled=%d created=%d updated=%d errors=%d",
            site.base_url,
            self._discovered,
            report.crawled,
            report.created,
            report.updated,
            len(report.errors),
        )
        return report

    def _handle_result(
        self,
        site: Site,
        scope: SiteScope,
        requested: str,
        result: FetchResult,
        existing: dict[str, str],
        processed: set[str],
        enqueue: Callable[[str, str | None], None],
        report: _Report,
    ) -> None:
        # Record every redirect hop so interlinking never targets a redirecting URL.
        for hop_url, hop_status, location in result.redirects:
            hop = normalize_crawl_url(hop_url)
            target = normalize_crawl_url(location) or location
            if hop is None:
                continue
            self._save(
                site,
                PageUpsert(
                    url=existing.get(url_key(hop), hop),
                    http_status=hop_status,
                    redirect_url=target,
                    last_crawled_at=datetime.now(UTC),
                ),
                existing,
                report,
                status_only=True,
            )
        if result.blocked_redirect is not None:
            return  # redirect leaves the site / is disallowed: nothing more to fetch

        final = normalize_crawl_url(result.final_url) or requested
        final_key = url_key(final)
        if final_key != url_key(requested):
            if final_key in processed:
                report.skipped[SkipReason.DUPLICATE_FINAL_URL] += 1
                return
            processed.add(final_key)
        stored_url = existing.get(final_key, final)
        status = result.status

        if 200 <= status < 300:
            if not result.is_html:
                report.skipped[SkipReason.NOT_HTML] += 1
                return
            page = extract_page(
                result.text(), final, x_robots_tag=result.headers.get("x-robots-tag")
            )
            html_redirect_url = self._resolve_html_redirect(
                page.html_redirect, final, final_key, scope, enqueue, report
            )
            for link in page.links:
                enqueue(link, None)
            if page.canonical_url:
                enqueue(page.canonical_url, None)
            # Internal contextual links only (same site, not assets, not self-links).
            # One entry per page (/a and /a/ are the same page), using the stored URL form.
            content_links: dict[str, str] = {}
            for link in page.content_links:
                key = url_key(link)
                if scope.contains(link) and not is_asset(link) and key != final_key:
                    content_links.setdefault(key, existing.get(key, link))
            self._save(
                site,
                PageUpsert(
                    url=stored_url,
                    title=page.title,
                    h1=page.h1,
                    meta_description=page.meta_description,
                    content_html=page.content_html,
                    canonical_url=page.canonical_url,
                    http_status=status,
                    # An HTML-level redirect is stored like an HTTP redirect (the true HTTP
                    # status is kept): interlink filters exclude pages with redirect_url.
                    redirect_url=html_redirect_url,
                    # Redirecting or content-less pages are not usable content pages.
                    is_indexable=not page.noindex
                    and html_redirect_url is None
                    and not page.is_empty,
                    has_noindex=page.noindex,
                    language=page.language,
                    keywords=page.keywords,
                    outgoing_links=list(content_links.values()),
                    last_crawled_at=datetime.now(UTC),
                ),
                existing,
                report,
            )
            if page.is_empty and html_redirect_url is None:
                report.conditions[PageCondition.UNUSABLE_CONTENT] += 1
        elif status >= 400:
            report.error(requested, f"HTTP {status}", status)
            # Keep stored content; only mark the existing page's new status.
            if final_key in existing and self._store.update_status(
                site.id, existing[final_key], http_status=status, redirect_url=None
            ):
                report.updated += 1
        else:
            report.skipped[SkipReason.UNEXPECTED_STATUS] += 1

    def _resolve_html_redirect(
        self,
        redirect: HtmlRedirect | None,
        page_url: str,
        page_key: str,
        scope: SiteScope,
        enqueue: Callable[[str, str | None], None],
        report: _Report,
    ) -> str | None:
        """Validate an HTML-declared redirect; queue it when safe. Returns the URL to store.

        The raw target comes from page markup/script data and is untrusted: it goes through
        the same normalisation, scope, SSRF (and, via `enqueue`, robots/asset/trap) checks as
        any discovered link. Unsafe or unparseable targets are reported and ignored.
        """
        if redirect is None:
            return None
        if redirect.has_unsafe_scheme:
            report.error(page_url, f"Ignored unsafe {redirect.type} target", 200)
            return None
        target = normalize_crawl_url(redirect.target, page_url)
        if target is None:
            report.error(page_url, f"Ignored invalid {redirect.type} target", 200)
            return None
        if url_key(target) == page_key:
            return None  # redirect to itself: nothing to follow
        report.conditions[PageCondition.HTML_REDIRECT] += 1
        try:
            validate_url(target, allowed_ports=self._config.allowed_ports)
        except SSRFError:
            # Still a redirect in a browser (so the page is not a content page); never followed.
            report.error(page_url, f"{redirect.type} target blocked by SSRF protection", 200)
            return target
        if scope.contains(target):
            enqueue(target, None)  # also applies robots / asset / trap / duplicate checks
        else:
            logger.info(
                "%s on %s points off-site (%s); not followed", redirect.type, page_url, target
            )
        return target

    def _save(
        self,
        site: Site,
        page: PageUpsert,
        existing: dict[str, str],
        report: _Report,
        *,
        status_only: bool = False,
    ) -> None:
        key = url_key(page.url)
        if key in existing:
            if status_only:
                assert page.http_status is not None
                self._store.update_status(
                    site.id,
                    existing[key],
                    http_status=page.http_status,
                    redirect_url=page.redirect_url,
                )
            else:
                self._store.upsert_page(site.id, page)
            report.updated += 1
        else:
            self._store.upsert_page(site.id, page)
            existing[key] = page.url
            report.created += 1

    # ------------------------------------------------------------------ robots / sitemaps
    def _pause(self) -> None:
        if self._requests_made and self._delay > 0:
            self._sleep(self._delay)
        self._requests_made += 1

    def _load_robots(self, origin: str, scope: SiteScope, report: _Report) -> RobotsRules:
        url = f"{origin}/robots.txt"
        self._pause()
        try:
            result = self._fetcher.fetch(
                url, may_follow=scope.contains, accept="text/plain,*/*;q=0.5"
            )
        except FetchError as exc:
            # RFC 9309: unreachable robots.txt -> assume complete disallow.
            report.error(url, f"robots.txt unreachable: {exc}", exc.status)
            rules = RobotsRules.disallowing_all(exc.status)
        else:
            if result.blocked_redirect is not None or result.status >= 500:
                rules = RobotsRules.disallowing_all(result.status)
            elif 400 <= result.status < 500:
                rules = RobotsRules.allowing_all(result.status)
            elif 200 <= result.status < 300:
                rules = parse_robots(result.text(), self._config.user_agent)
                rules.source_status = result.status
            else:
                rules = RobotsRules.disallowing_all(result.status)
        policy = (
            "disallow_all" if rules.disallow_all else "allow_all" if rules.allow_all else "parsed"
        )
        report.robots = RobotsSummary(
            status=rules.source_status,
            policy=policy,
            sitemaps=rules.sitemaps,
            crawl_delay=rules.crawl_delay,
        )
        return rules

    def _discover_sitemap_urls(
        self, origin: str, scope: SiteScope, robots: RobotsRules, report: _Report
    ) -> list[str]:
        declared = [u for u in (normalize_crawl_url(s) for s in robots.sitemaps) if u]
        pending: deque[tuple[str, bool]] = deque((u, True) for u in declared if scope.contains(u))
        for u in declared:
            if not scope.contains(u):
                report.error(u, "Sitemap is outside the site scope; ignored")
        if not pending:
            pending.append((f"{origin}/sitemap.xml", False))  # conventional location
        seen: set[str] = set()
        pages: list[str] = []
        while pending and report.sitemaps_processed < self._config.max_sitemaps:
            sitemap_url, declared_in_robots = pending.popleft()
            if sitemap_url in seen or not robots.can_fetch(sitemap_url):
                continue
            seen.add(sitemap_url)
            self._pause()
            try:
                result = self._fetcher.fetch(
                    sitemap_url, may_follow=scope.contains, accept=SITEMAP_ACCEPT
                )
            except FetchError as exc:
                report.error(sitemap_url, f"Sitemap fetch failed: {exc}", exc.status)
                continue
            if result.status != 200:
                if declared_in_robots or result.status != 404:
                    report.error(sitemap_url, f"Sitemap HTTP {result.status}", result.status)
                continue
            report.sitemaps_processed += 1
            try:
                parsed = parse_sitemap(result.body, max_bytes=self._config.max_response_bytes)
            except SitemapError as exc:
                report.error(sitemap_url, str(exc), result.status)
                continue
            for child in parsed.child_sitemaps:
                child_url = normalize_crawl_url(child, sitemap_url)
                if child_url and scope.contains(child_url):
                    pending.append((child_url, True))
            pages.extend(parsed.page_urls)
        return pages
