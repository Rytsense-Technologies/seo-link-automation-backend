"""Deterministic hard filters applied before any AI scoring.

These are the rules that decide whether a page may be linked *at all*; the AI only ranks
pages that already passed them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.content.html import extract_text
from app.core.urls import normalize_url, same_host, url_key, url_path
from app.pages.models import Page


class ExclusionReason:
    SOURCE_PAGE = "SOURCE_PAGE"
    DIFFERENT_SITE = "DIFFERENT_SITE"
    NOT_FOUND = "HTTP_404"
    SERVER_ERROR = "HTTP_5XX"
    BAD_STATUS = "NON_200_STATUS"
    REDIRECTED = "REDIRECTED"
    NOINDEX = "NOINDEX"
    NOT_INDEXABLE = "NOT_INDEXABLE"
    CANONICAL_MISMATCH = "CANONICAL_POINTS_ELSEWHERE"
    DUPLICATE_URL = "DUPLICATE_URL"
    LANGUAGE_MISMATCH = "LANGUAGE_MISMATCH"
    REGION_MISMATCH = "REGION_MISMATCH"
    UTILITY_PAGE = "UTILITY_PAGE"
    ALREADY_LINKED = "ALREADY_LINKED"
    UNLINKABLE_URL = "UNLINKABLE_URL"
    EMPTY_CONTENT = "EMPTY_CONTENT"


@dataclass(frozen=True)
class FilterConfig:
    utility_page_types: frozenset[str] = frozenset()
    utility_path_patterns: tuple[re.Pattern[str], ...] = ()
    require_region_match: bool = True

    @classmethod
    def from_values(
        cls, page_types: Iterable[str], path_patterns: Iterable[str], require_region_match: bool
    ) -> FilterConfig:
        return cls(
            utility_page_types=frozenset(t.lower() for t in page_types),
            utility_path_patterns=tuple(re.compile(p, re.IGNORECASE) for p in path_patterns),
            require_region_match=require_region_match,
        )


@dataclass
class FilterResult:
    accepted: list[Page] = field(default_factory=list)
    excluded: dict[str, list[Page]] = field(default_factory=dict)

    def exclude(self, page: Page, reason: str) -> None:
        self.excluded.setdefault(reason, []).append(page)


def _norm_lang(value: str | None) -> str | None:
    # "en-US" and "en" are the same language for linking purposes.
    return value.split("-")[0].split("_")[0].lower() if value else None


def _norm_region(value: str | None) -> str | None:
    return value.lower() if value else None


def target_exclusion_reason(
    source: Page,
    target: Page,
    config: FilterConfig,
    linked_keys: set[str] | None = None,
) -> str | None:
    """Return why `target` must not be linked from `source`, or None if it is eligible.

    ``linked_keys`` are `url_key`s of URLs the source already links to (defaults to the
    stored ``source.outgoing_links``). Also used at apply time to re-validate the target.
    """
    if target.id == source.id or url_key(target.url) == url_key(source.url):
        return ExclusionReason.SOURCE_PAGE
    if target.site_id != source.site_id or not same_host(target.url, source.url):
        return ExclusionReason.DIFFERENT_SITE
    status = target.http_status
    if status == 404 or status == 410:
        return ExclusionReason.NOT_FOUND
    if status is not None and status >= 500:
        return ExclusionReason.SERVER_ERROR
    if target.redirect_url or (status is not None and 300 <= status < 400):
        return ExclusionReason.REDIRECTED
    if status is None or not 200 <= status < 300:
        return ExclusionReason.BAD_STATUS
    if target.has_noindex:
        return ExclusionReason.NOINDEX
    if not target.is_indexable:
        return ExclusionReason.NOT_INDEXABLE
    if target.canonical_url:
        canonical = normalize_url(target.canonical_url, target.url)
        if canonical is None or url_key(canonical) != url_key(target.url):
            return ExclusionReason.CANONICAL_MISMATCH
    if normalize_url(target.url) is None:
        return ExclusionReason.UNLINKABLE_URL
    src_lang, tgt_lang = _norm_lang(source.language), _norm_lang(target.language)
    if src_lang and tgt_lang and src_lang != tgt_lang:
        return ExclusionReason.LANGUAGE_MISMATCH
    if config.require_region_match:
        src_region, tgt_region = _norm_region(source.region), _norm_region(target.region)
        # A target without a region is treated as global and may be linked from any region.
        if src_region and tgt_region and src_region != tgt_region:
            return ExclusionReason.REGION_MISMATCH
    if is_utility_page(target, config):
        return ExclusionReason.UTILITY_PAGE
    if not has_usable_content(target):
        return ExclusionReason.EMPTY_CONTENT
    if linked_keys is None:
        linked_keys = linked_url_keys(source.outgoing_links or [])
    if url_key(target.url) in linked_keys:
        return ExclusionReason.ALREADY_LINKED
    return None


def has_usable_content(page: Page) -> bool:
    """False for pages with no title, no H1 and no visible body text (e.g. empty 200 shells).

    Title/H1 are checked first so the deferred `content_html` column is only loaded for the
    rare pages that have neither.
    """
    if (page.title or "").strip() or (page.h1 or "").strip():
        return True
    return bool(page.content_html and extract_text(page.content_html).strip())


def linked_url_keys(urls: Iterable[str]) -> set[str]:
    return {url_key(u) for u in urls}


def is_utility_page(page: Page, config: FilterConfig) -> bool:
    if page.page_type and page.page_type.lower() in config.utility_page_types:
        return True
    path = url_path(page.url)
    return any(p.search(path) for p in config.utility_path_patterns)


def filter_candidates(
    source: Page,
    pages: Iterable[Page],
    config: FilterConfig,
    linked_keys: set[str] | None = None,
) -> FilterResult:
    result = FilterResult()
    seen: set[str] = set()
    if linked_keys is None:
        linked_keys = linked_url_keys(source.outgoing_links or [])
    for page in pages:
        reason = target_exclusion_reason(source, page, config, linked_keys)
        if reason is not None:
            result.exclude(page, reason)
            continue
        key = url_key(page.url)
        if key in seen:
            result.exclude(page, ExclusionReason.DUPLICATE_URL)
            continue
        seen.add(key)
        result.accepted.append(page)
    return result
