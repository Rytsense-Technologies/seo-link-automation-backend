from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging
from app.core.security import require_api_key
from app.crawler.router import router as crawler_router
from app.db.session import ping_database
from app.interlink.router import router as interlink_router
from app.pages.router import router as pages_router


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description=(
            "SEO link automation backend. The **interlink** endpoints generate, review and "
            "safely apply contextual internal-link suggestions. Suggestion status values: "
            "`PENDING`, `APPROVED`, `REJECTED`, `APPLIED`."
        ),
    )
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    register_exception_handlers(app)

    api = APIRouter(prefix=settings.api_prefix, dependencies=[Depends(require_api_key)])
    api.include_router(pages_router)
    api.include_router(interlink_router)
    api.include_router(crawler_router)
    app.include_router(api)

    @app.get("/health", tags=["health"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/db", tags=["health"])
    def health_db() -> dict[str, str]:
        ping_database()
        return {"status": "ok", "database": "ok"}

    return app


app = create_app()
