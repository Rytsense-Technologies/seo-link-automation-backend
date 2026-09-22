"""Anchor-text and context validation applied to every AI suggestion before it is stored."""

from __future__ import annotations

import re
from collections import Counter

from app.content.html import collapse_whitespace
from app.interlink.text_features import tokenize

GENERIC_ANCHORS = frozenset(
    {
        "click here", "click", "here", "read more", "learn more", "more", "this", "this page",
        "this article", "this post", "this link", "link", "website", "page", "article",
        "find out more", "see more", "details", "more info", "more information", "go",
        "continue", "check it out", "view", "visit", "our website",
    }
)  # fmt: skip

MAX_ANCHOR_WORDS = 8
MAX_ANCHOR_CHARS = 100
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


# Single-char -> single-char so normalised offsets can be mapped back to the source text.
QUOTE_MAP = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"'})


def normalize_for_match(value: str) -> str:
    """Case/whitespace/quote-insensitive form used to compare AI text with page text."""
    return collapse_whitespace(value.translate(QUOTE_MAP)).casefold()


def anchor_problem(anchor: str, context: str) -> str | None:
    """Return a rejection code if the anchor is unusable, else None."""
    words = _WORD_RE.findall(anchor.casefold())
    if not words:
        return "ANCHOR_EMPTY"
    if normalize_for_match(anchor).strip(" .,:;!?\"'") in GENERIC_ANCHORS:
        return "ANCHOR_GENERIC"
    if not tokenize(anchor):
        # Only stopwords/numbers ("while a", "of the"): says nothing about the destination.
        return "ANCHOR_NOT_DESCRIPTIVE"
    if len(words) > MAX_ANCHOR_WORDS or len(anchor) > MAX_ANCHOR_CHARS:
        return "ANCHOR_TOO_LONG"
    counts = Counter(words)
    if len(words) >= 3 and counts.most_common(1)[0][1] > 1:
        return "ANCHOR_KEYWORD_STUFFING"
    if not contains_phrase(context, anchor):
        return "ANCHOR_NOT_IN_CONTEXT"
    return None


def contains_phrase(haystack: str, needle: str) -> bool:
    """Whole-word, normalised containment."""
    h, n = normalize_for_match(haystack), normalize_for_match(needle)
    if not n:
        return False
    pattern = rf"(?<![^\W_]){re.escape(n)}(?![^\W_])"
    return re.search(pattern, h) is not None
