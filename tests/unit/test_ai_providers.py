"""AI providers are exercised against httpx.MockTransport; no network calls."""

from __future__ import annotations

import json

import httpx
import pytest
from pydantic import SecretStr

from app.ai.base import AIProviderError
from app.ai.factory import build_ai_provider
from app.ai.providers import GeminiProvider, GroqProvider
from app.core.config import Settings
from app.core.exceptions import ServiceUnavailableError


def _client(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler)


def test_gemini_request_and_parse() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": '{"suggestions": []}'}]}}]},
        )

    provider = GeminiProvider(
        api_key="k",
        model="m",
        base_url="https://gemini.test/v1beta",
        timeout=5,
        temperature=0.1,
        client=_client(httpx.MockTransport(handler)),
    )
    assert provider.generate_json(system="sys", prompt="p") == {"suggestions": []}
    assert seen["url"] == "https://gemini.test/v1beta/models/m:generateContent"
    assert seen["key"] == "k"
    body = seen["body"]
    assert isinstance(body, dict)
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_groq_openai_compatible_request_and_errors() -> None:
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer k"
        assert json.loads(request.content)["response_format"] == {"type": "json_object"}
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"a": 1}'}}]})

    kwargs = {"api_key": "k", "model": "m", "base_url": "https://groq.test", "timeout": 5.0,
              "temperature": 0.1}  # fmt: skip
    provider = GroqProvider(**kwargs, client=_client(httpx.MockTransport(ok)))  # type: ignore[arg-type]
    assert provider.generate_json(system="s", prompt="p") == {"a": 1}

    failing = GroqProvider(
        **kwargs,  # type: ignore[arg-type]
        client=_client(httpx.MockTransport(lambda r: httpx.Response(429, text="rate limited"))),
    )
    with pytest.raises(AIProviderError) as exc:
        failing.generate_json(system="s", prompt="p")
    assert exc.value.status_code == 502

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    offline = GroqProvider(**kwargs, client=_client(httpx.MockTransport(boom)))  # type: ignore[arg-type]
    with pytest.raises(AIProviderError):
        offline.generate_json(system="s", prompt="p")


def test_factory_requires_configuration() -> None:
    with pytest.raises(ServiceUnavailableError) as exc:
        build_ai_provider(Settings(_env_file=None, ai_provider="none"))  # type: ignore[call-arg]
    assert exc.value.code == "AI_PROVIDER_NOT_CONFIGURED"
    with pytest.raises(ServiceUnavailableError):
        build_ai_provider(Settings(_env_file=None, ai_provider="gemini", ai_api_key=None))  # type: ignore[call-arg]
    provider = build_ai_provider(
        Settings(_env_file=None, ai_provider="groq", ai_api_key=SecretStr("x"))  # type: ignore[call-arg]
    )
    assert provider.name == "groq"
    assert provider.model == GroqProvider.DEFAULT_MODEL
