"""Mock website (httpx.MockTransport) and in-memory crawl store. No network, no DB."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.core.urls import url_key
from app.crawler.fetcher import Fetcher, FetcherConfig
from app.crawler.service import CrawlConfig, SiteCrawler
from app.pages.models import Site
from app.pages.schemas import PageUpsert

BASE = "https://example.com"
SITE_ID = uuid.UUID("00000000-0000-0000-0000-0000000c2a71")

Responder = Callable[[httpx.Request], httpx.Response]


def html_page(
    title: str,
    body: str,
    *,
    canonical: str | None = None,
    head_extra: str = "",
    nav: str = '<a href="/">Home</a>',
    footer: str = "© Example",
) -> str:
    canon = f'<link rel="canonical" href="{canonical}">' if canonical else ""
    return (
        f'<!doctype html><html lang="en"><head><title>{title}</title>{canon}{head_extra}</head>'
        f"<body><header><nav>{nav}</nav></header><main>{body}</main>"
        f"<footer>{footer}</footer></body></html>"
    )


@dataclass
class MockSite:
    """Routes keyed by path (+query). Values: (status, body, headers) or a responder."""

    routes: dict[str, tuple[int, str | bytes, dict[str, str]] | Responder] = field(
        default_factory=dict
    )
    requests: list[str] = field(default_factory=list)

    def html(self, path: str, title: str, body: str, **kwargs: Any) -> None:
        self.routes[path] = (200, html_page(title, body, **kwargs), {"content-type": "text/html"})

    def add(self, path: str, status: int, body: str | bytes = "", **headers: str) -> None:
        self.routes[path] = (status, body, {k.replace("_", "-"): v for k, v in headers.items()})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(str(request.url))
        key = request.url.raw_path.decode()
        route = self.routes.get(key) or self.routes.get(request.url.path)
        if route is None:
            return httpx.Response(404, text="not found", headers={"content-type": "text/html"})
        if callable(route):
            return route(request)
        status, body, headers = route
        content = body.encode() if isinstance(body, str) else body
        return httpx.Response(status, content=content, headers=headers)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=False)

    def requested_paths(self) -> list[str]:
        return [httpx.URL(u).raw_path.decode() for u in self.requests]


class FakeCrawlStore:
    def __init__(self) -> None:
        self.pages: dict[str, PageUpsert] = {}
        self.upserts = 0
        self.status_updates: list[tuple[str, int, str | None]] = []
        self.fail_on: set[str] = set()
        self.locked = False

    def existing_urls(self, site_id: uuid.UUID) -> dict[str, str]:
        return {url_key(u): u for u in self.pages}

    def upsert_page(self, site_id: uuid.UUID, page: PageUpsert) -> uuid.UUID:
        if page.url in self.fail_on:
            from sqlalchemy.exc import OperationalError

            raise OperationalError("INSERT", {}, Exception("db down"))
        self.pages[page.url] = page
        self.upserts += 1
        return uuid.uuid5(uuid.NAMESPACE_URL, page.url)

    def update_status(
        self, site_id: uuid.UUID, url: str, *, http_status: int, redirect_url: str | None
    ) -> bool:
        if url not in self.pages:
            return False
        self.pages[url] = self.pages[url].model_copy(
            update={"http_status": http_status, "redirect_url": redirect_url}
        )
        self.status_updates.append((url, http_status, redirect_url))
        return True

    def rollback(self) -> None:
        pass

    @contextmanager
    def site_lock(self, site_id: uuid.UUID) -> Iterator[None]:
        self.locked = True
        try:
            yield
        finally:
            self.locked = False


def make_site(base_url: str = BASE) -> Site:
    return Site(id=SITE_ID, name="Example", base_url=f"{base_url}/")


def make_crawler(
    mock: MockSite, store: FakeCrawlStore | None = None, **config: Any
) -> tuple[SiteCrawler, FakeCrawlStore, list[float]]:
    store = store or FakeCrawlStore()
    sleeps: list[float] = []
    fetcher_kwargs = {k: config.pop(k) for k in ("max_retries", "max_redirects") if k in config}
    fetcher = Fetcher(
        mock.client(),
        FetcherConfig(
            user_agent="SEOLinkAutomationBot/0.1",
            max_response_bytes=config.get("max_response_bytes", 5_000_000),
            **fetcher_kwargs,
        ),
        sleep=sleeps.append,
    )
    crawl_config = CrawlConfig(**{"request_delay_seconds": 0.0, **config})
    return SiteCrawler(store, fetcher, crawl_config, sleep=sleeps.append), store, sleeps


ROBOTS_ALLOW_ALL = "User-agent: *\nDisallow:\n"
