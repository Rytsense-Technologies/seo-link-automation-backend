from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from app.core.exceptions import ERROR_RESPONSES, ErrorResponse
from app.interlink.dependencies import get_interlink_service
from app.interlink.models import InternalLinkSuggestion, SuggestionStatus
from app.interlink.repository import SuggestionFilters
from app.interlink.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    RejectRequest,
    SuggestionDetail,
    SuggestionList,
    SuggestionRead,
)
from app.interlink.service import InterlinkService
from app.pages.schemas import PageSummary

router = APIRouter(prefix="/interlink", tags=["interlink"], responses=ERROR_RESPONSES)

_AI_ERRORS: dict[int | str, dict[str, Any]] = {
    502: {"model": ErrorResponse, "description": "AI provider failed or returned invalid output"},
    503: {"model": ErrorResponse, "description": "AI provider not configured / database error"},
}


def to_detail(s: InternalLinkSuggestion) -> SuggestionDetail:
    return SuggestionDetail(
        **SuggestionRead.model_validate(s).model_dump(),
        retrieval_score=s.retrieval_score,
        ai_provider=s.ai_provider,
        ai_model=s.ai_model,
        rejection_reason=s.rejection_reason,
        reviewed_at=s.reviewed_at,
        source_page=PageSummary.model_validate(s.source_page),
        target_page=PageSummary.model_validate(s.target_page),
        target_url=s.target_page.url,
    )


@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    summary="Generate internal-link suggestions for a source page",
    responses=_AI_ERRORS,
)
def analyze(
    request: AnalyzeRequest, service: InterlinkService = Depends(get_interlink_service)
) -> AnalyzeResponse:
    """Runs hard filters, lexical candidate retrieval (pool of
    `INTERLINK_CANDIDATE_POOL_SIZE`), AI relevance scoring, anchor/context validation and the
    `INTERLINK_MIN_RELEVANCE_SCORE` threshold. New suggestions are stored as `PENDING`
    unless `dry_run` is true. Pairs that already have a PENDING/APPROVED/APPLIED suggestion,
    or were rejected within `INTERLINK_REJECTION_COOLDOWN_DAYS`, are not regenerated.
    """
    outcome = service.analyze(request)
    return AnalyzeResponse(
        source_page_id=outcome.source_page_id,
        min_relevance_score=outcome.min_relevance_score,
        candidates_retrieved=outcome.candidates_retrieved,
        candidates_after_filtering=outcome.candidates_after_filtering,
        excluded_counts=outcome.excluded_counts,
        dry_run=outcome.dry_run,
        suggestions=[
            SuggestionRead.model_validate(s, from_attributes=True) for s in outcome.suggestions
        ],
        skipped=outcome.skipped,
    )


@router.get("/suggestions", response_model=SuggestionList, summary="List suggestions")
def list_suggestions(
    status: SuggestionStatus | None = Query(
        None, description="PENDING, APPROVED, REJECTED, APPLIED"
    ),
    site_id: uuid.UUID | None = None,
    source_page_id: uuid.UUID | None = None,
    target_page_id: uuid.UUID | None = None,
    min_relevance_score: int | None = Query(None, ge=0, le=100),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    service: InterlinkService = Depends(get_interlink_service),
) -> SuggestionList:
    filters = SuggestionFilters(
        status=status,
        site_id=site_id,
        source_page_id=source_page_id,
        target_page_id=target_page_id,
        min_relevance_score=min_relevance_score,
    )
    items, total = service.list_suggestions(filters, page=page, page_size=page_size)
    return SuggestionList(
        items=[SuggestionRead.model_validate(s) for s in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/suggestions/{suggestion_id}", response_model=SuggestionDetail, summary="Suggestion detail"
)
def get_suggestion(
    suggestion_id: uuid.UUID, service: InterlinkService = Depends(get_interlink_service)
) -> SuggestionDetail:
    return to_detail(service.get_suggestion(suggestion_id))


@router.post(
    "/suggestions/{suggestion_id}/approve",
    response_model=SuggestionDetail,
    summary="Approve a suggestion (PENDING/REJECTED -> APPROVED)",
)
def approve_suggestion(
    suggestion_id: uuid.UUID, service: InterlinkService = Depends(get_interlink_service)
) -> SuggestionDetail:
    return to_detail(service.approve(suggestion_id))


@router.post(
    "/suggestions/{suggestion_id}/reject",
    response_model=SuggestionDetail,
    summary="Reject a suggestion (PENDING/APPROVED -> REJECTED)",
)
def reject_suggestion(
    suggestion_id: uuid.UUID,
    body: RejectRequest | None = Body(default=None),
    service: InterlinkService = Depends(get_interlink_service),
) -> SuggestionDetail:
    return to_detail(service.reject(suggestion_id, body.reason if body else None))


@router.post(
    "/suggestions/{suggestion_id}/apply",
    response_model=SuggestionDetail,
    summary="Apply an APPROVED suggestion to the source page content",
)
def apply_suggestion(
    suggestion_id: uuid.UUID, service: InterlinkService = Depends(get_interlink_service)
) -> SuggestionDetail:
    """Re-validates the source and target pages, verifies the source does not already link to
    the target and that the approved context sentence still exists, then inserts exactly one
    `<a>` around the anchor inside that sentence. Text inside existing links, headings,
    navigation, code, script/style and other unsafe elements is never linked.

    Errors: `409 SUGGESTION_NOT_APPROVED | ALREADY_LINKED | TARGET_NOT_LINKABLE |
    CONTENT_VERSION_CONFLICT`, `422 CONTEXT_NOT_FOUND | ANCHOR_NOT_FOUND |
    ANCHOR_IN_UNSAFE_ELEMENT`.
    """
    return to_detail(service.apply(suggestion_id))
