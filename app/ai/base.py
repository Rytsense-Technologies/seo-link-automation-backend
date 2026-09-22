"""Provider-agnostic interface for LLM calls that must return a JSON object."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any

from app.core.exceptions import UpstreamError


class AIProviderError(UpstreamError):
    code = "AI_PROVIDER_ERROR"


class AIProvider(ABC):
    name: str

    def __init__(self, model: str) -> None:
        self.model = model

    @abstractmethod
    def generate_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        """Return the model's reply parsed as a JSON object."""


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse a JSON object from model output, tolerating ```json fences."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise AIProviderError("AI provider returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise AIProviderError("AI provider returned JSON that is not an object")
    return value
