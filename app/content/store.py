"""Content persistence boundary.

Applying an internal link writes page content through a `ContentStore`. The default store
persists to the `pages` table. A CMS-backed store (e.g. Sanity / Portable Text) can be added
by implementing the same protocol and selecting it in `app.interlink.dependencies`.
"""

from __future__ import annotations

from typing import Protocol

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.content.html import extract_links
from app.core.exceptions import ConflictError
from app.core.urls import same_host
from app.pages.models import Page


class ContentStore(Protocol):
    def load_content(self, page: Page) -> str | None: ...

    def save_content(self, page: Page, new_content: str, *, expected_version: int) -> None:
        """Persist new content. Must raise ConflictError if the content changed concurrently."""
        ...


def internal_links_for(page_url: str, content: str) -> list[str]:
    return sorted({link for link in extract_links(content, page_url) if same_host(link, page_url)})


class DatabaseContentStore:
    def __init__(self, session: Session) -> None:
        self._session = session

    def load_content(self, page: Page) -> str | None:
        return page.content_html

    def save_content(self, page: Page, new_content: str, *, expected_version: int) -> None:
        outgoing = internal_links_for(page.url, new_content)
        result = self._session.execute(
            update(Page)
            .where(Page.id == page.id, Page.content_version == expected_version)
            .values(
                content_html=new_content,
                content_version=Page.content_version + 1,
                outgoing_links=outgoing,
            )
            .execution_options(synchronize_session=False)
        )
        if getattr(result, "rowcount", 0) != 1:
            raise ConflictError(
                "Source page content changed while the link was being applied; retry.",
                code="CONTENT_VERSION_CONFLICT",
            )
        page.content_html = new_content
        page.content_version = expected_version + 1
        page.outgoing_links = outgoing
