"""Safe, context-scoped insertion of a single internal link into HTML content.

Guarantees:
- Only the first occurrence of the anchor *inside the approved context sentence* is linked;
  no global keyword replacement.
- Never links text inside <a>, headings, nav/header/footer, code/pre, script/style, form
  controls, SVG, etc. (see `UNLINKABLE_ELEMENTS`), so nested links are impossible.
- The anchor must lie within a single text node (never spans existing tags).
- The rest of the document is byte-for-byte unchanged (offset splice, no re-serialisation).
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from app.content.html import TextNode, parse_html
from app.core.exceptions import UnprocessableError
from app.core.urls import normalize_url, url_key
from app.interlink.anchor_rules import QUOTE_MAP, normalize_for_match


class LinkApplicationError(UnprocessableError):
    code = "LINK_APPLICATION_FAILED"


@dataclass(frozen=True)
class AppliedLink:
    content: str
    raw_start: int
    raw_end: int
    anchor_text: str  # anchor as it appears in the content (original casing)


def contains_link_to(content: str, page_url: str, target_url: str) -> bool:
    target = url_key(target_url)
    for anchor in parse_html(content).anchors:
        href = normalize_url(anchor.href, page_url)
        if href is not None and url_key(href) == target:
            return True
    return False


def _normalised_block(nodes: list[TextNode]) -> tuple[str, list[tuple[int, int]]]:
    """Normalised text of a block (as `normalize_for_match` would produce) + a char map.

    mapping[i] = (node index, char index in node.text) for normalised char i.
    """
    chars: list[str] = []
    mapping: list[tuple[int, int]] = []
    prev_space = True
    for ni, node in enumerate(nodes):
        for ci, ch in enumerate(node.text):
            if ch.isspace():
                if prev_space:
                    continue
                chars.append(" ")
                mapping.append((ni, ci))
                prev_space = True
                continue
            for folded in ch.translate(QUOTE_MAP).casefold():
                chars.append(folded)
                mapping.append((ni, ci))
            prev_space = False
    return "".join(chars), mapping


def apply_link(
    content: str,
    *,
    page_url: str,
    target_url: str,
    href: str,
    anchor_text: str,
    context: str,
) -> AppliedLink:
    if not content or not content.strip():
        raise LinkApplicationError("Source page has no content", code="SOURCE_CONTENT_EMPTY")
    if contains_link_to(content, page_url, target_url):
        raise LinkApplicationError("Source page already links to the target", code="ALREADY_LINKED")
    norm_context = normalize_for_match(context)
    norm_anchor = normalize_for_match(anchor_text)
    if not norm_context or not norm_anchor:
        raise LinkApplicationError("Anchor text and context are required", code="INVALID_INPUT")

    parsed = parse_html(content)
    blocks: dict[int, list[TextNode]] = {}
    for node in parsed.text_nodes:
        if node.in_link_context:
            blocks.setdefault(node.block_id, []).append(node)

    anchor_re = re.compile(rf"(?<![^\W_]){re.escape(norm_anchor)}(?![^\W_])")
    context_found = False
    anchor_blocked = False
    for nodes in blocks.values():
        text, mapping = _normalised_block(nodes)
        start = text.find(norm_context)
        while start >= 0:
            context_found = True
            end = start + len(norm_context)
            for match in anchor_re.finditer(text, start, end):
                first_node, first_char = mapping[match.start()]
                last_node, last_char = mapping[match.end() - 1]
                node = nodes[first_node]
                if first_node != last_node or not node.linkable:
                    anchor_blocked = True
                    continue
                raw_start = node.raw_offset(first_char)
                raw_end = node.raw_offset(last_char + 1)
                open_tag = f'<a href="{html.escape(href, quote=True)}">'
                new_content = (
                    content[:raw_start] + open_tag + content[raw_start:raw_end] + "</a>"
                    + content[raw_end:]
                )  # fmt: skip
                return AppliedLink(
                    content=new_content,
                    raw_start=raw_start,
                    raw_end=raw_end + len(open_tag) + len("</a>"),
                    anchor_text=html.unescape(content[raw_start:raw_end]),
                )
            start = text.find(norm_context, start + 1)

    if not context_found:
        raise LinkApplicationError(
            "The suggested context no longer exists in linkable source content",
            code="CONTEXT_NOT_FOUND",
        )
    if anchor_blocked:
        raise LinkApplicationError(
            "The anchor text only occurs inside an existing link or unsafe element",
            code="ANCHOR_IN_UNSAFE_ELEMENT",
        )
    raise LinkApplicationError(
        "The anchor text was not found within the suggested context", code="ANCHOR_NOT_FOUND"
    )
