"""Page inventory service: sites and page upsert/read (the data a crawler or import provides)."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import Integer, cast, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer

from app.content.store import internal_links_for
from app.core.exceptions import ConflictError, NotFoundError, UnprocessableError
from app.core.urls import normalize_url, same_host
from app.pages.models import Page, Site
from app.pages.schemas import PageUpsert, SiteCreate

logger = logging.getLogger(__name__)


class PageService:
    def __init__(self, session: Session) -> None:
        self._session = session

    # Sites -------------------------------------------------------------
    def create_site(self, data: SiteCreate) -> Site:
        base_url = normalize_url(str(data.base_url))
        assert base_url is not None  # HttpUrl guarantees http(s)
        site = Site(
            name=data.name,
            base_url=base_url,
            default_language=data.default_language,
            default_region=data.default_region,
        )
        self._session.add(site)
        try:
            self._session.commit()
        except IntegrityError as exc:
            self._session.rollback()
            raise ConflictError("A site with this base_url already exists") from exc
        return site

    def list_sites(self) -> list[Site]:
        return list(self._session.scalars(select(Site).order_by(Site.created_at)))

    def get_site(self, site_id: uuid.UUID) -> Site:
        site = self._session.get(Site, site_id)
        if site is None:
            raise NotFoundError("Site not found", code="SITE_NOT_FOUND")
        return site

    # Pages -------------------------------------------------------------
    def upsert_pages(self, site_id: uuid.UUID, pages: list[PageUpsert]) -> list[uuid.UUID]:
        site = self.get_site(site_id)
        rows: dict[str, dict[str, object]] = {}
        for item in pages:
            url = normalize_url(item.url, site.base_url)
            if url is None or not same_host(url, site.base_url):
                raise UnprocessableError(
                    f"URL is not an internal http(s) URL of this site: {item.url}",
                    code="INVALID_PAGE_URL",
                )
            canonical = normalize_url(item.canonical_url, url) if item.canonical_url else None
            redirect = normalize_url(item.redirect_url, url) if item.redirect_url else None
            if item.outgoing_links is not None:
                outgoing = sorted(
                    {
                        link
                        for raw in item.outgoing_links
                        if (link := normalize_url(raw, url)) and same_host(link, url)
                    }
                )
            elif item.content_html:
                outgoing = internal_links_for(url, item.content_html)
            else:
                outgoing = []
            rows[url] = {
                "id": uuid.uuid4(),
                "site_id": site.id,
                "url": url,
                "title": item.title,
                "h1": item.h1,
                "meta_description": item.meta_description,
                "content_html": item.content_html,
                "canonical_url": canonical,
                "http_status": item.http_status,
                "redirect_url": redirect,
                "is_indexable": item.is_indexable,
                "has_noindex": item.has_noindex,
                "language": (item.language or site.default_language),
                "region": (item.region or site.default_region),
                "page_type": item.page_type,
                "keywords": [k.strip() for k in item.keywords if k.strip()],
                "outgoing_links": outgoing,
                "last_crawled_at": item.last_crawled_at,
            }
        stmt = insert(Page).values(list(rows.values()))
        update_cols: dict[str, Any] = {
            col: stmt.excluded[col] for col in next(iter(rows.values())) if col not in ("id",)
        }
        update_cols["updated_at"] = func.now()
        # Only bump the version when content actually changes.
        update_cols["content_version"] = Page.content_version + cast(
            Page.content_html.is_distinct_from(stmt.excluded.content_html), Integer
        )
        upsert = stmt.on_conflict_do_update(
            constraint="uq_pages_site_id_url", set_=update_cols
        ).returning(Page.id)
        ids = list(self._session.scalars(upsert))
        self._session.commit()
        logger.info("Upserted %d pages for site %s", len(ids), site.id)
        return ids

    def list_pages(
        self, *, site_id: uuid.UUID | None, page: int, page_size: int
    ) -> tuple[list[Page], int]:
        query = select(Page)
        count = select(func.count()).select_from(Page)
        if site_id is not None:
            query = query.where(Page.site_id == site_id)
            count = count.where(Page.site_id == site_id)
        total = self._session.scalar(count) or 0
        items = self._session.scalars(
            query.order_by(Page.url).offset((page - 1) * page_size).limit(page_size)
        )
        return list(items), total

    def get_page(self, page_id: uuid.UUID) -> Page:
        page = self._session.scalar(
            select(Page).where(Page.id == page_id).options(undefer(Page.content_html))
        )
        if page is None:
            raise NotFoundError("Page not found", code="PAGE_NOT_FOUND")
        return page
