"""robots.txt handling per RFC 9309.

`urllib.robotparser` is not used because it does plain prefix matching and ignores the
`*` / `$` wildcards, which would silently crawl paths a site has disallowed.

Rules:
- The group whose user-agent matches our product token is used (merged if repeated);
  otherwise the `*` group; otherwise everything is allowed.
- The most specific (longest) matching rule wins; `Allow` wins ties.
- robots.txt fetch: 2xx -> parse, 4xx -> allow all, 5xx / network failure -> disallow all.
"""

from __future__ import annotations

import re
from contextlib import suppress
from dataclasses import dataclass, field
from urllib.parse import unquote, urlsplit


@dataclass
class _Group:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, pattern)
    crawl_delay: float | None = None


@dataclass
class RobotsRules:
    rules: list[tuple[bool, str]] = field(default_factory=list)
    crawl_delay: float | None = None
    sitemaps: list[str] = field(default_factory=list)
    allow_all: bool = False
    disallow_all: bool = False
    source_status: int | None = None

    @classmethod
    def allowing_all(cls, status: int | None = None) -> RobotsRules:
        return cls(allow_all=True, source_status=status)

    @classmethod
    def disallowing_all(cls, status: int | None = None) -> RobotsRules:
        return cls(disallow_all=True, source_status=status)

    def can_fetch(self, url: str) -> bool:
        parts = urlsplit(url)
        path = parts.path or "/"
        if path == "/robots.txt":
            return True
        if self.disallow_all:
            return False
        if self.allow_all or not self.rules:
            return True
        target = _normalise_path(path + (f"?{parts.query}" if parts.query else ""))
        best: tuple[int, bool] | None = None  # (specificity, allow)
        for allow, pattern in self.rules:
            if _matches(pattern, target):
                candidate = (len(pattern), allow)
                if best is None or candidate[0] > best[0] or (candidate[0] == best[0] and allow):
                    best = candidate
        return True if best is None else best[1]


def _normalise_path(value: str) -> str:
    # Compare in decoded form so /a%2Db and /a-b are treated alike.
    return unquote(value)


def _matches(pattern: str, path: str) -> bool:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = ".*".join(re.escape(_normalise_path(piece)) for piece in body.split("*"))
    return re.match(regex + ("$" if anchored else ""), path) is not None


def product_token(user_agent: str) -> str:
    return user_agent.split("/", 1)[0].strip().lower()


def parse_robots(text: str, user_agent: str) -> RobotsRules:
    token = product_token(user_agent)
    groups: list[_Group] = []
    sitemaps: list[str] = []
    current: _Group | None = None
    last_was_agent = False
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip().lower(), value.strip()
        if key == "sitemap":
            if value:
                sitemaps.append(value)
            continue
        if key == "user-agent":
            if current is None or not last_was_agent:
                current = _Group()
                groups.append(current)
            current.agents.append(value.lower())
            last_was_agent = True
            continue
        last_was_agent = False
        if current is None:
            continue  # rules before any user-agent line are ignored
        if key in ("allow", "disallow"):
            if value:  # empty Disallow means "allow everything"
                current.rules.append((key == "allow", value))
        elif key == "crawl-delay":
            with suppress(ValueError):
                current.crawl_delay = float(value)

    specific = [g for g in groups if token in g.agents]
    chosen = specific or [g for g in groups if "*" in g.agents]
    rules = [rule for g in chosen for rule in g.rules]
    delays = [g.crawl_delay for g in chosen if g.crawl_delay is not None]
    return RobotsRules(
        rules=rules,
        crawl_delay=max(delays) if delays else None,
        sitemaps=list(dict.fromkeys(sitemaps)),
        allow_all=not chosen,
        source_status=200,
    )
