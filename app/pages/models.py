"""Page inventory: websites and their crawled/imported pages.

This is the URL inventory consumed by the interlink module (and future crawler/audit modules).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Site(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "sites"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    base_url: Mapped[str] = mapped_column(String(2048), nullable=False, unique=True)
    default_language: Mapped[str | None] = mapped_column(String(16))
    default_region: Mapped[str | None] = mapped_column(String(16))

    pages: Mapped[list[Page]] = relationship(back_populates="site", passive_deletes=True)


class Page(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "pages"
    __table_args__ = (UniqueConstraint("site_id", "url", name="uq_pages_site_id_url"),)

    site_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    h1: Mapped[str | None] = mapped_column(Text)
    meta_description: Mapped[str | None] = mapped_column(Text)
    content_html: Mapped[str | None] = mapped_column(Text, deferred=True)
    # Incremented on every content write; used for optimistic concurrency when applying links.
    content_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    canonical_url: Mapped[str | None] = mapped_column(String(2048))
    http_status: Mapped[int | None] = mapped_column(Integer, index=True)
    redirect_url: Mapped[str | None] = mapped_column(String(2048))
    is_indexable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    has_noindex: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    language: Mapped[str | None] = mapped_column(String(16))
    region: Mapped[str | None] = mapped_column(String(16))
    page_type: Mapped[str | None] = mapped_column(String(64))
    keywords: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default=text("'{}'")
    )
    # Normalised absolute URLs of internal links found in content_html.
    outgoing_links: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default=text("'{}'")
    )
    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    site: Mapped[Site] = relationship(back_populates="pages")
