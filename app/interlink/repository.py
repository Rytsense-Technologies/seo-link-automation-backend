"""Data access for the interlink module (PostgreSQL via SQLAlchemy)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer

from app.core.exceptions import ConflictError
from app.interlink.models import ACTIVE_STATUSES, InternalLinkSuggestion, SuggestionStatus
from app.pages.models import Page


@dataclass(frozen=True)
class SuggestionFilters:
    status: SuggestionStatus | None = None
    site_id: uuid.UUID | None = None
    source_page_id: uuid.UUID | None = None
    target_page_id: uuid.UUID | None = None
    min_relevance_score: int | None = None


class InterlinkRepository(Protocol):
    def get_page(self, page_id: uuid.UUID, *, for_update: bool = False) -> Page | None: ...

    def list_candidate_pool(self, source: Page) -> list[Page]: ...

    def load_contents(self, page_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]: ...

    def get_suggestion(
        self, suggestion_id: uuid.UUID, *, for_update: bool = False
    ) -> InternalLinkSuggestion | None: ...

    def list_suggestions(
        self, filters: SuggestionFilters, *, offset: int, limit: int
    ) -> tuple[list[InternalLinkSuggestion], int]: ...

    def active_target_ids(self, source_page_id: uuid.UUID) -> set[uuid.UUID]: ...

    def rejected_target_ids_since(
        self, source_page_id: uuid.UUID, since: datetime
    ) -> set[uuid.UUID]: ...

    def anchors_by_target(self, target_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[str]]: ...

    def add_suggestion(self, suggestion: InternalLinkSuggestion) -> bool:
        """Insert; return False (without failing the transaction) on an active-pair duplicate."""
        ...

    def commit(self) -> None:
        """Commit; raise ConflictError(ACTIVE_SUGGESTION_EXISTS) on an active-pair clash."""
        ...

    def rollback(self) -> None: ...


ACTIVE_PAIR_INDEX = "uq_internal_link_suggestions_active_pair"


def _constraint_name(exc: IntegrityError) -> str | None:
    diag = getattr(exc.orig, "diag", None)
    return getattr(diag, "constraint_name", None)


class SqlAlchemyInterlinkRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get_page(self, page_id: uuid.UUID, *, for_update: bool = False) -> Page | None:
        stmt = select(Page).where(Page.id == page_id).options(undefer(Page.content_html))
        if for_update:
            stmt = stmt.with_for_update()
        return self._session.scalar(stmt)

    def list_candidate_pool(self, source: Page) -> list[Page]:
        # Cheap SQL pre-filter; `candidate_filter` remains the authoritative rule set.
        stmt = (
            select(Page)
            .where(
                Page.site_id == source.site_id,
                Page.id != source.id,
                Page.http_status >= 200,
                Page.http_status < 300,
                Page.redirect_url.is_(None),
                Page.has_noindex.is_(False),
                Page.is_indexable.is_(True),
            )
            .order_by(Page.url)
        )
        return list(self._session.scalars(stmt))

    def load_contents(self, page_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not page_ids:
            return {}
        rows = self._session.execute(
            select(Page.id, Page.content_html).where(Page.id.in_(page_ids))
        )
        return {row.id: row.content_html for row in rows if row.content_html}

    def get_suggestion(
        self, suggestion_id: uuid.UUID, *, for_update: bool = False
    ) -> InternalLinkSuggestion | None:
        stmt = select(InternalLinkSuggestion).where(InternalLinkSuggestion.id == suggestion_id)
        if for_update:
            # Lock only the suggestion row, not the joined page rows.
            stmt = stmt.with_for_update(of=InternalLinkSuggestion)
        return self._session.scalar(stmt)

    def list_suggestions(
        self, filters: SuggestionFilters, *, offset: int, limit: int
    ) -> tuple[list[InternalLinkSuggestion], int]:
        conditions = []
        if filters.status is not None:
            conditions.append(InternalLinkSuggestion.status == filters.status)
        if filters.site_id is not None:
            conditions.append(InternalLinkSuggestion.site_id == filters.site_id)
        if filters.source_page_id is not None:
            conditions.append(InternalLinkSuggestion.source_page_id == filters.source_page_id)
        if filters.target_page_id is not None:
            conditions.append(InternalLinkSuggestion.target_page_id == filters.target_page_id)
        if filters.min_relevance_score is not None:
            conditions.append(InternalLinkSuggestion.relevance_score >= filters.min_relevance_score)
        total = (
            self._session.scalar(
                select(func.count()).select_from(InternalLinkSuggestion).where(*conditions)
            )
            or 0
        )
        items = self._session.scalars(
            select(InternalLinkSuggestion)
            .where(*conditions)
            .order_by(
                InternalLinkSuggestion.created_at.desc(),
                InternalLinkSuggestion.relevance_score.desc(),
                InternalLinkSuggestion.id,
            )
            .offset(offset)
            .limit(limit)
        )
        return list(items), total

    def active_target_ids(self, source_page_id: uuid.UUID) -> set[uuid.UUID]:
        rows = self._session.scalars(
            select(InternalLinkSuggestion.target_page_id).where(
                InternalLinkSuggestion.source_page_id == source_page_id,
                InternalLinkSuggestion.status.in_(ACTIVE_STATUSES),
            )
        )
        return set(rows)

    def rejected_target_ids_since(
        self, source_page_id: uuid.UUID, since: datetime
    ) -> set[uuid.UUID]:
        rows = self._session.scalars(
            select(InternalLinkSuggestion.target_page_id).where(
                InternalLinkSuggestion.source_page_id == source_page_id,
                InternalLinkSuggestion.status == SuggestionStatus.REJECTED,
                InternalLinkSuggestion.updated_at >= since,
            )
        )
        return set(rows)

    def anchors_by_target(self, target_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
        if not target_ids:
            return {}
        rows = self._session.execute(
            select(InternalLinkSuggestion.target_page_id, InternalLinkSuggestion.anchor_text).where(
                InternalLinkSuggestion.target_page_id.in_(target_ids),
                InternalLinkSuggestion.status.in_(ACTIVE_STATUSES),
            )
        )
        result: dict[uuid.UUID, list[str]] = {}
        for target_id, anchor in rows:
            result.setdefault(target_id, []).append(anchor)
        return result

    def add_suggestion(self, suggestion: InternalLinkSuggestion) -> bool:
        try:
            with self._session.begin_nested():
                self._session.add(suggestion)
                self._session.flush()
        except IntegrityError as exc:
            # Concurrent analysis already created the active pair (partial unique index).
            if _constraint_name(exc) == ACTIVE_PAIR_INDEX:
                return False
            raise
        return True

    def commit(self) -> None:
        try:
            self._session.commit()
        except IntegrityError as exc:
            self._session.rollback()
            if _constraint_name(exc) == ACTIVE_PAIR_INDEX:
                raise ConflictError(
                    "Another active suggestion already exists for this source and target",
                    code="ACTIVE_SUGGESTION_EXISTS",
                ) from exc
            raise

    def rollback(self) -> None:
        self._session.rollback()
