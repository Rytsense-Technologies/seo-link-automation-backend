"""AI structured-response validation (the AI can only pick backend-provided candidates)."""

from __future__ import annotations

import json

import pytest

from app.ai.base import AIProviderError, parse_json_object
from app.interlink.candidate_retriever import ScoredCandidate
from app.interlink.relevance_analyzer import RelevanceAnalyzer, parse_ai_response
from tests.conftest import Site, ai_item, voice_item
from tests.fakes import FakeAIProvider


def _cands(site: Site) -> list[ScoredCandidate]:
    return [ScoredCandidate(site.voice, 0.8), ScoredCandidate(site.crm, 0.5)]


def test_valid_response_is_parsed(site: Site) -> None:
    result = parse_ai_response({"suggestions": [voice_item(site)]}, _cands(site))
    assert len(result.items) == 1
    item = result.items[0]
    assert item.target_page_id == str(site.voice.id)
    assert item.relevance_score == 94
    assert item.anchor_text == "AI voice agents"


def test_unknown_target_ids_are_discarded(site: Site) -> None:
    invented = ai_item(site.voice, target_page_id="11111111-1111-1111-1111-111111111111")
    result = parse_ai_response({"suggestions": [invented]}, _cands(site))
    assert result.items == []
    assert result.discarded == {"11111111-1111-1111-1111-111111111111": "UNKNOWN_TARGET"}


def test_modified_target_url_is_discarded(site: Site) -> None:
    item = voice_item(site, target_url="/some-invented-url/")
    result = parse_ai_response({"suggestions": [item]}, _cands(site))
    assert result.items == []
    assert result.discarded[str(site.voice.id)] == "TARGET_URL_MISMATCH"


@pytest.mark.parametrize(
    "bad",
    [
        {"relevance_score": 150},
        {"relevance_score": -1},
        {"relevance_score": "high"},
        {"anchor_text": ""},
        {"suggested_context": None},
        {"reason": ""},
    ],
)
def test_invalid_items_are_discarded_individually(site: Site, bad: dict[str, object]) -> None:
    good = voice_item(site)
    broken = {**ai_item(site.crm), **bad}
    result = parse_ai_response({"suggestions": [good, broken]}, _cands(site))
    assert [i.target_page_id for i in result.items] == [str(site.voice.id)]
    assert result.discarded[str(site.crm.id)] == "INVALID_AI_ITEM"


def test_not_relevant_items_are_dropped(site: Site) -> None:
    result = parse_ai_response({"suggestions": [voice_item(site, is_relevant=False)]}, _cands(site))
    assert result.items == []
    assert result.discarded[str(site.voice.id)] == "NOT_RELEVANT"


@pytest.mark.parametrize("raw", [[], {"items": []}, {"suggestions": "none"}, None])
def test_malformed_top_level_raises(site: Site, raw: object) -> None:
    with pytest.raises(AIProviderError) as exc:
        parse_ai_response(raw, _cands(site))
    assert exc.value.code == "AI_INVALID_RESPONSE"


def test_parse_json_object_handles_fences_and_errors() -> None:
    assert parse_json_object('```json\n{"suggestions": []}\n```') == {"suggestions": []}
    with pytest.raises(AIProviderError):
        parse_json_object("not json")
    with pytest.raises(AIProviderError):
        parse_json_object("[1, 2]")


def test_prompt_is_compact_and_only_contains_candidates(site: Site) -> None:
    provider = FakeAIProvider({"suggestions": []})
    analyzer = RelevanceAnalyzer(provider, source_content_max_chars=500, target_excerpt_chars=50)
    prompt = analyzer.build_prompt(
        source_url=site.source.url,
        source_title=site.source.title,
        source_h1=site.source.h1,
        source_keywords=site.source.keywords,
        source_content="x " * 2000,
        candidates=_cands(site),
        candidate_excerpts={str(site.voice.id): "y " * 500},
        avoid_anchors={str(site.voice.id): ["voice agents"]},
    )
    payload = json.loads(prompt)
    assert len(payload["SOURCE"]["content"]) <= 502
    assert [c["id"] for c in payload["CANDIDATES"]] == [str(site.voice.id), str(site.crm.id)]
    assert payload["CANDIDATES"][0]["url"] == "/ai-voice-agent/"
    assert payload["CANDIDATES"][0]["avoid_anchors"] == ["voice agents"]
    assert len(payload["CANDIDATES"][0]["excerpt"]) <= 52
    assert site.unrelated.url not in prompt
