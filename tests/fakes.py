"""Test doubles: page factory, in-memory repository/content store, and a fake AI provider.

No real AI calls and no database are used by unit/API tests.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

from app.ai.base import AIProvider
from app.content.store import internal_links_for
from app.core.exceptions import ConflictError
from app.interlink.candidate_retriever import LexicalCandidateRetriever
from app.interlink.models import ACTIVE_STATUSES, InternalLinkSuggestion, SuggestionStatus
from app.interlink.relevance_analyzer import RelevanceAnalyzer
from app.interlink.repository import SuggestionFilters
from app.interlink.service import InterlinkConfig, InterlinkService
from app.pages.models import Page

SITE_ID = uuid.UUID("00000000-0000-0000-0000-00000000517e")
BASE = "https://www.example.com"


def make_page(path: str, *, site_id: uuid.UUID = SITE_ID, **overrides: Any) -> Page:
    url = f"{BASE}{path}"
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "site_id": site_id,
        "url": url,
        "title": None,
        "h1": None,
        "meta_description": None,
        "content_html": None,
        "content_version": 1,
        "canonical_url": None,
        "http_status": 200,
        "redirect_url": None,
        "is_indexable": True,
        "has_noindex": False,
        "language": "en",
        "region": None,
        "page_type": None,
        "keywords": [],
        "outgoing_links": None,
        "last_crawled_at": None,
    }
    values.update(overrides)
    if values["outgoing_links"] is None:
        values["outgoing_links"] = (
            internal_links_for(url, values["content_html"]) if values["content_html"] else []
        )
    return Page(**values)


class FakeAIProvider(AIProvider):
    name = "fake"

    def __init__(
        self, response: dict[str, Any] | Callable[[str], dict[str, Any]] | Exception
    ) -> None:
        super().__init__("fake-model-1")
        self._response = response
        self.calls: list[dict[str, str]] = []

    def generate_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        self.calls.append({"system": system, "prompt": prompt})
        if isinstance(self._response, Exception):
            raise self._response
        if callable(self._response):
            return self._response(prompt)
        return self._response


class FakeInterlinkRepository:
    def __init__(self, pages: Sequence[Page] = ()) -> None:
        self.pages: dict[uuid.UUID, Page] = {p.id: p for p in pages}
        self.suggestions: dict[uuid.UUID, InternalLinkSuggestion] = {}
        self.commits = 0
        self.rollbacks = 0

    # pages
    def add_page(self, page: Page) -> Page:
        self.pages[page.id] = page
        return page

    def get_page(self, page_id: uuid.UUID, *, for_update: bool = False) -> Page | None:
        return self.pages.get(page_id)

    def list_candidate_pool(self, source: Page) -> list[Page]:
        return [p for p in self.pages.values() if p.site_id == source.site_id and p.id != source.id]

    def load_contents(self, page_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]:
        return {
            pid: self.pages[pid].content_html
            for pid in page_ids
            if pid in self.pages and self.pages[pid].content_html
        }

    # suggestions
    def put_suggestion(self, **values: Any) -> InternalLinkSuggestion:
        now = datetime.now(UTC)
        defaults: dict[str, Any] = {
            "id": uuid.uuid4(),
            "site_id": SITE_ID,
            "anchor_text": "anchor",
            "context": "context",
            "relevance_score": 80,
            "reason": "reason",
            "status": SuggestionStatus.PENDING,
            "retrieval_score": 0.5,
            "ai_provider": "fake",
            "ai_model": "fake-model-1",
            "rejection_reason": None,
            "reviewed_at": None,
            "applied_at": None,
            "created_at": now,
            "updated_at": now,
        }
        defaults.update(values)
        suggestion = InternalLinkSuggestion(**defaults)
        self._link(suggestion)
        self.suggestions[suggestion.id] = suggestion
        return suggestion

    def _link(self, s: InternalLinkSuggestion) -> None:
        s.source_page = self.pages[s.source_page_id]
        s.target_page = self.pages[s.target_page_id]

    def get_suggestion(
        self, suggestion_id: uuid.UUID, *, for_update: bool = False
    ) -> InternalLinkSuggestion | None:
        return self.suggestions.get(suggestion_id)

    def list_suggestions(
        self, filters: SuggestionFilters, *, offset: int, limit: int
    ) -> tuple[list[InternalLinkSuggestion], int]:
        items = [
            s
            for s in self.suggestions.values()
            if (filters.status is None or s.status == filters.status)
            and (filters.site_id is None or s.site_id == filters.site_id)
            and (filters.source_page_id is None or s.source_page_id == filters.source_page_id)
            and (filters.target_page_id is None or s.target_page_id == filters.target_page_id)
            and (
                filters.min_relevance_score is None
                or s.relevance_score >= filters.min_relevance_score
            )
        ]
        items.sort(key=lambda s: (s.created_at, s.relevance_score), reverse=True)
        return items[offset : offset + limit], len(items)

    def active_target_ids(self, source_page_id: uuid.UUID) -> set[uuid.UUID]:
        return {
            s.target_page_id
            for s in self.suggestions.values()
            if s.source_page_id == source_page_id and s.status in ACTIVE_STATUSES
        }

    def rejected_target_ids_since(
        self, source_page_id: uuid.UUID, since: datetime
    ) -> set[uuid.UUID]:
        return {
            s.target_page_id
            for s in self.suggestions.values()
            if s.source_page_id == source_page_id
            and s.status == SuggestionStatus.REJECTED
            and s.updated_at >= since
        }

    def anchors_by_target(self, target_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
        result: dict[uuid.UUID, list[str]] = {}
        for s in self.suggestions.values():
            if s.target_page_id in target_ids and s.status in ACTIVE_STATUSES:
                result.setdefault(s.target_page_id, []).append(s.anchor_text)
        return result

    def _active_pair_exists(self, s: InternalLinkSuggestion) -> bool:
        return any(
            o.id != s.id
            and o.source_page_id == s.source_page_id
            and o.target_page_id == s.target_page_id
            and o.status in ACTIVE_STATUSES
            for o in self.suggestions.values()
        )

    def add_suggestion(self, suggestion: InternalLinkSuggestion) -> bool:
        if self._active_pair_exists(suggestion):
            return False
        now = datetime.now(UTC)
        suggestion.created_at = now
        suggestion.updated_at = now
        self._link(suggestion)
        self.suggestions[suggestion.id] = suggestion
        return True

    def commit(self) -> None:
        # Emulate the partial unique index being checked at commit.
        for s in self.suggestions.values():
            if s.status in ACTIVE_STATUSES and self._active_pair_exists(s):
                raise ConflictError("duplicate active pair", code="ACTIVE_SUGGESTION_EXISTS")
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeContentStore:
    def __init__(self) -> None:
        self.saved: list[tuple[uuid.UUID, str]] = []

    def load_content(self, page: Page) -> str | None:
        return page.content_html

    def save_content(self, page: Page, new_content: str, *, expected_version: int) -> None:
        if page.content_version != expected_version:
            raise ConflictError("version conflict", code="CONTENT_VERSION_CONFLICT")
        page.content_html = new_content
        page.content_version = expected_version + 1
        page.outgoing_links = internal_links_for(page.url, new_content)
        self.saved.append((page.id, new_content))


def build_service(
    repo: FakeInterlinkRepository,
    provider: AIProvider | None = None,
    *,
    config: InterlinkConfig | None = None,
    store: FakeContentStore | None = None,
) -> InterlinkService:
    def factory() -> RelevanceAnalyzer:
        if provider is None:
            raise AssertionError("AI provider must not be called in this test")
        return RelevanceAnalyzer(provider, source_content_max_chars=6000, target_excerpt_chars=300)

    return InterlinkService(
        repo,
        config=config or default_config(),
        retriever=LexicalCandidateRetriever(),
        analyzer_factory=factory,
        content_store=store or FakeContentStore(),
    )


def default_config(**overrides: Any) -> InterlinkConfig:
    from app.core.config import Settings

    base = InterlinkConfig.from_settings(Settings(_env_file=None))  # type: ignore[call-arg]
    values = {**base.__dict__, **overrides}
    return InterlinkConfig(**values)
