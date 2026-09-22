from __future__ import annotations

from app.crawler.extract import extract_page

URL = "https://example.com/services/ai-voice-agent/"

PAGE = """<!doctype html>
<html lang="en-US"><head>
<title> AI Voice Agent | Example </title>
<meta name="description" content="AI voice agents for customer support.">
<meta name="keywords" content="voice ai, call automation">
<link rel="canonical" href="/services/ai-voice-agent/?utm_source=x">
<script>var x = "tracking script text";</script>
<style>.hero { color: red }</style>
</head><body>
<header><nav><a href="/">Home</a><a href="/contact/">Contact</a></nav></header>
<div class="cookie-banner">We use cookies</div>
<main>
  <h1>AI Voice Agents</h1>
  <p>Our <a href="/services/crm-integration/">CRM integration</a> connects calls.</p>
  <!-- hidden comment text -->
  <h2>How it works</h2>
  <p>Agents answer calls <a href="mailto:a@b.c">email</a> <a href="tel:1">call</a>
     <a href="javascript:void(0)">js</a> <a href="https://twitter.com/x">tw</a>
     <a href="/pricing/" rel="nofollow">pricing</a>.</p>
  <aside>Related sidebar</aside>
  <form><input name="q"><button>Search</button></form>
  <script>inline main script</script>
</main>
<footer><a href="/privacy-policy/">Privacy</a> Footer text</footer>
</body></html>"""


def test_extracts_metadata() -> None:
    page = extract_page(PAGE, URL)
    assert page.title == "AI Voice Agent | Example"
    assert page.h1 == "AI Voice Agents"
    assert page.meta_description == "AI voice agents for customer support."
    assert page.canonical_url == URL  # normalised: utm removed, made absolute
    assert page.language == "en-US"
    assert page.keywords == ["voice ai", "call automation"]
    assert page.noindex is False
    assert page.headings == [("h1", "AI Voice Agents"), ("h2", "How it works")]


def test_main_content_excludes_chrome_scripts_and_widgets() -> None:
    page = extract_page(PAGE, URL)
    for unwanted in (
        "tracking script",
        "color: red",
        "Home",
        "We use cookies",
        "Footer text",
        "Related sidebar",
        "Search",
        "inline main script",
        "hidden comment",
    ):
        assert unwanted not in page.content_text, unwanted
        assert unwanted not in page.content_html, unwanted
    assert "Our CRM integration connects calls." in page.content_text
    assert '<a href="/services/crm-integration/">CRM integration</a>' in page.content_html
    assert len(page.content_hash) == 64


def test_links_all_vs_content() -> None:
    page = extract_page(PAGE, URL)
    assert "https://example.com/contact/" in page.links  # nav links used for discovery
    assert "https://example.com/privacy-policy/" in page.links
    assert "https://twitter.com/x" in page.links  # external: filtered later by scope
    assert not any(u.startswith(("mailto:", "tel:", "javascript:")) for u in page.links)
    assert "https://example.com/pricing/" not in page.links  # rel=nofollow
    assert page.content_links == [
        "https://example.com/services/crm-integration/",
        "https://twitter.com/x",
    ]


def test_noindex_from_meta_or_header() -> None:
    meta = PAGE.replace("<title>", '<meta name="robots" content="noindex, follow"><title>')
    assert extract_page(meta, URL).noindex
    assert extract_page(
        PAGE.replace("<title>", '<meta name="ROBOTS" content="none"><title>'), URL
    ).noindex
    assert extract_page(PAGE, URL, x_robots_tag="noindex").noindex
    assert not extract_page(PAGE, URL, x_robots_tag="nofollow").noindex


def test_falls_back_to_body_and_handles_minimal_pages() -> None:
    page = extract_page(
        "<html><body><nav>menu</nav><p>Body copy only.</p><footer>f</footer></body></html>", URL
    )
    assert page.content_text == "Body copy only."
    assert page.title is None and page.h1 is None and page.canonical_url is None
    empty = extract_page("", URL)
    assert empty.content_text == ""
