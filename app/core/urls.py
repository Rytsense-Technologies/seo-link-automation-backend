"""URL normalisation helpers shared by the page inventory and interlink modules."""

from __future__ import annotations

from urllib.parse import urljoin, urlsplit, urlunsplit

_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_url(url: str, base: str | None = None) -> str | None:
    """Return an absolute, canonical-form URL or None when it is not an http(s) URL.

    Lowercases scheme/host, drops default ports and fragments, keeps the query string.
    """
    raw = url.strip()
    if not raw:
        return None
    if base:
        raw = urljoin(base, raw)
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    host = parts.hostname.lower()
    try:
        port = parts.port
    except ValueError:
        return None
    netloc = host if port in (None, _DEFAULT_PORTS[scheme]) else f"{host}:{port}"
    path = parts.path or "/"
    return urlunsplit((scheme, netloc, path, parts.query, ""))


def url_key(url: str) -> str:
    """Comparison key treating `/a` and `/a/` (and http/https) as the same page."""
    parts = urlsplit(url)
    path = parts.path.rstrip("/") or "/"
    netloc = parts.netloc.removeprefix("www.")
    query = f"?{parts.query}" if parts.query else ""
    return f"{netloc}{path}{query}"


def same_host(url: str, other: str) -> bool:
    a = (urlsplit(url).hostname or "").removeprefix("www.")
    b = (urlsplit(other).hostname or "").removeprefix("www.")
    return bool(a) and a == b


def site_relative(url: str) -> str:
    """Path + query, used as the href for internal links."""
    parts = urlsplit(url)
    return urlunsplit(("", "", parts.path or "/", parts.query, ""))


def url_path(url: str) -> str:
    return urlsplit(url).path or "/"
