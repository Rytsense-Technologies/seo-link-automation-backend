"""Application configuration loaded from environment variables / `.env`."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

AIProviderName = Literal["gemini", "groq", "openai", "none"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SEO Link Automation API"
    environment: Literal["development", "test", "staging", "production"] = "development"
    log_level: str = "INFO"
    api_prefix: str = "/api"
    # When set, every /api request must send `X-API-Key: <value>`.
    api_key: SecretStr | None = None
    cors_origins: list[str] = Field(default_factory=list)

    # Placeholder only; the real value comes from DATABASE_URL in .env / the environment.
    database_url: str = "postgresql+psycopg://postgres:*****@localhost:5432/link_automation"
    database_pool_size: int = 5
    database_echo: bool = False

    # AI provider
    ai_provider: AIProviderName = "none"
    ai_api_key: SecretStr | None = None
    ai_model: str | None = None
    ai_base_url: str | None = None
    ai_timeout_seconds: float = 60.0
    ai_temperature: float = 0.2

    # Interlink module
    interlink_min_relevance_score: int = Field(default=70, ge=0, le=100)
    interlink_candidate_pool_size: int = Field(default=15, ge=1, le=50)
    interlink_max_suggestions_per_page: int = Field(default=5, ge=1, le=50)
    interlink_rejection_cooldown_days: int = Field(default=30, ge=0)
    interlink_max_anchor_reuse: int = Field(default=3, ge=1)
    interlink_source_content_max_chars: int = Field(default=6000, ge=500)
    interlink_target_excerpt_chars: int = Field(default=300, ge=0)
    interlink_require_region_match: bool = True
    interlink_utility_page_types: list[str] = Field(
        default_factory=lambda: ["utility", "system", "legal", "auth", "search", "archive"]
    )
    interlink_utility_path_patterns: list[str] = Field(
        default_factory=lambda: [
            r"^/(login|logout|signin|sign-in|signup|sign-up|register|account|my-account)(/|$)",
            r"^/(cart|checkout|basket)(/|$)",
            r"^/(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|cookie-policy|cookies|disclaimer)(/|$)",
            r"^/(search|tag|tags|author|feed|rss|wp-admin|wp-login\.php|wp-json|admin|api)(/|$)",
            r"^/(404|500|thank-you|thanks)(/|$)",
            r"\.(pdf|jpe?g|png|gif|svg|webp|zip|xml|txt|json|css|js)$",
        ]
    )

    # Crawler (page inventory)
    crawler_user_agent: str = "SEOLinkAutomationBot/0.1"
    crawler_timeout_seconds: float = Field(default=15.0, gt=0)
    crawler_max_retries: int = Field(default=2, ge=0, le=5)
    crawler_max_redirects: int = Field(default=5, ge=0, le=10)
    crawler_max_response_bytes: int = Field(default=5_000_000, ge=10_000)
    crawler_request_delay_seconds: float = Field(default=0.5, ge=0)
    crawler_max_crawl_delay_seconds: float = Field(default=10.0, ge=0)
    crawler_max_pages_limit: int = Field(default=1000, ge=1)
    crawler_max_sitemaps: int = Field(default=50, ge=1)
    crawler_allowed_ports: list[int] = Field(default_factory=lambda: [80, 443])


@lru_cache
def get_settings() -> Settings:
    return Settings()
