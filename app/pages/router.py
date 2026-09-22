from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.exceptions import ERROR_RESPONSES
from app.db.session import get_db
from app.pages.schemas import (
    PageBulkUpsert,
    PageBulkUpsertResult,
    PageDetail,
    PageList,
    PageRead,
    SiteCreate,
    SiteRead,
)
from app.pages.service import PageService

router = APIRouter(tags=["pages"], responses=ERROR_RESPONSES)


def get_page_service(session: Session = Depends(get_db)) -> PageService:
    return PageService(session)


@router.post("/sites", response_model=SiteRead, status_code=status.HTTP_201_CREATED)
def create_site(data: SiteCreate, service: PageService = Depends(get_page_service)) -> SiteRead:
    """Register a website whose pages form the internal-link inventory."""
    return SiteRead.model_validate(service.create_site(data))


@router.get("/sites", response_model=list[SiteRead])
def list_sites(service: PageService = Depends(get_page_service)) -> list[SiteRead]:
    return [SiteRead.model_validate(s) for s in service.list_sites()]


@router.put("/sites/{site_id}/pages", response_model=PageBulkUpsertResult)
def upsert_pages(
    site_id: uuid.UUID, data: PageBulkUpsert, service: PageService = Depends(get_page_service)
) -> PageBulkUpsertResult:
    """Insert or update pages (keyed by normalised URL) from a crawl or content import."""
    ids = service.upsert_pages(site_id, data.pages)
    return PageBulkUpsertResult(upserted=len(ids), page_ids=ids)


@router.get("/pages", response_model=PageList)
def list_pages(
    site_id: uuid.UUID | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    service: PageService = Depends(get_page_service),
) -> PageList:
    items, total = service.list_pages(site_id=site_id, page=page, page_size=page_size)
    return PageList(
        items=[PageRead.model_validate(p) for p in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/pages/{page_id}", response_model=PageDetail)
def get_page(page_id: uuid.UUID, service: PageService = Depends(get_page_service)) -> PageDetail:
    return PageDetail.model_validate(service.get_page(page_id))
