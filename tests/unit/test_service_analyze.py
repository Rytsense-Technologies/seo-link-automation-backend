from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.ai.base import AIProviderError
from app.core.exceptions import NotFoundError, UnprocessableError
from app.interlink.models import SuggestionStatus
from app.interlink.schemas import AnalyzeRequest
from tests.conftest import Site, ai_item, crm_item, voice_item
from tests.fakes import FakeAIProvider, build_service, default_config, make_page


def _analyze(site: Site, provider: FakeAIProvider, **kwargs: object):  # type: ignore[no-untyped-def]
    config = kwargs.pop("config", None)
    service = build_service(site.repo, provider, config=config)  # type: ignore[arg-type]
    return service.analyze(AnalyzeRequest(source_page_id=site.source.id, **kwargs))  # type: ignore[arg-type]


def _prompt_ids(provider: FakeAIProvider) -> set[str]:
    return {c["id"] for c in json.loads(provider.calls[0]["prompt"])["CANDIDATES"]}


def test_analyze_creates_pending_suggestions(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": [voice_item(site), crm_item(site)]})
    outcome = _analyze(site, provider)

    assert [s.target_page_id for s in outcome.suggestions] == [site.voice.id, site.crm.id]
    first = outcome.suggestions[0]
    assert first.status == SuggestionStatus.PENDING
    assert first.anchor_text == "AI voice agents"
    assert first.relevance_score == 94
    assert first.ai_provider == "fake"
    assert first.retrieval_score is not None
    assert len(site.repo.suggestions) == 2
    assert site.repo.commits == 1
    assert len(provider.calls) == 1


def test_only_hard_filtered_candidates_reach_the_ai(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": []})
    outcome = _analyze(site, provider)
    ids = _prompt_ids(provider)
    assert str(site.source.id) not in ids
    for excluded in (
        site.not_found,
        site.server_error,
        site.redirected,
        site.noindex,
        site.spanish,
        site.utility,
        site.canonicalised,
        site.chatbots,  # already linked from the source
    ):
        assert str(excluded.id) not in ids
    assert str(site.voice.id) in ids
    assert outcome.excluded_counts["NOINDEX"] == 1
    assert outcome.excluded_counts["ALREADY_LINKED"] == 1
    assert outcome.excluded_counts["REDIRECTED"] == 1


def test_candidate_pool_size_is_bounded(site: Site) -> None:
    for i in range(40):
        site.repo.add_page(make_page(f"/voice-{i}/", title=f"AI voice agents for support {i}"))
    provider = FakeAIProvider({"suggestions": []})
    outcome = _analyze(site, provider, config=default_config(candidate_pool_size=12))
    assert outcome.candidates_retrieved == 12
    assert len(_prompt_ids(provider)) == 12


def test_relevance_threshold(site: Site) -> None:
    provider = FakeAIProvider(
        {"suggestions": [voice_item(site, relevance_score=69), crm_item(site, relevance_score=70)]}
    )
    outcome = _analyze(site, provider)
    assert [s.target_page_id for s in outcome.suggestions] == [site.crm.id]
    assert {(s.target_page_id, s.reason) for s in outcome.skipped} == {
        (site.voice.id, "BELOW_THRESHOLD")
    }


def test_threshold_is_configurable_and_request_cannot_lower_it(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": [voice_item(site, relevance_score=85)]})
    outcome = _analyze(site, provider, config=default_config(min_relevance_score=90))
    assert outcome.suggestions == []
    assert outcome.min_relevance_score == 90

    provider = FakeAIProvider({"suggestions": [voice_item(site, relevance_score=85)]})
    outcome = _analyze(
        site, provider, config=default_config(min_relevance_score=90), min_relevance_score=10
    )
    assert outcome.min_relevance_score == 90
    assert outcome.suggestions == []


def test_duplicate_active_suggestions_are_prevented(site: Site) -> None:
    for status in (SuggestionStatus.PENDING, SuggestionStatus.APPROVED, SuggestionStatus.APPLIED):
        site.repo.suggestions.clear()
        site.repo.put_suggestion(
            source_page_id=site.source.id, target_page_id=site.voice.id, status=status
        )
        provider = FakeAIProvider({"suggestions": [voice_item(site)]})
        outcome = _analyze(site, provider)
        assert outcome.suggestions == []
        assert str(site.voice.id) not in _prompt_ids(provider)
        assert outcome.excluded_counts["ACTIVE_SUGGESTION_EXISTS"] == 1
        assert len(site.repo.suggestions) == 1


def test_running_analysis_twice_does_not_duplicate(site: Site) -> None:
    _analyze(site, FakeAIProvider({"suggestions": [voice_item(site)]}))
    second = _analyze(site, FakeAIProvider({"suggestions": [voice_item(site)]}))
    assert second.suggestions == []
    assert len(site.repo.suggestions) == 1


def test_concurrent_duplicate_insert_is_reported_as_skip(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": [voice_item(site)]})
    service = build_service(site.repo, provider)
    original = site.repo.add_suggestion
    site.repo.add_suggestion = lambda s: False  # type: ignore[method-assign]
    try:
        outcome = service.analyze(AnalyzeRequest(source_page_id=site.source.id))
    finally:
        site.repo.add_suggestion = original  # type: ignore[method-assign]
    assert outcome.suggestions == []
    assert outcome.skipped[0].reason == "ACTIVE_SUGGESTION_EXISTS"


def test_rejected_suggestion_regenerates_only_after_cooldown(site: Site) -> None:
    rejected = site.repo.put_suggestion(
        source_page_id=site.source.id,
        target_page_id=site.voice.id,
        status=SuggestionStatus.REJECTED,
    )
    outcome = _analyze(site, FakeAIProvider({"suggestions": [voice_item(site)]}))
    assert outcome.suggestions == []
    assert outcome.excluded_counts["RECENTLY_REJECTED"] == 1

    rejected.updated_at = datetime.now(UTC) - timedelta(days=31)
    outcome = _analyze(site, FakeAIProvider({"suggestions": [voice_item(site)]}))
    assert [s.target_page_id for s in outcome.suggestions] == [site.voice.id]


def test_ai_suggestions_are_validated_against_source_content(site: Site) -> None:
    provider = FakeAIProvider(
        {
            "suggestions": [
                # Paraphrased context that does not exist in the page.
                voice_item(site, suggested_context="Voice agents are great for support."),
                # Non-descriptive and generic anchors.
                crm_item(site, anchor_text="while a"),
                ai_item(
                    site.dental,
                    anchor_text="click here",
                    suggested_context="Accurate dental insurance verification reduces claim "
                    "denials for dental practices.",
                ),
            ]
        }
    )
    outcome = _analyze(site, provider)
    assert outcome.suggestions == []
    reasons = {s.target_page_id: s.reason for s in outcome.skipped}
    assert reasons[site.voice.id] == "CONTEXT_NOT_IN_SOURCE"
    assert reasons[site.crm.id] == "ANCHOR_NOT_DESCRIPTIVE"
    assert reasons[site.dental.id] == "ANCHOR_GENERIC"


def test_context_only_in_navigation_is_rejected(site: Site) -> None:
    provider = FakeAIProvider(
        {"suggestions": [voice_item(site, suggested_context="Home AI voice agents")]}
    )
    outcome = _analyze(site, provider)
    assert outcome.suggestions == []
    assert outcome.skipped[0].reason == "CONTEXT_NOT_IN_SOURCE"


def test_anchor_inside_existing_link_is_rejected(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": [crm_item(site, anchor_text="chatbot platform")]})
    outcome = _analyze(site, provider)
    assert outcome.suggestions == []
    assert outcome.skipped[0].reason == "ANCHOR_IN_UNSAFE_ELEMENT"


def test_same_anchor_or_context_is_not_reused_within_a_batch(site: Site) -> None:
    same_context = voice_item(site)["suggested_context"]
    provider = FakeAIProvider(
        {
            "suggestions": [
                voice_item(site),
                ai_item(site.crm, anchor_text="customer support", suggested_context=same_context),
            ]
        }
    )
    outcome = _analyze(site, provider)
    assert [s.target_page_id for s in outcome.suggestions] == [site.voice.id]
    assert outcome.skipped[0].reason == "CONTEXT_ALREADY_USED"


def test_overused_anchor_for_target_is_rejected(site: Site) -> None:
    for i in range(3):
        other = site.repo.add_page(make_page(f"/other-{i}/", title="x"))
        site.repo.put_suggestion(
            source_page_id=other.id, target_page_id=site.voice.id, anchor_text="AI voice agents"
        )
    provider = FakeAIProvider({"suggestions": [voice_item(site)]})
    outcome = _analyze(site, provider)
    assert outcome.suggestions == []
    assert outcome.skipped[0].reason == "ANCHOR_OVERUSED"
    prompt = json.loads(provider.calls[0]["prompt"])
    voice = next(c for c in prompt["CANDIDATES"] if c["id"] == str(site.voice.id))
    assert voice["avoid_anchors"] == ["AI voice agents"] * 3


def test_max_suggestions_and_dry_run(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": [voice_item(site), crm_item(site)]})
    outcome = _analyze(site, provider, max_suggestions=1, dry_run=True)
    assert [s.target_page_id for s in outcome.suggestions] == [site.voice.id]
    assert outcome.skipped[0].reason == "MAX_SUGGESTIONS_REACHED"
    assert site.repo.suggestions == {}
    assert site.repo.commits == 0


def test_invented_targets_are_never_stored(site: Site) -> None:
    provider = FakeAIProvider(
        {"suggestions": [voice_item(site, target_page_id=str(site.unrelated.id))]}
    )
    outcome = _analyze(site, provider)
    assert outcome.suggestions == []
    assert site.repo.suggestions == {}


def test_no_candidates_skips_the_ai_call(site: Site) -> None:
    site.repo.pages = {site.source.id: site.source}
    outcome = _analyze(site, None)  # type: ignore[arg-type]
    assert outcome.candidates_retrieved == 0
    assert outcome.suggestions == []


def test_error_cases(site: Site) -> None:
    import uuid

    service = build_service(site.repo, FakeAIProvider({"suggestions": []}))
    with pytest.raises(NotFoundError):
        service.analyze(AnalyzeRequest(source_page_id=uuid.uuid4()))

    site.source.http_status = 404
    with pytest.raises(UnprocessableError) as exc:
        service.analyze(AnalyzeRequest(source_page_id=site.source.id))
    assert exc.value.code == "SOURCE_NOT_ANALYZABLE"

    site.source.http_status = 200
    site.source.content_html = "<nav>only navigation</nav>"
    with pytest.raises(UnprocessableError) as exc:
        service.analyze(AnalyzeRequest(source_page_id=site.source.id))
    assert exc.value.code == "NO_LINKABLE_CONTENT"


def test_ai_provider_failure_propagates_without_storing(site: Site) -> None:
    provider = FakeAIProvider(AIProviderError("boom"))
    with pytest.raises(AIProviderError):
        _analyze(site, provider)
    assert site.repo.suggestions == {}
    assert site.repo.commits == 0


def test_empty_pages_are_never_sent_to_the_ai(site: Site) -> None:
    empty = site.repo.add_page(
        make_page("/ai-readiness-assessment/", title=None, h1=None, content_html="")
    )
    html_redirect = site.repo.add_page(
        make_page(
            "/old-assessment/",
            title=None,
            redirect_url="https://www.example.com/us/ai-readiness-assessment/",
            is_indexable=False,
        )
    )
    provider = FakeAIProvider({"suggestions": [ai_item(empty, anchor_text="AI voice agents")]})
    outcome = _analyze(site, provider)
    ids = _prompt_ids(provider)
    assert str(empty.id) not in ids and str(html_redirect.id) not in ids
    assert outcome.excluded_counts["EMPTY_CONTENT"] == 1
    assert all(s.target_page_id != empty.id for s in outcome.suggestions)
