"""Persistence for crawl results, on top of the existing `pages` table / `PageService`."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Protocol

from sqlalchemy import Engine, func, select, text, update
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictError
from app.core.urls import url_key
from app.pages.models import Page
from app.pages.schemas import PageUpsert
from app.pages.service import PageService


class CrawlStore(Protocol):
    def existing_urls(self, site_id: uuid.UUID) -> dict[str, str]:
        """url_key -> stored URL for every page of the site."""
        ...

    def upsert_page(self, site_id: uuid.UUID, page: PageUpsert) -> uuid.UUID: ...

    def update_status(
        self, site_id: uuid.UUID, url: str, *, http_status: int, redirect_url: str | None
    ) -> bool:
        """Update only status/redirect of an existing page (keeps its content). True if found."""
        ...

    def rollback(self) -> None: ...

    def site_lock(self, site_id: uuid.UUID) -> AbstractContextManager[None]: ...


class SqlAlchemyCrawlStore:
    def __init__(self, session: Session, engine: Engine | None = None) -> None:
        self._session = session
        self._pages = PageService(session)
        self._engine = engine

    def existing_urls(self, site_id: uuid.UUID) -> dict[str, str]:
        urls = self._session.scalars(select(Page.url).where(Page.site_id == site_id))
        return {url_key(u): u for u in urls}

    def upsert_page(self, site_id: uuid.UUID, page: PageUpsert) -> uuid.UUID:
        return self._pages.upsert_pages(site_id, [page])[0]

    def update_status(
        self, site_id: uuid.UUID, url: str, *, http_status: int, redirect_url: str | None
    ) -> bool:
        result = self._session.execute(
            update(Page)
            .where(Page.site_id == site_id, Page.url == url)
            .values(http_status=http_status, redirect_url=redirect_url, updated_at=func.now())
        )
        self._session.commit()
        return bool(getattr(result, "rowcount", 0))

    def rollback(self) -> None:
        self._session.rollback()

    @contextmanager
    def site_lock(self, site_id: uuid.UUID) -> Iterator[None]:
        """Session-level PostgreSQL advisory lock on a dedicated connection.

        Prevents two crawls of the same site running concurrently. A dedicated connection is
        required because the ORM session returns its connection to the pool on each commit.
        """
        if self._engine is None:
            yield
            return
        with self._engine.connect() as conn:
            key = f"crawl:{site_id}"
            acquired = conn.execute(
                text("SELECT pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
            ).scalar()
            if not acquired:
                raise ConflictError(
                    "A crawl for this site is already running", code="CRAWL_IN_PROGRESS"
                )
            try:
                yield
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(hashtextextended(:k, 0))"), {"k": key})
                conn.commit()
