"""Interlink orchestration: analyze -> filter -> retrieve -> AI score -> validate -> store,
plus the review (approve/reject) and safe-apply workflow.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import ClassVar

from app.content.html import extract_blocks, extract_text
from app.content.store import ContentStore, internal_links_for
from app.core.config import Settings
from app.core.exceptions import ConflictError, NotFoundError, UnprocessableError
from app.core.urls import site_relative
from app.interlink.anchor_rules import anchor_problem, contains_phrase, normalize_for_match
from app.interlink.candidate_filter import (
    ExclusionReason,
    FilterConfig,
    filter_candidates,
    linked_url_keys,
    target_exclusion_reason,
)
from app.interlink.candidate_retriever import CandidateRetriever, ScoredCandidate
from app.interlink.link_applier import LinkApplicationError, apply_link
from app.interlink.models import InternalLinkSuggestion, SuggestionStatus
from app.interlink.relevance_analyzer import RelevanceAnalyzer
from app.interlink.repository import InterlinkRepository, SuggestionFilters
from app.interlink.schemas import AIRelevanceItem, AnalyzeRequest, SkippedCandidate
from app.pages.models import Page

logger = logging.getLogger(__name__)


class SkipReason:
    ACTIVE_SUGGESTION_EXISTS = "ACTIVE_SUGGESTION_EXISTS"
    RECENTLY_REJECTED = "RECENTLY_REJECTED"
    BELOW_THRESHOLD = "BELOW_THRESHOLD"
    CONTEXT_NOT_IN_SOURCE = "CONTEXT_NOT_IN_SOURCE"
    CONTEXT_ALREADY_USED = "CONTEXT_ALREADY_USED"
    DUPLICATE_ANCHOR = "DUPLICATE_ANCHOR"
    ANCHOR_OVERUSED = "ANCHOR_OVERUSED"
    MAX_SUGGESTIONS_REACHED = "MAX_SUGGESTIONS_REACHED"


@dataclass(frozen=True)
class InterlinkConfig:
    min_relevance_score: int = 70
    candidate_pool_size: int = 15
    max_suggestions_per_page: int = 5
    rejection_cooldown_days: int = 30
    max_anchor_reuse: int = 3
    target_excerpt_chars: int = 300
    filters: FilterConfig = field(default_factory=FilterConfig)

    @classmethod
    def from_settings(cls, s: Settings) -> InterlinkConfig:
        return cls(
            min_relevance_score=s.interlink_min_relevance_score,
            candidate_pool_size=s.interlink_candidate_pool_size,
            max_suggestions_per_page=s.interlink_max_suggestions_per_page,
            rejection_cooldown_days=s.interlink_rejection_cooldown_days,
            max_anchor_reuse=s.interlink_max_anchor_reuse,
            target_excerpt_chars=s.interlink_target_excerpt_chars,
            filters=FilterConfig.from_values(
                s.interlink_utility_page_types,
                s.interlink_utility_path_patterns,
                s.interlink_require_region_match,
            ),
        )


@dataclass
class AnalysisOutcome:
    source_page_id: uuid.UUID
    min_relevance_score: int
    candidates_retrieved: int
    candidates_after_filtering: int
    excluded_counts: dict[str, int]
    dry_run: bool
    suggestions: list[InternalLinkSuggestion]
    skipped: list[SkippedCandidate]


def _now() -> datetime:
    return datetime.now(UTC)


class InterlinkService:
    def __init__(
        self,
        repository: InterlinkRepository,
        *,
        config: InterlinkConfig,
        retriever: CandidateRetriever,
        analyzer_factory: Callable[[], RelevanceAnalyzer],
        content_store: ContentStore,
    ) -> None:
        self._repo = repository
        self._config = config
        self._retriever = retriever
        # Resolved lazily so review/apply endpoints work without an AI provider configured.
        self._analyzer_factory = analyzer_factory
        self._content_store = content_store

    # ------------------------------------------------------------------ analyze
    def analyze(self, request: AnalyzeRequest) -> AnalysisOutcome:
        cfg = self._config
        source = self._repo.get_page(request.source_page_id)
        if source is None:
            raise NotFoundError("Source page not found", code="PAGE_NOT_FOUND")
        content = self._content_store.load_content(source)
        if source.http_status is not None and not 200 <= source.http_status < 300:
            raise UnprocessableError(
                "Source page is not a live (2xx) page",
                code="SOURCE_NOT_ANALYZABLE",
                details={"http_status": source.http_status},
            )
        if not content:
            raise UnprocessableError("Source page has no content", code="SOURCE_CONTENT_EMPTY")
        link_contexts = extract_blocks(content, link_contexts_only=True)
        if not link_contexts:
            raise UnprocessableError(
                "Source page has no body copy that can host links", code="NO_LINKABLE_CONTENT"
            )

        min_score = max(cfg.min_relevance_score, request.min_relevance_score or 0)
        max_suggestions = request.max_suggestions or cfg.max_suggestions_per_page
        linked_keys = linked_url_keys(
            [*source.outgoing_links, *internal_links_for(source.url, content)]
        )

        # 1. Hard filters (deterministic, before any AI).
        filtered = filter_candidates(
            source, self._repo.list_candidate_pool(source), cfg.filters, linked_keys
        )
        excluded_counts = {reason: len(pages) for reason, pages in filtered.excluded.items()}

        # 2. Duplicate prevention: skip pairs with an active or recently rejected suggestion.
        active = self._repo.active_target_ids(source.id)
        cooldown_start = _now() - timedelta(days=cfg.rejection_cooldown_days)
        recently_rejected = (
            self._repo.rejected_target_ids_since(source.id, cooldown_start)
            if cfg.rejection_cooldown_days > 0
            else set()
        )
        eligible: list[Page] = []
        for page in filtered.accepted:
            if page.id in active:
                excluded_counts[SkipReason.ACTIVE_SUGGESTION_EXISTS] = (
                    excluded_counts.get(SkipReason.ACTIVE_SUGGESTION_EXISTS, 0) + 1
                )
            elif page.id in recently_rejected:
                excluded_counts[SkipReason.RECENTLY_REJECTED] = (
                    excluded_counts.get(SkipReason.RECENTLY_REJECTED, 0) + 1
                )
            else:
                eligible.append(page)

        # 3. Candidate retrieval.
        source_text = "\n".join(link_contexts)
        candidates = self._retriever.retrieve(
            source, source_text, eligible, cfg.candidate_pool_size
        )
        outcome = AnalysisOutcome(
            source_page_id=source.id,
            min_relevance_score=min_score,
            candidates_retrieved=len(candidates),
            candidates_after_filtering=len(eligible),
            excluded_counts=excluded_counts,
            dry_run=request.dry_run,
            suggestions=[],
            skipped=[],
        )
        if not candidates:
            logger.info("Interlink analysis for %s: no candidates", source.url)
            return outcome

        # 4. AI relevance analysis over the compact candidate pool only.
        analyzer = self._analyzer_factory()
        target_ids = [c.page.id for c in candidates]
        contents = self._repo.load_contents(target_ids)
        excerpts = {
            str(pid): extract_text(html)[: cfg.target_excerpt_chars]
            for pid, html in contents.items()
        }
        existing_anchors = self._repo.anchors_by_target(target_ids)
        prompt = analyzer.build_prompt(
            source_url=source.url,
            source_title=source.title,
            source_h1=source.h1,
            source_keywords=source.keywords or [],
            source_content=source_text,
            candidates=candidates,
            candidate_excerpts=excerpts,
            avoid_anchors={str(k): v for k, v in existing_anchors.items()},
        )
        analysis = analyzer.analyze(prompt, candidates)
        by_id = {str(c.page.id): c for c in candidates}
        for target_id, reason in analysis.discarded.items():
            cand = by_id.get(target_id)
            if cand is not None:
                outcome.skipped.append(_skipped(cand, reason))

        # 5. Validate, threshold, and store.
        used_contexts: set[str] = set()
        used_anchors: set[str] = set()
        for item in sorted(analysis.items, key=lambda i: -i.relevance_score):
            cand = by_id[item.target_page_id]
            problem = self._validate_item(
                item,
                cand,
                content=content,
                source_url=source.url,
                link_contexts=link_contexts,
                min_score=min_score,
                used_contexts=used_contexts,
                used_anchors=used_anchors,
                existing_anchors=existing_anchors.get(cand.page.id, []),
            )
            if problem is None and len(outcome.suggestions) >= max_suggestions:
                problem = SkipReason.MAX_SUGGESTIONS_REACHED
            if problem is not None:
                outcome.skipped.append(_skipped(cand, problem))
                continue
            suggestion = InternalLinkSuggestion(
                id=uuid.uuid4(),
                site_id=source.site_id,
                source_page_id=source.id,
                target_page_id=cand.page.id,
                anchor_text=item.anchor_text,
                context=item.suggested_context,
                relevance_score=item.relevance_score,
                reason=item.reason,
                status=SuggestionStatus.PENDING,
                retrieval_score=cand.score,
                ai_provider=analyzer.provider_name,
                ai_model=analyzer.model_name,
            )
            if not request.dry_run and not self._repo.add_suggestion(suggestion):
                outcome.skipped.append(_skipped(cand, SkipReason.ACTIVE_SUGGESTION_EXISTS))
                continue
            used_contexts.add(normalize_for_match(item.suggested_context))
            used_anchors.add(normalize_for_match(item.anchor_text))
            outcome.suggestions.append(suggestion)

        if not request.dry_run:
            self._repo.commit()
        logger.info(
            "Interlink analysis for %s: %d candidates, %d suggestions, %d skipped (dry_run=%s)",
            source.url,
            len(candidates),
            len(outcome.suggestions),
            len(outcome.skipped),
            request.dry_run,
        )
        return outcome

    def _validate_item(
        self,
        item: AIRelevanceItem,
        cand: ScoredCandidate,
        *,
        content: str,
        source_url: str,
        link_contexts: list[str],
        min_score: int,
        used_contexts: set[str],
        used_anchors: set[str],
        existing_anchors: list[str],
    ) -> str | None:
        if item.relevance_score < min_score:
            return SkipReason.BELOW_THRESHOLD
        if not any(contains_phrase(block, item.suggested_context) for block in link_contexts):
            return SkipReason.CONTEXT_NOT_IN_SOURCE
        problem = anchor_problem(item.anchor_text, item.suggested_context)
        if problem is not None:
            return problem
        anchor_key = normalize_for_match(item.anchor_text)
        if normalize_for_match(item.suggested_context) in used_contexts:
            return SkipReason.CONTEXT_ALREADY_USED
        if anchor_key in used_anchors:
            return SkipReason.DUPLICATE_ANCHOR
        reuse = Counter(normalize_for_match(a) for a in existing_anchors)[anchor_key]
        if reuse >= self._config.max_anchor_reuse:
            return SkipReason.ANCHOR_OVERUSED
        # Only store suggestions that can actually be applied to the current content.
        try:
            apply_link(
                content,
                page_url=source_url,
                target_url=cand.page.url,
                href=site_relative(cand.page.url),
                anchor_text=item.anchor_text,
                context=item.suggested_context,
            )
        except LinkApplicationError as exc:
            return exc.code
        return None

    # ------------------------------------------------------------------ queries
    def list_suggestions(
        self, filters: SuggestionFilters, *, page: int, page_size: int
    ) -> tuple[list[InternalLinkSuggestion], int]:
        return self._repo.list_suggestions(filters, offset=(page - 1) * page_size, limit=page_size)

    def get_suggestion(
        self, suggestion_id: uuid.UUID, *, for_update: bool = False
    ) -> InternalLinkSuggestion:
        suggestion = self._repo.get_suggestion(suggestion_id, for_update=for_update)
        if suggestion is None:
            raise NotFoundError("Suggestion not found", code="SUGGESTION_NOT_FOUND")
        return suggestion

    # ------------------------------------------------------------------ review
    def approve(self, suggestion_id: uuid.UUID) -> InternalLinkSuggestion:
        suggestion = self.get_suggestion(suggestion_id, for_update=True)
        self._transition(suggestion, SuggestionStatus.APPROVED)
        suggestion.rejection_reason = None
        suggestion.reviewed_at = _now()
        self._repo.commit()
        return suggestion

    def reject(self, suggestion_id: uuid.UUID, reason: str | None) -> InternalLinkSuggestion:
        suggestion = self.get_suggestion(suggestion_id, for_update=True)
        self._transition(suggestion, SuggestionStatus.REJECTED)
        suggestion.rejection_reason = reason
        suggestion.reviewed_at = _now()
        self._repo.commit()
        return suggestion

    _TRANSITIONS: ClassVar[dict[SuggestionStatus, frozenset[SuggestionStatus]]] = {
        SuggestionStatus.APPROVED: frozenset({SuggestionStatus.PENDING, SuggestionStatus.REJECTED}),
        SuggestionStatus.REJECTED: frozenset({SuggestionStatus.PENDING, SuggestionStatus.APPROVED}),
        SuggestionStatus.APPLIED: frozenset({SuggestionStatus.APPROVED}),
    }

    def _transition(self, suggestion: InternalLinkSuggestion, new: SuggestionStatus) -> None:
        if suggestion.status not in self._TRANSITIONS[new]:
            self._repo.rollback()
            raise ConflictError(
                f"Cannot change suggestion from {suggestion.status} to {new}",
                code="INVALID_STATUS_TRANSITION",
                details={"current_status": suggestion.status, "requested_status": new},
            )
        suggestion.status = new

    # ------------------------------------------------------------------ apply
    def apply(self, suggestion_id: uuid.UUID) -> InternalLinkSuggestion:
        suggestion = self.get_suggestion(suggestion_id, for_update=True)
        try:
            if suggestion.status != SuggestionStatus.APPROVED:
                raise ConflictError(
                    "Only APPROVED suggestions can be applied",
                    code="SUGGESTION_NOT_APPROVED",
                    details={"current_status": suggestion.status},
                )
            source = self._repo.get_page(suggestion.source_page_id, for_update=True)
            if source is None:
                raise ConflictError("Source page no longer exists", code="SOURCE_PAGE_MISSING")
            target = self._repo.get_page(suggestion.target_page_id)
            if target is None:
                raise ConflictError("Target page no longer exists", code="TARGET_PAGE_MISSING")
            content = self._content_store.load_content(source)
            if not content:
                raise LinkApplicationError(
                    "Source page has no content", code="SOURCE_CONTENT_EMPTY"
                )
            linked = linked_url_keys(internal_links_for(source.url, content))
            reason = target_exclusion_reason(source, target, self._config.filters, linked)
            if reason == ExclusionReason.ALREADY_LINKED:
                raise ConflictError(
                    "Source page already links to the target", code="ALREADY_LINKED"
                )
            if reason is not None:
                raise ConflictError(
                    "Target page is no longer a valid link target",
                    code="TARGET_NOT_LINKABLE",
                    details={"reason": reason},
                )
            applied = apply_link(
                content,
                page_url=source.url,
                target_url=target.url,
                href=site_relative(target.url),
                anchor_text=suggestion.anchor_text,
                context=suggestion.context,
            )
            self._content_store.save_content(
                source, applied.content, expected_version=source.content_version
            )
            suggestion.status = SuggestionStatus.APPLIED
            suggestion.applied_at = _now()
            self._repo.commit()
        except Exception:
            self._repo.rollback()
            raise
        logger.info(
            "Applied internal link %s: %s -> %s (%r)",
            suggestion.id,
            source.url,
            target.url,
            applied.anchor_text,
        )
        return suggestion


def _skipped(candidate: ScoredCandidate, reason: str) -> SkippedCandidate:
    return SkippedCandidate(
        target_page_id=candidate.page.id, target_url=candidate.page.url, reason=reason
    )
