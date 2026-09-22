"""AI relevance analysis: asks the configured LLM to judge backend-selected candidates.

The model only ever sees candidates chosen by the backend, referenced by ID. Any judgement
for an unknown ID or with a mismatching URL is discarded, so the AI cannot invent targets.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from pydantic import ValidationError

from app.ai.base import AIProvider, AIProviderError
from app.core.urls import normalize_url, site_relative, url_key
from app.interlink.candidate_retriever import ScoredCandidate
from app.interlink.schemas import AIRelevanceItem

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an SEO editor who proposes contextual internal links between pages of one website.

Rules:
- Only choose targets from CANDIDATES, identified by their exact "id". Never invent or modify URLs.
- A target is relevant only if a reader of the SOURCE sentence would genuinely benefit from the
  target page. Topical keyword overlap alone is not enough.
- "suggested_context" MUST be one sentence copied VERBATIM from SOURCE.content (same words,
  same order). Do not paraphrase, shorten, or join sentences.
- "anchor_text" MUST be an exact, contiguous substring of "suggested_context" (2-6 words
  preferred) that naturally describes the target page.
- Never use generic anchors ("click here", "read more", "learn more", "here", "this page",
  "this article", "website", "link").
- Do not keyword-stuff; do not reuse an anchor listed in the candidate's "avoid_anchors".
- Use a different sentence for each target. Suggest at most one link per target.
- "reason" must be factual and based only on the provided page information; make no claims
  that are not supported by it.
- relevance_score: 0-100 (90+ = the target is a primary resource for the sentence's topic,
  70-89 = clearly useful, below 70 = weak).

Respond with a JSON object only:
{"suggestions": [{"target_page_id": "<candidate id>", "target_url": "<candidate url>",
"is_relevant": true, "relevance_score": 0, "reason": "...", "anchor_text": "...",
"suggested_context": "..."}]}
Omit candidates that are not relevant. Return {"suggestions": []} if none are relevant.
"""


@dataclass(frozen=True)
class AnalysisResult:
    items: list[AIRelevanceItem]
    discarded: dict[str, str]  # target_page_id -> reason


def _truncate(value: str | None, limit: int) -> str | None:
    if value is None or len(value) <= limit:
        return value
    cut = value[:limit].rsplit(" ", 1)[0]
    return f"{cut}…"


class RelevanceAnalyzer:
    def __init__(
        self,
        provider: AIProvider,
        *,
        source_content_max_chars: int,
        target_excerpt_chars: int,
    ) -> None:
        self._provider = provider
        self._source_max = source_content_max_chars
        self._excerpt = target_excerpt_chars

    @property
    def provider_name(self) -> str:
        return self._provider.name

    @property
    def model_name(self) -> str:
        return self._provider.model

    def build_prompt(
        self,
        *,
        source_url: str,
        source_title: str | None,
        source_h1: str | None,
        source_keywords: Sequence[str],
        source_content: str,
        candidates: Sequence[ScoredCandidate],
        candidate_excerpts: Mapping[str, str],
        avoid_anchors: Mapping[str, Sequence[str]],
    ) -> str:
        payload = {
            "SOURCE": {
                "url": site_relative(source_url),
                "title": source_title,
                "h1": source_h1,
                "keywords": list(source_keywords)[:20],
                "content": _truncate(source_content, self._source_max),
            },
            "CANDIDATES": [
                {
                    "id": str(c.page.id),
                    "url": site_relative(c.page.url),
                    "title": c.page.title,
                    "h1": c.page.h1,
                    "description": _truncate(c.page.meta_description, 300),
                    "keywords": list(c.page.keywords or [])[:10],
                    "page_type": c.page.page_type,
                    "excerpt": _truncate(candidate_excerpts.get(str(c.page.id)), self._excerpt),
                    "avoid_anchors": list(avoid_anchors.get(str(c.page.id), []))[:10],
                }
                for c in candidates
            ],
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    def analyze(self, prompt: str, candidates: Sequence[ScoredCandidate]) -> AnalysisResult:
        raw = self._provider.generate_json(system=SYSTEM_PROMPT, prompt=prompt)
        return parse_ai_response(raw, candidates)


def parse_ai_response(raw: object, candidates: Sequence[ScoredCandidate]) -> AnalysisResult:
    """Validate the model output item-by-item against the candidate set."""
    if not isinstance(raw, dict) or not isinstance(raw.get("suggestions"), list):
        raise AIProviderError(
            "AI response did not contain a 'suggestions' list", code="AI_INVALID_RESPONSE"
        )
    by_id = {str(c.page.id): c for c in candidates}
    items: dict[str, AIRelevanceItem] = {}
    discarded: dict[str, str] = {}
    for index, entry in enumerate(raw["suggestions"]):
        try:
            item = AIRelevanceItem.model_validate(entry)
        except ValidationError as exc:
            key = str(entry.get("target_page_id")) if isinstance(entry, dict) else f"#{index}"
            discarded[key] = "INVALID_AI_ITEM"
            logger.warning("Discarding invalid AI item %s: %s", key, exc.errors()[:3])
            continue
        candidate = by_id.get(item.target_page_id)
        if candidate is None:
            discarded[item.target_page_id] = "UNKNOWN_TARGET"
            logger.warning("AI returned unknown target id %s; discarded", item.target_page_id)
            continue
        if item.target_url and url_key(_absolutise(item.target_url, candidate.page.url)) != url_key(
            candidate.page.url
        ):
            discarded[item.target_page_id] = "TARGET_URL_MISMATCH"
            logger.warning("AI changed URL for target %s; discarded", item.target_page_id)
            continue
        if not item.is_relevant:
            discarded[item.target_page_id] = "NOT_RELEVANT"
            continue
        previous = items.get(item.target_page_id)
        if previous is None or item.relevance_score > previous.relevance_score:
            items[item.target_page_id] = item
    return AnalysisResult(items=list(items.values()), discarded=discarded)


def _absolutise(url: str, reference: str) -> str:
    return normalize_url(url, reference) or url
