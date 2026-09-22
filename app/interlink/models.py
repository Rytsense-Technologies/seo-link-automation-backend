from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.pages.models import Page


class SuggestionStatus(enum.StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    APPLIED = "APPLIED"


# A source -> target pair may have at most one suggestion in these states.
ACTIVE_STATUSES = (SuggestionStatus.PENDING, SuggestionStatus.APPROVED, SuggestionStatus.APPLIED)

suggestion_status_enum = Enum(
    SuggestionStatus,
    name="interlink_suggestion_status",
    values_callable=lambda e: [m.value for m in e],
)


class InternalLinkSuggestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "internal_link_suggestions"
    __table_args__ = (
        CheckConstraint("relevance_score BETWEEN 0 AND 100", name="relevance_score_range"),
        CheckConstraint("source_page_id <> target_page_id", name="no_self_link"),
        Index(
            "uq_internal_link_suggestions_active_pair",
            "source_page_id",
            "target_page_id",
            unique=True,
            postgresql_where=text("status IN ('PENDING', 'APPROVED', 'APPLIED')"),
        ),
        Index("ix_internal_link_suggestions_status_score", "status", "relevance_score"),
    )

    site_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_page_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_page_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    anchor_text: Mapped[str] = mapped_column(String(255), nullable=False)
    context: Mapped[str] = mapped_column(Text, nullable=False)
    relevance_score: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[SuggestionStatus] = mapped_column(
        suggestion_status_enum, nullable=False, default=SuggestionStatus.PENDING
    )
    # Lexical retrieval score (0-1) that put the target into the candidate pool.
    retrieval_score: Mapped[float | None] = mapped_column()
    ai_provider: Mapped[str | None] = mapped_column(String(32))
    ai_model: Mapped[str | None] = mapped_column(String(128))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    source_page: Mapped[Page] = relationship(foreign_keys=[source_page_id], lazy="joined")
    target_page: Mapped[Page] = relationship(foreign_keys=[target_page_id], lazy="joined")
