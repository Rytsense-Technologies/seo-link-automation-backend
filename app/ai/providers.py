"""Concrete AI providers using plain HTTP (no vendor SDKs)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.ai.base import AIProvider, AIProviderError, parse_json_object

logger = logging.getLogger(__name__)


class _HTTPProvider(AIProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str,
        timeout: float,
        temperature: float,
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(model)
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._temperature = temperature
        self._client = client or httpx.Client(timeout=timeout)

    def _post(self, url: str, *, headers: dict[str, str], body: dict[str, Any]) -> Any:
        try:
            response = self._client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            logger.warning("%s request failed: %s", self.name, exc)
            raise AIProviderError(f"{self.name} request failed") from exc
        if response.status_code >= 400:
            # Never log the request (it carries credentials); the body is the provider's error.
            logger.warning(
                "%s returned HTTP %s: %s", self.name, response.status_code, response.text[:500]
            )
            raise AIProviderError(
                f"{self.name} returned HTTP {response.status_code}",
                details={"provider_status": response.status_code},
            )
        try:
            return response.json()
        except ValueError as exc:
            raise AIProviderError(f"{self.name} returned a non-JSON response") from exc


class GeminiProvider(_HTTPProvider):
    name = "gemini"
    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
    DEFAULT_MODEL = "gemini-2.5-flash"

    def generate_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        data = self._post(
            f"{self._base_url}/models/{self.model}:generateContent",
            headers={"x-goog-api-key": self._api_key},
            body={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": self._temperature,
                    "responseMimeType": "application/json",
                },
            },
        )
        try:
            text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError, TypeError) as exc:
            raise AIProviderError("Unexpected Gemini response shape") from exc
        return parse_json_object(text)


class OpenAICompatibleProvider(_HTTPProvider):
    """OpenAI chat-completions API; also used for Groq's OpenAI-compatible endpoint."""

    name = "openai"
    DEFAULT_BASE_URL = "https://api.openai.com/v1"
    DEFAULT_MODEL = "gpt-4o-mini"

    def generate_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        data = self._post(
            f"{self._base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self._api_key}"},
            body={
                "model": self.model,
                "temperature": self._temperature,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise AIProviderError(f"Unexpected {self.name} response shape") from exc
        return parse_json_object(text or "")


class GroqProvider(OpenAICompatibleProvider):
    name = "groq"
    DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
    DEFAULT_MODEL = "llama-3.3-70b-versatile"
