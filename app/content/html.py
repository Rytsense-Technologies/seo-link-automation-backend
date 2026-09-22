"""Position-preserving HTML tokenizer.

We deliberately avoid DOM round-tripping (parse -> serialise) so applying a link never
reformats the rest of the document: every text node keeps its exact raw offsets in the
original string, and edits are splices at those offsets.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

# Elements whose content is raw text (no nested tags).
RAW_TEXT_ELEMENTS = frozenset({"script", "style", "textarea", "title", "xmp", "iframe", "noscript"})
VOID_ELEMENTS = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr",
    }
)  # fmt: skip
BLOCK_ELEMENTS = frozenset(
    {
        "address", "article", "aside", "blockquote", "body", "caption", "dd", "details",
        "div", "dl", "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "html", "li", "main", "nav", "ol", "p", "pre",
        "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    }
)  # fmt: skip
# Text inside these elements must never receive an inserted link.
UNLINKABLE_ELEMENTS = frozenset(
    {
        "a", "button", "code", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "head",
        "header", "iframe", "kbd", "label", "math", "nav", "noscript", "option", "pre",
        "samp", "script", "select", "style", "svg", "template", "textarea", "title", "xmp",
    }
)  # fmt: skip
INLINE_UNLINKABLE_ELEMENTS = frozenset({"a", "code", "kbd", "samp", "button", "label"})
# Text inside these elements is not visible page copy.
INVISIBLE_ELEMENTS = frozenset(
    {"head", "script", "style", "template", "noscript", "title", "svg", "math", "iframe", "xmp"}
)

_TAG_RE = re.compile(
    r"""<!--.*?-->"""  # comment
    r"""|<!\[CDATA\[.*?\]\]>"""
    r"""|<![^>]*>"""  # doctype
    r"""|<\?.*?\?>"""  # processing instruction
    r"""|</?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*/?>""",
    re.DOTALL,
)
_TAG_NAME_RE = re.compile(r"</?([a-zA-Z][a-zA-Z0-9:-]*)")
_HREF_RE = re.compile(r"""\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""", re.IGNORECASE)
_ENTITY_RE = re.compile(r"&(?:#[0-9]+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)")


@dataclass
class TextNode:
    raw_start: int
    raw_end: int
    raw: str
    ancestors: tuple[str, ...]
    block_id: int
    text: str = field(init=False)
    # decoded index -> raw offset (relative to raw_start); len == len(text) + 1
    _offsets: list[int] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.text, self._offsets = _decode_with_offsets(self.raw)

    @property
    def linkable(self) -> bool:
        return not any(a in UNLINKABLE_ELEMENTS for a in self.ancestors)

    @property
    def visible(self) -> bool:
        return not any(a in INVISIBLE_ELEMENTS for a in self.ancestors)

    @property
    def in_link_context(self) -> bool:
        """Text belonging to body copy that may host a link somewhere in its sentence.

        Existing inline links/code are part of the sentence text, but headings, navigation,
        headers/footers etc. are not link contexts at all.
        """
        return self.visible and all(
            a in INLINE_UNLINKABLE_ELEMENTS for a in self.ancestors if a in UNLINKABLE_ELEMENTS
        )

    def raw_offset(self, decoded_index: int) -> int:
        return self.raw_start + self._offsets[decoded_index]


@dataclass
class AnchorTag:
    href: str
    raw_start: int


@dataclass
class ParsedHTML:
    source: str
    text_nodes: list[TextNode]
    anchors: list[AnchorTag]


def _decode_with_offsets(raw: str) -> tuple[str, list[int]]:
    out: list[str] = []
    offsets: list[int] = []
    pos = 0
    for m in _ENTITY_RE.finditer(raw):
        for i in range(pos, m.start()):
            out.append(raw[i])
            offsets.append(i)
        decoded = html.unescape(m.group(0))
        for ch in decoded:
            out.append(ch)
            offsets.append(m.start())
        pos = m.end()
    for i in range(pos, len(raw)):
        out.append(raw[i])
        offsets.append(i)
    offsets.append(len(raw))
    # Offsets for decoded chars that belong to one entity all point at the entity start;
    # the end offset of a span is computed from the *next* char, so spans never split an entity.
    return "".join(out), offsets


def parse_html(source: str) -> ParsedHTML:
    text_nodes: list[TextNode] = []
    anchors: list[AnchorTag] = []
    stack: list[tuple[str, int]] = []  # (tag name, block id)
    block_counter = 0
    pos = 0
    n = len(source)

    def current_block() -> int:
        return stack[-1][1] if stack else 0

    def add_text(start: int, end: int) -> None:
        if end > start:
            text_nodes.append(
                TextNode(
                    raw_start=start,
                    raw_end=end,
                    raw=source[start:end],
                    ancestors=tuple(name for name, _ in stack),
                    block_id=current_block(),
                )
            )

    while pos < n:
        m = _TAG_RE.search(source, pos)
        if m is None:
            add_text(pos, n)
            break
        add_text(pos, m.start())
        token = m.group(0)
        pos = m.end()
        name_match = _TAG_NAME_RE.match(token)
        if name_match is None:  # comment / doctype / PI
            continue
        name = name_match.group(1).lower()
        if token.startswith("</"):
            # Pop to the matching open element, tolerating mis-nested markup.
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == name:
                    del stack[i:]
                    break
            continue
        self_closing = token.endswith("/>")
        if name == "a":
            href = _HREF_RE.search(token)
            if href:
                value = next(g for g in href.groups() if g is not None)
                anchors.append(AnchorTag(href=html.unescape(value), raw_start=m.start()))
            # An <a> opening while another is open implicitly closes it (HTML parsing rules).
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == "a":
                    del stack[i:]
                    break
        if name == "p":
            # <p> implicitly closes an open <p>.
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == "p":
                    del stack[i:]
                    break
                if stack[i][0] in BLOCK_ELEMENTS:
                    break
        if name in VOID_ELEMENTS or self_closing:
            continue
        if name in BLOCK_ELEMENTS:
            block_counter += 1
            block = block_counter
        else:
            block = current_block()
        stack.append((name, block))
        if name in RAW_TEXT_ELEMENTS:
            close = re.compile(rf"</{name}\s*>", re.IGNORECASE).search(source, pos)
            end = close.start() if close else n
            add_text(pos, end)
            stack.pop()
            pos = close.end() if close else n

    return ParsedHTML(source=source, text_nodes=text_nodes, anchors=anchors)


def extract_links(source: str, base_url: str) -> list[str]:
    """Return absolute, normalised hrefs of all <a> elements."""
    from app.core.urls import normalize_url

    links: list[str] = []
    for anchor in parse_html(source).anchors:
        normalised = normalize_url(anchor.href, base_url)
        if normalised:
            links.append(normalised)
    return links


def extract_blocks(source: str, *, link_contexts_only: bool = False) -> list[str]:
    """Visible text grouped per block element, whitespace-collapsed.

    With ``link_contexts_only`` only body-copy blocks that may host a new link are returned.
    """
    parsed = parse_html(source)
    blocks: dict[int, list[str]] = {}
    for node in parsed.text_nodes:
        if not node.visible or (link_contexts_only and not node.in_link_context):
            continue
        blocks.setdefault(node.block_id, []).append(node.text)
    result = []
    for parts in blocks.values():
        text = collapse_whitespace("".join(parts))
        if text:
            result.append(text)
    return result


def extract_text(source: str) -> str:
    return "\n".join(extract_blocks(source))


def collapse_whitespace(value: str) -> str:
    return " ".join(value.split())
