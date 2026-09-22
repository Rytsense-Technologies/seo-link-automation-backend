from __future__ import annotations

import os
from dataclasses import dataclass

import pytest

from app.pages.models import Page
from tests.fakes import FakeInterlinkRepository, make_page

# Keep tests independent of a developer's local .env.
os.environ.setdefault("AI_PROVIDER", "none")

SOURCE_HTML = """<!doctype html>
<html><head><title>Customer support automation</title>
<script>var promo = "AI voice agents";</script>
<style>.x::after { content: "AI voice agents"; }</style></head>
<body>
<nav><a href="/">Home</a> AI voice agents</nav>
<h1>Customer Support Automation</h1>
<p>Businesses can use AI voice agents to automate repetitive customer support interactions.</p>
<p>Our <a href="/chatbots/">chatbot platform</a> handles chat, while a CRM integration keeps
customer records in sync across every tool.</p>
<p>Accurate dental insurance verification reduces claim denials for dental practices.</p>
<footer>AI voice agents &copy; Example</footer>
</body></html>"""


@dataclass
class Site:
    source: Page
    voice: Page
    crm: Page
    dental: Page
    chatbots: Page
    not_found: Page
    server_error: Page
    redirected: Page
    noindex: Page
    spanish: Page
    utility: Page
    canonicalised: Page
    unrelated: Page
    repo: FakeInterlinkRepository


@pytest.fixture
def site() -> Site:
    source = make_page(
        "/customer-support-automation/",
        title="Customer Support Automation",
        h1="Customer Support Automation",
        keywords=["customer support automation", "voice agents", "crm integration"],
        content_html=SOURCE_HTML,
        page_type="service",
    )
    voice = make_page(
        "/ai-voice-agent/",
        title="AI Voice Agent for Customer Support",
        h1="AI Voice Agents",
        keywords=["ai voice agent", "voice ai", "customer support"],
        meta_description="AI voice agents that answer and route customer support calls.",
        content_html="<p>Our AI voice agents answer calls 24/7.</p>",
        page_type="service",
    )
    crm = make_page(
        "/crm-integration/",
        title="CRM Integration Services",
        h1="CRM Integration",
        keywords=["crm integration", "customer records"],
        content_html="<p>Sync customer records between your CRM and support tools.</p>",
    )
    dental = make_page(
        "/dental-insurance-verification/",
        title="Dental Insurance Verification",
        h1="Dental Insurance Verification Automation",
        keywords=["dental insurance verification", "claim denials"],
    )
    chatbots = make_page("/chatbots/", title="Chatbot Platform for customer support")
    not_found = make_page("/old-voice-agent/", title="AI voice agent (old)", http_status=404)
    server_error = make_page("/voice-agent-pricing/", title="Voice agent pricing", http_status=503)
    redirected = make_page(
        "/voice-agents/",
        title="AI voice agents",
        http_status=301,
        redirect_url="https://www.example.com/ai-voice-agent/",
    )
    noindex = make_page("/voice-agent-beta/", title="AI voice agent beta", has_noindex=True)
    spanish = make_page(
        "/es/agentes-de-voz/", title="Agentes de voz con IA voice agents", language="es"
    )
    utility = make_page("/privacy-policy/", title="Privacy policy for customer support data")
    canonicalised = make_page(
        "/blog/voice-ai-agents/",
        title="Voice AI agents explained",
        canonical_url="https://www.example.com/ai-voice-agent/",
    )
    unrelated = make_page("/bakery-recipes/", title="Sourdough bakery recipes")
    pages = [
        source,
        voice,
        crm,
        dental,
        chatbots,
        not_found,
        server_error,
        redirected,
        noindex,
        spanish,
        utility,
        canonicalised,
        unrelated,
    ]
    repo = FakeInterlinkRepository(pages)
    return Site(
        source=source,
        voice=voice,
        crm=crm,
        dental=dental,
        chatbots=chatbots,
        not_found=not_found,
        server_error=server_error,
        redirected=redirected,
        noindex=noindex,
        spanish=spanish,
        utility=utility,
        canonicalised=canonicalised,
        unrelated=unrelated,
        repo=repo,
    )


def ai_item(page: Page, **overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "target_page_id": str(page.id),
        "target_url": page.url.removeprefix("https://www.example.com"),
        "is_relevant": True,
        "relevance_score": 90,
        "reason": "The target page covers this topic.",
        "anchor_text": "anchor",
        "suggested_context": "context",
    }
    item.update(overrides)
    return item


def voice_item(site: Site, **overrides: object) -> dict[str, object]:
    return ai_item(
        site.voice,
        **{
            "relevance_score": 94,
            "reason": "The target page directly covers AI voice agents for customer support.",
            "anchor_text": "AI voice agents",
            "suggested_context": "Businesses can use AI voice agents to automate repetitive "
            "customer support interactions.",
            **overrides,
        },
    )


def crm_item(site: Site, **overrides: object) -> dict[str, object]:
    return ai_item(
        site.crm,
        **{
            "relevance_score": 82,
            "reason": "The target page describes CRM integration for syncing customer records.",
            "anchor_text": "CRM integration",
            "suggested_context": "Our chatbot platform handles chat, while a CRM integration "
            "keeps customer records in sync across every tool.",
            **overrides,
        },
    )
