"""Detection of redirects that live inside an HTTP 200 HTML document.

- Next.js static export: `redirect()` cannot send a real 3xx, so the exported HTML is an
  error shell (`<html id="__next_error__">`) whose RSC/flight payload carries a digest such as
  `NEXT_REDIRECT;replace;/us/page/;307;` and the browser redirects with JavaScript.
- `<meta http-equiv="refresh" content="0;url=/target/">`.

This module only *reports* the raw target. It never follows anything: callers must pass the
target through `normalize_crawl_url`, the site scope, robots and SSRF validation before use.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from bs4 import BeautifulSoup, Tag

NEXT_REDIRECT = "next_redirect"
META_REFRESH = "meta_refresh"

# `digest":"NEXT_REDIRECT;<type>;<url>;<status|permanent>;` as it appears in the flight data,
# where quotes are usually JSON-escaped (\"). Requiring the `digest` key avoids matching the
# words NEXT_REDIRECT in ordinary article text.
_NEXT_REDIRECT_RE = re.compile(
    r"""digest\\{0,3}["']\s*:\s*\\{0,3}["']"""
    r"NEXT_REDIRECT;(?P<mode>push|replace);(?P<target>[^;\"'<>\s]{1,2048}?);"
    r"(?P<code>\d{3}|true|false)\b"
)
_META_REFRESH_CONTENT_RE = re.compile(
    r"""^\s*(?P<delay>\d+(?:\.\d*)?)?\s*[;,]?\s*(?:url\s*=\s*)?(?P<q>['"]?)(?P<target>.*?)(?P=q)\s*$""",
    re.IGNORECASE | re.DOTALL,
)
_UNSAFE_SCHEMES = ("javascript:", "data:", "vbscript:", "file:", "blob:", "about:")


@dataclass(frozen=True)
class HtmlRedirect:
    target: str  # raw target as written in the page (relative or absolute)
    type: str  # NEXT_REDIRECT | META_REFRESH
    status_code: int | None = None
    mode: str | None = None  # Next.js: push | replace
    delay_seconds: float | None = None  # meta refresh delay

    @property
    def detected(self) -> bool:
        return True

    @property
    def has_unsafe_scheme(self) -> bool:
        return self.target.strip().lower().startswith(_UNSAFE_SCHEMES)


def _unescape(value: str) -> str:
    """Undo JSON string escaping used in the flight payload (\\/ , \\u0026 ...)."""
    try:
        decoded = json.loads(f'"{value}"')
    except ValueError:
        return value.replace("\\/", "/")
    return decoded if isinstance(decoded, str) else value


def detect_next_redirect(html: str) -> HtmlRedirect | None:
    if "NEXT_REDIRECT" not in html:
        return None
    match = _NEXT_REDIRECT_RE.search(html)
    if match is None:
        return None
    code = match.group("code")
    if code == "true":  # Next.js 13: `permanent` flag instead of a status code
        status = 308
    elif code == "false":
        status = 307
    else:
        status = int(code)
    target = _unescape(match.group("target")).strip()
    if not target:
        return None
    return HtmlRedirect(
        target=target, type=NEXT_REDIRECT, status_code=status, mode=match.group("mode")
    )


def detect_meta_refresh(soup: BeautifulSoup) -> HtmlRedirect | None:
    for meta in soup.find_all("meta"):
        if not isinstance(meta, Tag):
            continue
        equiv = meta.get("http-equiv")
        if not isinstance(equiv, str) or equiv.strip().lower() != "refresh":
            continue
        if meta.find_parent("noscript") is not None:
            continue  # only applies when JavaScript is disabled
        content = meta.get("content")
        if not isinstance(content, str):
            continue
        match = _META_REFRESH_CONTENT_RE.match(content)
        if match is None:
            continue
        target = match.group("target").strip()
        if not target:
            continue  # plain refresh of the same page, not a redirect
        delay = float(match.group("delay")) if match.group("delay") else 0.0
        return HtmlRedirect(target=target, type=META_REFRESH, delay_seconds=delay)
    return None


def detect_html_redirect(html: str, soup: BeautifulSoup | None = None) -> HtmlRedirect | None:
    """Return the first HTML-level redirect instruction found, or None."""
    found = detect_next_redirect(html)
    if found is not None:
        return found
    return detect_meta_refresh(soup if soup is not None else BeautifulSoup(html, "html.parser"))


def is_next_error_shell(html: str) -> bool:
    return re.search(r"<html\b[^>]*\bid\s*=\s*[\"']?__next_error__", html[:2000], re.I) is not None
