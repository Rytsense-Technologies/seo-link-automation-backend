"""HTML extraction for crawled pages (BeautifulSoup, stdlib `html.parser` backend)."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Comment, Tag

from app.crawler.html_redirects import HtmlRedirect, detect_html_redirect, is_next_error_shell
from app.crawler.urls import normalize_crawl_url

# Removed from the stored main content: chrome, scripts and non-content widgets.
_STRIP_TAGS = (
    "script", "style", "noscript", "template", "svg", "iframe", "canvas", "form",
    "nav", "header", "footer", "aside", "dialog", "button", "select", "input", "textarea",
    "link", "meta",
)  # fmt: skip
_STRIP_ROLES = {"navigation", "banner", "contentinfo", "search", "dialog", "alert"}
_STRIP_HINT = re.compile(
    r"(^|[\s_-])(cookie|consent|gdpr|newsletter|breadcrumb|skip-link|sr-only|modal|popup)"
    r"([\s_-]|$)",
    re.IGNORECASE,
)
_WS = re.compile(r"\s+")


@dataclass
class ExtractedPage:
    title: str | None
    h1: str | None
    meta_description: str | None
    canonical_url: str | None
    language: str | None
    noindex: bool
    headings: list[tuple[str, str]]  # (tag, text) from the main content
    content_html: str
    content_text: str
    content_hash: str
    keywords: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)  # every <a href> in the document (absolute)
    content_links: list[str] = field(default_factory=list)  # <a href> inside main content
    # Redirect declared inside the HTML (Next.js NEXT_REDIRECT digest or meta refresh).
    # Raw and unvalidated: callers must normalise + scope/SSRF-check before following it.
    html_redirect: HtmlRedirect | None = None
    is_error_shell: bool = False  # Next.js `<html id="__next_error__">` document
    # No usable page content (see `is_unusable`); such pages are not normal content pages.
    is_empty: bool = False


def _text(node: Tag | None) -> str | None:
    if node is None:
        return None
    value = _WS.sub(" ", node.get_text(" ", strip=True)).strip()
    return value or None


def _attr(node: Tag | None, name: str) -> str | None:
    if node is None:
        return None
    value = node.get(name)
    if isinstance(value, list):
        value = " ".join(value)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _meta(soup: BeautifulSoup, name: str) -> str | None:
    node = soup.find("meta", attrs={"name": re.compile(f"^{re.escape(name)}$", re.I)})
    return _attr(node if isinstance(node, Tag) else None, "content")


def _hrefs(root: Tag, base_url: str) -> list[str]:
    urls: list[str] = []
    for anchor in root.find_all("a", href=True):
        if not isinstance(anchor, Tag):
            continue
        href = _attr(anchor, "href")
        if href is None or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
            continue
        rel = (_attr(anchor, "rel") or "").lower()
        if "nofollow" in rel.split():
            continue
        normalised = normalize_crawl_url(href, base_url)
        if normalised:
            urls.append(normalised)
    return list(dict.fromkeys(urls))


def _main_root(soup: BeautifulSoup) -> Tag:
    for selector in ("main", "[role=main]", "article"):
        candidates = [c for c in soup.select(selector) if isinstance(c, Tag)]
        if candidates:
            # The largest candidate is the page body (some layouts nest several <article>s).
            return max(candidates, key=lambda c: len(c.get_text(" ", strip=True)))
    return soup.body if isinstance(soup.body, Tag) else soup


def _strip_chrome(root: Tag) -> None:
    for node in root.find_all(_STRIP_TAGS):
        node.decompose()
    for node in root.find_all(True):
        if not isinstance(node, Tag) or node.decomposed:
            continue
        role = (_attr(node, "role") or "").lower()
        hints = f"{_attr(node, 'id') or ''} {_attr(node, 'class') or ''}"
        hidden = node.has_attr("hidden") or (_attr(node, "aria-hidden") or "") == "true"
        if role in _STRIP_ROLES or hidden or _STRIP_HINT.search(hints):
            node.decompose()


def extract_page(html: str, page_url: str, *, x_robots_tag: str | None = None) -> ExtractedPage:
    soup = BeautifulSoup(html, "html.parser")
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()

    title = _text(soup.title if isinstance(soup.title, Tag) else None)
    canonical_node = soup.find("link", rel=lambda v: bool(v) and "canonical" in str(v).lower())
    canonical_href = _attr(canonical_node if isinstance(canonical_node, Tag) else None, "href")
    canonical = normalize_crawl_url(canonical_href, page_url) if canonical_href else None
    html_node = soup.find("html")
    language = _attr(html_node if isinstance(html_node, Tag) else None, "lang")
    robots_directives = set(
        re.split(r"[\s,]+", " ".join(filter(None, [_meta(soup, "robots"), x_robots_tag])).lower())
    )
    keywords_meta = _meta(soup, "keywords")
    all_links = _hrefs(soup, page_url)
    html_redirect = detect_html_redirect(html, soup)
    error_shell = is_next_error_shell(html)

    root = _main_root(soup)
    first_h1 = soup.find("h1")
    h1 = _text(first_h1 if isinstance(first_h1, Tag) else None)
    _strip_chrome(root)
    headings = [
        (node.name, text)
        for node in root.find_all(["h1", "h2", "h3"])
        if isinstance(node, Tag) and (text := _text(node))
    ]
    content_text = _text(root) or ""
    content_html = root.decode_contents().strip() if root is not soup else str(root)
    return ExtractedPage(
        title=title,
        h1=h1,
        meta_description=_meta(soup, "description"),
        canonical_url=canonical,
        language=language,
        noindex=bool(robots_directives & {"noindex", "none"}),
        headings=headings,
        content_html=content_html,
        content_text=content_text,
        content_hash=hashlib.sha256(content_text.encode("utf-8")).hexdigest(),
        keywords=[k.strip() for k in (keywords_meta or "").split(",") if k.strip()][:50],
        links=all_links,
        content_links=_hrefs(root, page_url),
        html_redirect=html_redirect,
        is_error_shell=error_shell,
        is_empty=is_unusable(
            title=title, h1=h1, content_text=content_text, error_shell=error_shell
        ),
    )


def is_unusable(
    *, title: str | None, h1: str | None, content_text: str, error_shell: bool = False
) -> bool:
    """True when a 2xx HTML page has effectively no usable content.

    A page missing only one of title / H1 / canonical is still valid as long as it has
    something to link to or from; only a page with no title, no H1 and no visible content
    (or a Next.js error shell without visible content) is unusable. Canonical alone never
    makes a page usable.
    """
    has_text = bool(content_text.strip())
    if error_shell:
        return not has_text
    return not has_text and not (title or "").strip() and not (h1 or "").strip()
