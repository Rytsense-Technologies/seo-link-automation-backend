from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.interlink.models import SuggestionStatus
from app.pages.schemas import PageSummary

# ---------------------------------------------------------------- AI output contract


class AIRelevanceItem(BaseModel):
    """One judgement returned by the LLM for a backend-supplied candidate."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    target_page_id: str = Field(min_length=1)
    target_url: str | None = None
    is_relevant: bool = True
    relevance_score: int = Field(ge=0, le=100)
    reason: str = Field(min_length=1, max_length=2000)
    anchor_text: str = Field(min_length=1, max_length=255)
    suggested_context: str = Field(min_length=1, max_length=2000)

    @field_validator("relevance_score", mode="before")
    @classmethod
    def _round_score(cls, value: object) -> object:
        if isinstance(value, float):
            return round(value)
        return value


class AIRelevanceResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    suggestions: list[AIRelevanceItem] = Field(default_factory=list)


# ---------------------------------------------------------------- API contract


class AnalyzeRequest(BaseModel):
    source_page_id: uuid.UUID
    max_suggestions: int | None = Field(
        default=None, ge=1, le=50, description="Defaults to INTERLINK_MAX_SUGGESTIONS_PER_PAGE"
    )
    min_relevance_score: int | None = Field(
        default=None,
        ge=0,
        le=100,
        description="Override INTERLINK_MIN_RELEVANCE_SCORE; cannot go below the configured value",
    )
    dry_run: bool = Field(default=False, description="Return suggestions without storing them")


class SuggestionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID | None = Field(description="Null for dry-run results")
    site_id: uuid.UUID
    source_page_id: uuid.UUID
    target_page_id: uuid.UUID
    anchor_text: str
    context: str
    relevance_score: int = Field(ge=0, le=100)
    reason: str
    status: SuggestionStatus
    created_at: datetime | None
    updated_at: datetime | None
    applied_at: datetime | None


class SuggestionDetail(SuggestionRead):
    retrieval_score: float | None
    ai_provider: str | None
    ai_model: str | None
    rejection_reason: str | None
    reviewed_at: datetime | None
    source_page: PageSummary
    target_page: PageSummary
    target_url: str = Field(description="Target page URL the link points to")


class SkippedCandidate(BaseModel):
    target_page_id: uuid.UUID
    target_url: str
    reason: str = Field(examples=["BELOW_THRESHOLD", "ACTIVE_SUGGESTION_EXISTS", "NOINDEX"])


class AnalyzeResponse(BaseModel):
    source_page_id: uuid.UUID
    min_relevance_score: int
    candidates_retrieved: int
    candidates_after_filtering: int
    excluded_counts: dict[str, int] = Field(
        description="Pages removed before AI scoring, by reason (e.g. NOINDEX, REDIRECTED)"
    )
    dry_run: bool
    suggestions: list[SuggestionRead]
    skipped: list[SkippedCandidate]


class SuggestionList(BaseModel):
    items: list[SuggestionRead]
    total: int
    page: int
    page_size: int


class RejectRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)
