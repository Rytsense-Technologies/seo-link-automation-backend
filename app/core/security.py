# """Optional API-key authentication for the /api routes."""

# from __future__ import annotations

# import secrets

# from fastapi import Security
# from fastapi.security import APIKeyHeader

# from app.core.config import get_settings
# from app.core.exceptions import AppError

# _api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


# def require_api_key(
#     api_key: str | None = Security(_api_key_header),
# ) -> None:
#     """Require X-API-Key only when API_KEY is configured."""

#     settings = get_settings()
#     expected = settings.api_key

#     # API key authentication is disabled when API_KEY is empty/unset.
#     if expected is None or not expected.get_secret_value().strip():
#         return

#     if api_key is None or not secrets.compare_digest(
#         api_key,
#         expected.get_secret_value(),
#     ):
#         raise AppError(
#             "Invalid or missing API key",
#             code="UNAUTHORIZED",
#             status_code=401,
#         )
"""Optional API-key authentication for the /api routes."""

from __future__ import annotations

import secrets

from fastapi import Depends, Security
from fastapi.security import APIKeyHeader

from app.core.config import Settings, get_settings
from app.core.exceptions import AppError

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_api_key(
    api_key: str | None = Security(_api_key_header),
    settings: Settings = Depends(get_settings),
) -> None:
    """Require X-API-Key only when API_KEY is configured."""

    expected = settings.api_key

    # API key authentication is disabled when API_KEY is empty/unset.
    if expected is None or not expected.get_secret_value().strip():
        return

    if api_key is None or not secrets.compare_digest(
        api_key,
        expected.get_secret_value(),
    ):
        raise AppError(
            "Invalid or missing API key",
            code="UNAUTHORIZED",
            status_code=401,
        )
