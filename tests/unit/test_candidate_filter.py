from __future__ import annotations

from app.interlink.candidate_filter import (
    ExclusionReason,
    FilterConfig,
    filter_candidates,
    target_exclusion_reason,
)
from tests.conftest import Site
from tests.fakes import default_config, make_page


def _cfg() -> FilterConfig:
    return default_config().filters


def _reason(site: Site, page_attr: str) -> str | None:
    return target_exclusion_reason(site.source, getattr(site, page_attr), _cfg())


def test_source_page_is_excluded(site: Site) -> None:
    assert target_exclusion_reason(site.source, site.source, _cfg()) == ExclusionReason.SOURCE_PAGE
    # Same URL with a different trailing slash / host prefix is still the source.
    twin = make_page("/customer-support-automation", title="dup")
    assert target_exclusion_reason(site.source, twin, _cfg()) == ExclusionReason.SOURCE_PAGE


def test_404_and_5xx_targets_are_excluded(site: Site) -> None:
    assert _reason(site, "not_found") == ExclusionReason.NOT_FOUND
    assert _reason(site, "server_error") == ExclusionReason.SERVER_ERROR


def test_redirected_target_is_excluded(site: Site) -> None:
    assert _reason(site, "redirected") == ExclusionReason.REDIRECTED
    silent = make_page("/moved/", http_status=308)
    assert target_exclusion_reason(site.source, silent, _cfg()) == ExclusionReason.REDIRECTED


def test_noindex_and_non_indexable_targets_are_excluded(site: Site) -> None:
    assert _reason(site, "noindex") == ExclusionReason.NOINDEX
    blocked = make_page("/blocked/", is_indexable=False)
    assert target_exclusion_reason(site.source, blocked, _cfg()) == ExclusionReason.NOT_INDEXABLE


def test_canonical_pointing_elsewhere_is_excluded(site: Site) -> None:
    assert _reason(site, "canonicalised") == ExclusionReason.CANONICAL_MISMATCH
    self_canonical = make_page("/x/", title="X", canonical_url="https://example.com/x")
    assert target_exclusion_reason(site.source, self_canonical, _cfg()) is None


def test_language_and_region_mismatch(site: Site) -> None:
    assert _reason(site, "spanish") == ExclusionReason.LANGUAGE_MISMATCH
    en_us = make_page("/us/voice/", title="Voice US", language="en-US", region="us")
    en_gb = make_page("/uk/voice/", title="Voice UK", language="en-GB", region="gb")
    assert target_exclusion_reason(en_us, en_gb, _cfg()) == ExclusionReason.REGION_MISMATCH
    global_page = make_page("/voice/", title="Voice", language="en", region=None)
    assert target_exclusion_reason(en_us, global_page, _cfg()) is None
    relaxed = FilterConfig(require_region_match=False)
    assert target_exclusion_reason(en_us, en_gb, relaxed) is None


def test_utility_pages_are_excluded(site: Site) -> None:
    assert _reason(site, "utility") == ExclusionReason.UTILITY_PAGE
    typed = make_page("/some-page/", page_type="legal")
    assert target_exclusion_reason(site.source, typed, _cfg()) == ExclusionReason.UTILITY_PAGE
    pdf = make_page("/brochure.pdf")
    assert target_exclusion_reason(site.source, pdf, _cfg()) == ExclusionReason.UTILITY_PAGE


def test_already_linked_target_is_excluded(site: Site) -> None:
    assert _reason(site, "chatbots") == ExclusionReason.ALREADY_LINKED


def test_other_site_is_excluded(site: Site) -> None:
    import uuid

    other = make_page("/ai-voice-agent/", site_id=uuid.uuid4())
    assert target_exclusion_reason(site.source, other, _cfg()) == ExclusionReason.DIFFERENT_SITE


def test_filter_candidates_dedupes_urls_and_groups_reasons(site: Site) -> None:
    dup = make_page("/ai-voice-agent", title="duplicate")  # same page without slash
    pool = [*site.repo.list_candidate_pool(site.source), dup]
    result = filter_candidates(site.source, pool, _cfg())
    accepted = {p.url for p in result.accepted}
    assert accepted == {
        site.voice.url,
        site.crm.url,
        site.dental.url,
        site.unrelated.url,
    }
    assert result.excluded[ExclusionReason.DUPLICATE_URL] == [dup]
    assert site.noindex in result.excluded[ExclusionReason.NOINDEX]


def test_pages_without_usable_content_are_excluded(site: Site) -> None:
    # Mirrors the empty 200 row stored by the first crawl (no title, H1 or content).
    empty = make_page("/ai-readiness-assessment/", title=None, h1=None, content_html="")
    assert target_exclusion_reason(site.source, empty, _cfg()) == ExclusionReason.EMPTY_CONTENT
    shell = make_page("/shell/", title="  ", content_html="<script>boot()</script><div></div>")
    assert target_exclusion_reason(site.source, shell, _cfg()) == ExclusionReason.EMPTY_CONTENT
    # A single missing field is fine as long as the page has something usable.
    no_title = make_page("/no-title/", h1="Heading only")
    body_only = make_page("/body-only/", content_html="<p>Useful body copy.</p>")
    title_only = make_page("/title-only/", title="Title only")
    for page in (no_title, body_only, title_only):
        assert target_exclusion_reason(site.source, page, _cfg()) is None, page.url
