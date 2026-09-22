from __future__ import annotations

import pytest

from app.interlink.anchor_rules import anchor_problem, contains_phrase

CONTEXT = "Businesses can use AI voice agents to automate repetitive customer support."


@pytest.mark.parametrize("anchor", ["AI voice agents", "customer support", "ai VOICE agents"])
def test_valid_anchors(anchor: str) -> None:
    assert anchor_problem(anchor, CONTEXT) is None


@pytest.mark.parametrize(
    ("anchor", "context", "code"),
    [
        ("click here", "For details click here.", "ANCHOR_GENERIC"),
        ("Read more", "Read more about it.", "ANCHOR_GENERIC"),
        ("!!!", CONTEXT, "ANCHOR_EMPTY"),
        ("can use", CONTEXT, "ANCHOR_NOT_DESCRIPTIVE"),
        (
            "use AI voice agents to automate repetitive customer support now",
            "We use AI voice agents to automate repetitive customer support now.",
            "ANCHOR_TOO_LONG",
        ),
        (
            "voice agents voice agents",
            "Try voice agents voice agents today.",
            "ANCHOR_KEYWORD_STUFFING",
        ),
        ("chatbot platform", CONTEXT, "ANCHOR_NOT_IN_CONTEXT"),
        ("voice agent", CONTEXT, "ANCHOR_NOT_IN_CONTEXT"),  # partial word "agents"
    ],
)
def test_invalid_anchors(anchor: str, context: str, code: str) -> None:
    assert anchor_problem(anchor, context) == code


def test_contains_phrase_is_whitespace_quote_and_case_insensitive() -> None:
    assert contains_phrase("It’s   a  Smart\nChoice", "it's a smart choice")
    assert not contains_phrase("automation", "auto")
