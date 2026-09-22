from __future__ import annotations

from app.content.html import extract_blocks
from app.interlink.candidate_filter import filter_candidates
from app.interlink.candidate_retriever import LexicalCandidateRetriever
from app.interlink.text_features import tokenize
from tests.conftest import Site
from tests.fakes import default_config, make_page


def _eligible(site: Site) -> list:  # type: ignore[type-arg]
    pool = site.repo.list_candidate_pool(site.source)
    return filter_candidates(site.source, pool, default_config().filters).accepted


def test_retrieval_ranks_topically_related_pages_first(site: Site) -> None:
    text = "\n".join(extract_blocks(site.source.content_html or "", link_contexts_only=True))
    results = LexicalCandidateRetriever().retrieve(site.source, text, _eligible(site), 10)
    urls = [c.page.url for c in results]
    assert urls[0] == site.voice.url
    assert site.crm.url in urls
    assert site.dental.url in urls
    # Unrelated content scores zero and is not returned.
    assert site.unrelated.url not in urls
    assert all(0 < c.score <= 1 for c in results)
    assert results == sorted(results, key=lambda c: -c.score)


def test_retrieval_respects_limit(site: Site) -> None:
    many = [
        make_page(f"/voice-agent-{i}/", title=f"AI voice agent use case {i}") for i in range(30)
    ]
    results = LexicalCandidateRetriever().retrieve(
        site.source, "AI voice agents for customer support", many, 15
    )
    assert len(results) == 15


def test_retrieval_with_no_eligible_pages(site: Site) -> None:
    assert LexicalCandidateRetriever().retrieve(site.source, "anything", [], 10) == []


def test_tokenizer_folds_plurals_and_drops_stopwords() -> None:
    assert tokenize("The AI Voice Agents and companies") == ["ai", "voice", "agent", "company"]
