"""Lightweight text features (tokens, TF-IDF vectors) for lexical candidate retrieval."""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from itertools import pairwise

_TOKEN_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)

_STOPWORDS_TEXT = """
a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for from
further get got had has have having he her here hers herself him himself his how i if in into
is it its itself just let me more most my myself no nor not now of off on once only or other
our ours ourselves out over own same she should so some such than that the their theirs them
themselves then there these they this those through to too under until up very was we were
what when where which while who whom why will with would you your yours yourself yourselves
us via per may might must shall use using used new one two three best top guide page home
www com html htm php aspx index
"""
STOPWORDS = frozenset(_STOPWORDS_TEXT.split())

Vector = dict[str, float]


def tokenize(text: str | None) -> list[str]:
    if not text:
        return []
    tokens = []
    for raw in _TOKEN_RE.findall(text.lower()):
        token = raw.replace("’", "'")
        if len(token) < 2 or token in STOPWORDS or token.isdigit():
            continue
        tokens.append(_stem(token))
    return tokens


def _stem(token: str) -> str:
    """Very light plural/suffix folding so 'agents' ~ 'agent' without a stemming dependency."""
    for suffix, min_len in (("ies", 5), ("s", 4)):
        if token.endswith(suffix) and len(token) >= min_len and not token.endswith("ss"):
            return token[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return token


def terms(tokens: list[str]) -> list[str]:
    """Unigrams plus bigrams (phrases such as 'voice agent' carry more signal)."""
    return tokens + [f"{a} {b}" for a, b in pairwise(tokens)]


def weighted_terms(fields: Iterable[tuple[str | None, float]]) -> dict[str, float]:
    counts: defaultdict[str, float] = defaultdict(float)
    for text, weight in fields:
        for term in terms(tokenize(text)):
            counts[term] += weight
    return dict(counts)


def idf(documents: Iterable[Mapping[str, float]]) -> dict[str, float]:
    df: Counter[str] = Counter()
    n = 0
    for doc in documents:
        n += 1
        df.update(doc.keys())
    return {term: math.log((1 + n) / (1 + count)) + 1.0 for term, count in df.items()}


def tfidf(
    counts: Mapping[str, float], idf_values: Mapping[str, float], default_idf: float
) -> Vector:
    return {
        t: (1 + math.log(c)) * idf_values.get(t, default_idf) for t, c in counts.items() if c > 0
    }


def cosine(a: Vector, b: Vector) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(t, 0.0) for t, v in a.items())
    if dot == 0.0:
        return 0.0
    norm = math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values()))
    return dot / norm
