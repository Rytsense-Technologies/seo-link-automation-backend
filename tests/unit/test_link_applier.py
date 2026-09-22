"""Safe link application: context scoping, existing-link detection, unsafe HTML."""

from __future__ import annotations

import pytest

from app.content.html import extract_blocks, parse_html
from app.interlink.link_applier import LinkApplicationError, apply_link, contains_link_to

PAGE = "https://www.example.com/source/"
TARGET = "https://www.example.com/ai-voice-agent/"


def _apply(content: str, anchor: str = "AI voice agents", context: str | None = None) -> str:
    return apply_link(
        content,
        page_url=PAGE,
        target_url=TARGET,
        href="/ai-voice-agent/",
        anchor_text=anchor,
        context=context or "Businesses can use AI voice agents to automate support.",
    ).content


def _error(content: str, **kwargs: str) -> str:
    with pytest.raises(LinkApplicationError) as exc:
        _apply(content, **kwargs)
    return exc.value.code


def test_links_only_the_occurrence_inside_the_context() -> None:
    html = (
        "<p>AI voice agents are popular.</p>\n"
        "<p>Businesses can use AI voice agents to automate support.</p>\n"
        "<p>More AI voice agents.</p>"
    )
    result = _apply(html)
    assert result == (
        "<p>AI voice agents are popular.</p>\n"
        '<p>Businesses can use <a href="/ai-voice-agent/">AI voice agents</a> to automate '
        "support.</p>\n"
        "<p>More AI voice agents.</p>"
    )
    assert result.count("<a ") == 1


def test_preserves_original_formatting_and_casing() -> None:
    html = (
        '<div class="x">\n  <p>Businesses   can use ai Voice AGENTS\n'
        " to automate support.</p>\n</div>"
    )
    result = _apply(html)
    assert '<a href="/ai-voice-agent/">ai Voice AGENTS</a>' in result
    assert result.replace('<a href="/ai-voice-agent/">', "").replace("</a>", "") == html


def test_handles_entities_and_inline_markup_in_context() -> None:
    html = "<p>Businesses can use <strong>AI voice agents</strong> to automate&nbsp;support.</p>"
    result = _apply(html)
    assert '<strong><a href="/ai-voice-agent/">AI voice agents</a></strong>' in result


def test_already_linked_detection() -> None:
    html = (
        "<p>Businesses can use AI voice agents to automate support. "
        '<a href="/ai-voice-agent">x</a></p>'
    )
    assert contains_link_to(html, PAGE, TARGET)
    assert _error(html) == "ALREADY_LINKED"
    absolute = '<p><a href="https://example.com/ai-voice-agent/#pricing">y</a></p>'
    assert contains_link_to(absolute, PAGE, TARGET)


def test_never_nests_links() -> None:
    html = '<p>Businesses can use <a href="/other/">AI voice agents</a> to automate support.</p>'
    assert _error(html) == "ANCHOR_IN_UNSAFE_ELEMENT"


def test_skips_occurrence_inside_link_and_uses_safe_one_in_same_context() -> None:
    html = (
        '<p>Businesses can use <a href="/x/">AI voice agents</a> and AI voice agents '
        "to automate support.</p>"
    )
    result = _apply(
        html, context="Businesses can use AI voice agents and AI voice agents to automate support."
    )
    assert (
        '<a href="/x/">AI voice agents</a> and <a href="/ai-voice-agent/">AI voice agents</a>'
        in result
    )


@pytest.mark.parametrize(
    "wrapper",
    [
        "<script>{}</script>",
        "<style>{}</style>",
        "<h2>{}</h2>",
        "<nav><p>{}</p></nav>",
        "<footer><p>{}</p></footer>",
        "<pre>{}</pre>",
        "<button>{}</button>",
        "<textarea>{}</textarea>",
        "<!-- {} -->",
    ],
)
def test_never_links_inside_unsafe_elements(wrapper: str) -> None:
    sentence = "Businesses can use AI voice agents to automate support."
    code = _error(wrapper.format(sentence))
    assert code in {"CONTEXT_NOT_FOUND", "ANCHOR_IN_UNSAFE_ELEMENT"}


def test_anchor_spanning_tags_is_rejected() -> None:
    html = "<p>Businesses can use AI <em>voice</em> agents to automate support.</p>"
    assert _error(html) == "ANCHOR_IN_UNSAFE_ELEMENT"


def test_context_missing_or_anchor_missing() -> None:
    assert _error("<p>Completely different text.</p>") == "CONTEXT_NOT_FOUND"
    html = "<p>Businesses can use AI voice agents to automate support.</p>"
    assert _error(html, anchor="chat bots") == "ANCHOR_NOT_FOUND"
    assert _error("   ") == "SOURCE_CONTENT_EMPTY"


def test_does_not_match_partial_words() -> None:
    html = "<p>Businesses can use AI voice agents to automate support.</p>"
    assert _error(html, anchor="AI voice agent") == "ANCHOR_NOT_FOUND"


def test_href_is_escaped() -> None:
    html = "<p>Businesses can use AI voice agents to automate support.</p>"
    result = apply_link(
        html,
        page_url=PAGE,
        target_url=TARGET,
        href='/a?x=1&y="2"',
        anchor_text="AI voice agents",
        context="Businesses can use AI voice agents to automate support.",
    ).content
    assert '<a href="/a?x=1&amp;y=&quot;2&quot;">' in result


def test_parser_tracks_blocks_and_invisible_text() -> None:
    html = (
        "<head><title>T</title></head><body><h1>Head</h1><p>One <b>two</b></p>"
        "<script>if (a < b) { x = '</p>' }</script><p>Three</p></body>"
    )
    assert extract_blocks(html) == ["Head", "One two", "Three"]
    assert extract_blocks(html, link_contexts_only=True) == ["One two", "Three"]
    anchors = parse_html('<a href="/x">x</a><a name="y">y</a>').anchors
    assert [a.href for a in anchors] == ["/x"]
