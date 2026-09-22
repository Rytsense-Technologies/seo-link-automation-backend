from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Body, Depends

from app.core.exceptions import ERROR_RESPONSES, ErrorResponse
from app.crawler.dependencies import get_site_crawler
from app.crawler.schemas import CrawlRequest, CrawlResponse
from app.crawler.service import SiteCrawler
from app.pages.router import get_page_service
from app.pages.service import PageService

router = APIRouter(tags=["crawler"], responses=ERROR_RESPONSES)

_CRAWL_ERRORS: dict[int | str, dict[str, Any]] = {
    409: {"model": ErrorResponse, "description": "A crawl for this site is already running"},
}


@router.post(
    "/sites/{site_id}/crawl",
    response_model=CrawlResponse,
    summary="Crawl the site and update its page inventory",
    responses=_CRAWL_ERRORS,
)
def crawl_site(
    site_id: uuid.UUID,
    request: CrawlRequest = Body(default_factory=CrawlRequest),
    pages: PageService = Depends(get_page_service),
    crawler: SiteCrawler = Depends(get_site_crawler),
) -> CrawlResponse:
    """Reads robots.txt (RFC 9309) and honours it, discovers URLs from sitemaps
    (robots `Sitemap:` lines, sitemap indexes, or `/sitemap.xml`) and same-host HTML links,
    then inserts or updates rows in `pages` (keyed by normalised URL, so re-running is safe).

    Only the site's own host is crawled (plus the `www.` variant when
    `include_www_variant` is true). All requests are SSRF-guarded: public IPs only, ports
    80/443, no credentials in URLs, and every redirect hop is re-validated.

    Crawling only reads the website; it never modifies it. Links are still applied only
    through the approve/apply workflow.
    """
    site = pages.get_site(site_id)
    return crawler.crawl(site, request)
