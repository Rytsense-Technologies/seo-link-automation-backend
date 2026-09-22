"""Composition root for the interlink module (swap retriever/content store here)."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from app.ai.factory import get_ai_provider
from app.content.store import DatabaseContentStore
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.interlink.candidate_retriever import LexicalCandidateRetriever
from app.interlink.relevance_analyzer import RelevanceAnalyzer
from app.interlink.repository import SqlAlchemyInterlinkRepository
from app.interlink.service import InterlinkConfig, InterlinkService


def get_interlink_service(
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> InterlinkService:
    def analyzer_factory() -> RelevanceAnalyzer:
        return RelevanceAnalyzer(
            get_ai_provider(),
            source_content_max_chars=settings.interlink_source_content_max_chars,
            target_excerpt_chars=settings.interlink_target_excerpt_chars,
        )

    return InterlinkService(
        SqlAlchemyInterlinkRepository(session),
        config=InterlinkConfig.from_settings(settings),
        retriever=LexicalCandidateRetriever(),
        analyzer_factory=analyzer_factory,
        content_store=DatabaseContentStore(session),
    )
