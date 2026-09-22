from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class SiteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    base_url: HttpUrl
    default_language: str | None = Field(default=None, max_length=16, examples=["en"])
    default_region: str | None = Field(default=None, max_length=16, examples=["us"])


class SiteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    base_url: str
    default_language: str | None
    default_region: str | None
    created_at: datetime
    updated_at: datetime


class PageUpsert(BaseModel):
    """A page record as produced by a crawler or content import."""

    url: str = Field(min_length=1, max_length=2048, description="Absolute or site-relative URL")
    title: str | None = None
    h1: str | None = None
    meta_description: str | None = None
    content_html: str | None = None
    canonical_url: str | None = Field(default=None, max_length=2048)
    http_status: int | None = Field(default=200, ge=100, le=599)
    redirect_url: str | None = Field(default=None, max_length=2048)
    is_indexable: bool = True
    has_noindex: bool = False
    language: str | None = Field(default=None, max_length=16)
    region: str | None = Field(default=None, max_length=16)
    page_type: str | None = Field(default=None, max_length=64, examples=["service", "blog"])
    keywords: list[str] = Field(default_factory=list, max_length=100)
    outgoing_links: list[str] | None = Field(
        default=None, description="Internal links; derived from content_html when omitted"
    )
    last_crawled_at: datetime | None = None


class PageBulkUpsert(BaseModel):
    pages: list[PageUpsert] = Field(min_length=1, max_length=1000)


class PageBulkUpsertResult(BaseModel):
    upserted: int
    page_ids: list[uuid.UUID]


class PageSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    url: str
    title: str | None
    h1: str | None


class PageRead(PageSummary):
    site_id: uuid.UUID
    meta_description: str | None
    canonical_url: str | None
    http_status: int | None
    redirect_url: str | None
    is_indexable: bool
    has_noindex: bool
    language: str | None
    region: str | None
    page_type: str | None
    keywords: list[str]
    outgoing_links: list[str]
    content_version: int
    last_crawled_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PageDetail(PageRead):
    content_html: str | None


class PageList(BaseModel):
    items: list[PageRead]
    total: int
    page: int
    page_size: int
