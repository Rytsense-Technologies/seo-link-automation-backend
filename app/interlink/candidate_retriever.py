"""Candidate retrieval: narrow the site's eligible pages to a small pool for AI scoring.

`CandidateRetriever` is the extension point: a pgvector/embedding retriever (or a hybrid
that blends embeddings with GSC traffic weighting) can implement the same protocol and be
wired in `app.interlink.dependencies` without touching the service.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from app.core.urls import url_path
from app.interlink.text_features import cosine, idf, tfidf, weighted_terms
from app.pages.models import Page

# Field weights: what a page is *about* is mostly in its title/H1/keywords/slug.
SOURCE_WEIGHTS = {"title": 3.0, "h1": 3.0, "keywords": 3.0, "meta": 1.5, "content": 1.0}
TARGET_WEIGHTS = {"title": 3.0, "h1": 3.0, "keywords": 2.5, "slug": 2.0, "meta": 1.5}


@dataclass(frozen=True)
class ScoredCandidate:
    page: Page
    score: float  # 0..1


class CandidateRetriever(Protocol):
    def retrieve(
        self, source: Page, source_text: str, eligible: Sequence[Page], limit: int
    ) -> list[ScoredCandidate]: ...


def _slug_text(page: Page) -> str:
    return url_path(page.url).replace("/", " ").replace("-", " ").replace("_", " ")


class LexicalCandidateRetriever:
    """TF-IDF cosine similarity over title, H1, keywords, slug and meta description."""

    def __init__(self, min_score: float = 0.01) -> None:
        self._min_score = min_score

    def retrieve(
        self, source: Page, source_text: str, eligible: Sequence[Page], limit: int
    ) -> list[ScoredCandidate]:
        if not eligible:
            return []
        source_counts = weighted_terms(
            [
                (source.title, SOURCE_WEIGHTS["title"]),
                (source.h1, SOURCE_WEIGHTS["h1"]),
                (" ; ".join(source.keywords or []), SOURCE_WEIGHTS["keywords"]),
                (source.meta_description, SOURCE_WEIGHTS["meta"]),
                (source_text, SOURCE_WEIGHTS["content"]),
            ]
        )
        target_counts = [
            weighted_terms(
                [
                    (page.title, TARGET_WEIGHTS["title"]),
                    (page.h1, TARGET_WEIGHTS["h1"]),
                    (" ; ".join(page.keywords or []), TARGET_WEIGHTS["keywords"]),
                    (_slug_text(page), TARGET_WEIGHTS["slug"]),
                    (page.meta_description, TARGET_WEIGHTS["meta"]),
                ]
            )
            for page in eligible
        ]
        idf_values = idf([*target_counts, source_counts])
        default_idf = max(idf_values.values(), default=1.0)
        source_vec = tfidf(source_counts, idf_values, default_idf)

        scored = []
        for page, counts in zip(eligible, target_counts, strict=True):
            score = cosine(source_vec, tfidf(counts, idf_values, default_idf))
            if score >= self._min_score:
                scored.append(ScoredCandidate(page=page, score=round(score, 4)))
        scored.sort(key=lambda c: (-c.score, c.page.url))
        return scored[:limit]
