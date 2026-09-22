"""Crawler URL normalisation and site scope."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.core.urls import normalize_url

# Query parameters that never identify a different page.
TRACKING_PARAMS = frozenset(
    {
        "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "fbclid", "msclkid", "yclid",
        "twclid", "ttclid", "li_fat_id", "igshid", "mc_cid", "mc_eid", "_ga", "_gl",
        "_hsenc", "_hsmi", "hsctatracking", "mkt_tok", "vero_id", "srsltid", "ref_src",
    }
)  # fmt: skip
TRACKING_PREFIXES = ("utm_", "pk_", "matomo_", "hsa_")

# Non-HTML resources that are never crawled as pages.
ASSET_EXTENSIONS = frozenset(
    {
        "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff",
        "css", "js", "mjs", "map", "json", "xml", "txt", "rss", "atom",
        "woff", "woff2", "ttf", "otf", "eot",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "zip", "gz", "rar",
        "7z", "tar", "mp3", "mp4", "m4a", "wav", "avi", "mov", "webm", "ogg", "exe",
        "dmg", "apk",
    }
)  # fmt: skip

MAX_URL_LENGTH = 2048
MAX_PATH_SEGMENTS = 15
MAX_QUERY_PARAMS = 5
_REPEATED_SEGMENT = re.compile(r"(/[^/]+)\1{2,}")  # /a/a/a -> crawler trap


def _is_tracking(name: str) -> bool:
    lowered = name.lower()
    return lowered in TRACKING_PARAMS or lowered.startswith(TRACKING_PREFIXES)


def normalize_crawl_url(url: str, base: str | None = None) -> str | None:
    """Absolute http(s) URL without fragment, default port or tracking parameters.

    Remaining query parameters are kept (they may select different content) but sorted so
    parameter order does not create duplicates. Trailing-slash variants are unified by
    `app.core.urls.url_key` when de-duplicating.
    """
    normalised = normalize_url(url, base)
    if normalised is None:
        return None
    parts = urlsplit(normalised)
    query = [
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k)
    ]
    query.sort()
    path = re.sub(r"/{2,}", "/", parts.path) or "/"
    return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), ""))


def is_asset(url: str) -> bool:
    path = urlsplit(url).path.lower()
    last = path.rsplit("/", 1)[-1]
    return "." in last and last.rsplit(".", 1)[-1] in ASSET_EXTENSIONS


def looks_like_trap(url: str) -> bool:
    parts = urlsplit(url)
    if len(url) > MAX_URL_LENGTH:
        return True
    if len([s for s in parts.path.split("/") if s]) > MAX_PATH_SEGMENTS:
        return True
    if parts.query and len(parse_qsl(parts.query, keep_blank_values=True)) > MAX_QUERY_PARAMS:
        return True
    return bool(_REPEATED_SEGMENT.search(parts.path))


@dataclass(frozen=True)
class SiteScope:
    """Hosts that belong to a site. `www.` is only included when explicitly allowed."""

    hosts: frozenset[str]
    scheme: str

    @classmethod
    def for_site(
        cls, base_url: str, *, include_www_variant: bool = False, extra_hosts: Iterable[str] = ()
    ) -> SiteScope:
        parts = urlsplit(base_url)
        host = (parts.hostname or "").lower()
        hosts = {host, *(h.lower() for h in extra_hosts)}
        if include_www_variant:
            hosts.add(host.removeprefix("www.") if host.startswith("www.") else f"www.{host}")
        return cls(hosts=frozenset(hosts), scheme=parts.scheme.lower())

    def contains(self, url: str) -> bool:
        parts = urlsplit(url)
        return parts.scheme in ("http", "https") and (parts.hostname or "").lower() in self.hosts
