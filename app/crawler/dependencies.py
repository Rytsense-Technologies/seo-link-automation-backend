"""Composition root for the crawler (HTTP client, store, crawler)."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.crawler.fetcher import Fetcher, FetcherConfig
from app.crawler.service import CrawlConfig, SiteCrawler
from app.crawler.ssrf import GuardedHTTPTransport
from app.crawler.store import SqlAlchemyCrawlStore
from app.db.session import get_db, get_engine


def get_crawler_http_client(settings: Settings = Depends(get_settings)) -> Iterator[httpx.Client]:
    """SSRF-guarded client: public IPs only, allowed ports only, no env proxies."""
    client = httpx.Client(
        transport=GuardedHTTPTransport(allowed_ports=settings.crawler_allowed_ports),
        timeout=httpx.Timeout(settings.crawler_timeout_seconds),
        follow_redirects=False,
        trust_env=False,
    )
    try:
        yield client
    finally:
        client.close()


def get_site_crawler(
    session: Session = Depends(get_db),
    client: httpx.Client = Depends(get_crawler_http_client),
    settings: Settings = Depends(get_settings),
) -> SiteCrawler:
    ports = tuple(settings.crawler_allowed_ports)
    fetcher = Fetcher(
        client,
        FetcherConfig(
            user_agent=settings.crawler_user_agent,
            max_retries=settings.crawler_max_retries,
            max_redirects=settings.crawler_max_redirects,
            max_response_bytes=settings.crawler_max_response_bytes,
            allowed_ports=ports,
            max_retry_after_seconds=settings.crawler_max_crawl_delay_seconds,
        ),
    )
    return SiteCrawler(
        SqlAlchemyCrawlStore(session, get_engine()),
        fetcher,
        CrawlConfig(
            request_delay_seconds=settings.crawler_request_delay_seconds,
            max_crawl_delay_seconds=settings.crawler_max_crawl_delay_seconds,
            max_pages_limit=settings.crawler_max_pages_limit,
            max_sitemaps=settings.crawler_max_sitemaps,
            max_response_bytes=settings.crawler_max_response_bytes,
            allowed_ports=ports,
            user_agent=settings.crawler_user_agent,
        ),
    )
