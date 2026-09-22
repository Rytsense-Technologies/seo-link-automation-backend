"""Import every model module so `Base.metadata` is complete (Alembic, tooling)."""

from app.db.base import Base
from app.interlink.models import InternalLinkSuggestion
from app.pages.models import Page, Site

__all__ = ["Base", "InternalLinkSuggestion", "Page", "Site"]
