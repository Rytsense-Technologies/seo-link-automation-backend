"""Sitemap parsing: <urlset>, <sitemapindex>, gzip and plain-text sitemaps."""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field
from xml.etree import ElementTree

GZIP_MAGIC = b"\x1f\x8b"


class SitemapError(ValueError):
    pass


@dataclass
class ParsedSitemap:
    page_urls: list[str] = field(default_factory=list)
    child_sitemaps: list[str] = field(default_factory=list)


def _gunzip(data: bytes, limit: int) -> bytes:
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = decompressor.decompress(data, limit + 1)
    if len(out) > limit or decompressor.unconsumed_tail:
        raise SitemapError(f"Decompressed sitemap exceeds {limit} bytes")
    return out


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parse_sitemap(body: bytes, *, max_bytes: int) -> ParsedSitemap:
    if body[:2] == GZIP_MAGIC:
        try:
            body = _gunzip(body, max_bytes)
        except zlib.error as exc:
            raise SitemapError("Invalid gzip sitemap") from exc
    stripped = body.lstrip()
    if not stripped.startswith(b"<"):
        # Plain-text sitemap: one URL per line.
        lines = stripped.decode("utf-8", errors="replace").splitlines()
        return ParsedSitemap(page_urls=[u.strip() for u in lines if u.strip().startswith("http")])
    if b"<!DOCTYPE" in stripped[:2000].upper() or b"<!ENTITY" in stripped.upper():
        raise SitemapError("Sitemaps with DTDs/entities are not accepted")
    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError as exc:
        raise SitemapError(f"Invalid sitemap XML: {exc}") from exc
    kind = _local(root.tag)
    result = ParsedSitemap()
    container = {"sitemapindex": "sitemap", "urlset": "url"}.get(kind)
    if container is None:
        raise SitemapError(f"Unexpected sitemap root element <{kind}>")
    for entry in root:
        if _local(entry.tag) != container:
            continue
        for child in entry:
            if _local(child.tag) == "loc" and child.text and child.text.strip():
                target = result.child_sitemaps if kind == "sitemapindex" else result.page_urls
                target.append(child.text.strip())
    return result
