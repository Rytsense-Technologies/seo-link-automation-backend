from __future__ import annotations

from functools import lru_cache

from app.ai.base import AIProvider
from app.ai.providers import GeminiProvider, GroqProvider, OpenAICompatibleProvider
from app.core.config import Settings, get_settings
from app.core.exceptions import ServiceUnavailableError

_PROVIDERS: dict[str, type[GeminiProvider] | type[OpenAICompatibleProvider]] = {
    "gemini": GeminiProvider,
    "groq": GroqProvider,
    "openai": OpenAICompatibleProvider,
}


def build_ai_provider(settings: Settings) -> AIProvider:
    provider_cls = _PROVIDERS.get(settings.ai_provider)
    if provider_cls is None or settings.ai_api_key is None:
        raise ServiceUnavailableError(
            "No AI provider is configured (set AI_PROVIDER and AI_API_KEY)",
            code="AI_PROVIDER_NOT_CONFIGURED",
        )
    return provider_cls(
        api_key=settings.ai_api_key.get_secret_value(),
        model=settings.ai_model or provider_cls.DEFAULT_MODEL,
        base_url=settings.ai_base_url or provider_cls.DEFAULT_BASE_URL,
        timeout=settings.ai_timeout_seconds,
        temperature=settings.ai_temperature,
    )


@lru_cache
def _cached_provider() -> AIProvider:
    return build_ai_provider(get_settings())


def get_ai_provider() -> AIProvider:
    """FastAPI dependency; the provider (and its HTTP connection pool) is shared."""
    return _cached_provider()
