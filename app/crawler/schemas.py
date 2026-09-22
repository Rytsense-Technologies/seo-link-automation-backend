from __future__ import annotations

import uuid

from pydantic import BaseModel, Field, HttpUrl


class CrawlRequest(BaseModel):
    start_url: HttpUrl | None = Field(
        default=None,
        description="Must be on the site's host. Defaults to the site's base_url.",
        examples=["https://rytsensetech.com/"],
    )
    max_pages: int = Field(
        default=100, ge=1, le=1000, description="Maximum number of pages to fetch"
    )
    use_sitemaps: bool = Field(
        default=True, description="Discover URLs from robots.txt sitemaps / /sitemap.xml"
    )
    include_www_variant: bool = Field(
        default=False,
        description="Also treat the www./non-www. variant of the site host as in scope",
    )


class CrawlError(BaseModel):
    url: str
    error: str
    status: int | None = None


class RobotsSummary(BaseModel):
    status: int | None = Field(description="HTTP status of /robots.txt (null if unreachable)")
    policy: str = Field(examples=["parsed", "allow_all", "disallow_all"])
    sitemaps: list[str]
    crawl_delay: float | None


class CrawlResponse(BaseModel):
    site_id: uuid.UUID
    start_url: str
    robots: RobotsSummary
    sitemaps_processed: int
    pages_discovered: int = Field(description="Unique in-scope page URLs found")
    pages_crawled: int = Field(description="Page URLs fetched")
    pages_created: int
    pages_updated: int
    pages_skipped: int
    skipped_reasons: dict[str, int] = Field(
        examples=[{"ROBOTS_DISALLOWED": 3, "NOT_HTML": 1, "MAX_PAGES_REACHED": 9}]
    )
    max_pages_reached: bool
    html_redirects: int = Field(
        default=0,
        description="Pages that declared a redirect in HTML (Next.js NEXT_REDIRECT / meta refresh)",
    )
    unusable_pages: int = Field(
        default=0, description="2xx HTML pages stored as not indexable: no usable content"
    )
    errors: list[CrawlError]
    errors_truncated: bool = False
    duration_seconds: float
