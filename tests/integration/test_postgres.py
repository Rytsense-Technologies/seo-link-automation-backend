"""PostgreSQL integration tests.

Run with a *dedicated, disposable* database (it is migrated up and down):

    export TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/seo_link_test
    pytest -m postgres
"""

from __future__ import annotations

import argparse
import os
import uuid
from collections.abc import Iterator

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from dotenv import dotenv_values
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from alembic import command
from app.content.store import DatabaseContentStore
from app.core.exceptions import ConflictError
from app.db.models import Base
from app.db.session import get_db
from app.interlink import dependencies as interlink_deps
from app.interlink.models import InternalLinkSuggestion, SuggestionStatus
from app.interlink.repository import SqlAlchemyInterlinkRepository, SuggestionFilters
from app.main import create_app
from app.pages.models import Page
from app.pages.schemas import PageUpsert, SiteCreate
from app.pages.service import PageService
from tests.conftest import SOURCE_HTML
from tests.fakes import FakeAIProvider

# Read only TEST_DATABASE_URL from .env; load_dotenv() would leak every .env value
# (AI_MODEL, AI_PROVIDER, ...) into os.environ for the whole test session.
DB_URL = os.environ.get("TEST_DATABASE_URL") or dotenv_values(".env").get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not DB_URL, reason="TEST_DATABASE_URL not set"),
]
CONTEXT = "Businesses can use AI voice agents to automate repetitive customer support interactions."


def _alembic_config() -> Config:
    cfg = Config("alembic.ini")
    cfg.cmd_opts = argparse.Namespace(x=[f"db_url={DB_URL}"])  # type: ignore[attr-defined]
    return cfg


@pytest.fixture(scope="module")
def engine() -> Iterator[Engine]:
    assert DB_URL
    cfg = _alembic_config()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    eng = create_engine(DB_URL)
    yield eng
    eng.dispose()
    command.downgrade(cfg, "base")


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE internal_link_suggestions, pages, sites CASCADE"))
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as s:
        yield s


def _seed(session: Session) -> tuple[uuid.UUID, dict[str, uuid.UUID]]:
    service = PageService(session)
    site = service.create_site(
        SiteCreate(name="Example", base_url="https://www.example.com", default_language="en")  # type: ignore[arg-type]
    )
    pages = [
        PageUpsert(
            url="/customer-support-automation/",
            title="Customer Support Automation",
            h1="Customer Support Automation",
            keywords=["customer support automation", "voice agents"],
            content_html=SOURCE_HTML,
        ),
        PageUpsert(
            url="/ai-voice-agent/",
            title="AI Voice Agent for Customer Support",
            h1="AI Voice Agents",
            keywords=["ai voice agent"],
            content_html="<p>Our AI voice agents answer calls.</p>",
        ),
        PageUpsert(url="/chatbots/", title="Chatbot platform"),
        PageUpsert(url="/old/", title="AI voice agents old", http_status=404),
        PageUpsert(url="/beta/", title="AI voice agents beta", has_noindex=True),
    ]
    ids = service.upsert_pages(site.id, pages)
    urls = [p.url for p in pages]
    return site.id, dict(zip(urls, ids, strict=True))


def test_migration_matches_models(engine: Engine) -> None:
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == []
    insp = inspect(engine)
    indexes = {i["name"]: i for i in insp.get_indexes("internal_link_suggestions")}
    active = indexes["uq_internal_link_suggestions_active_pair"]
    assert active["unique"]
    assert "PENDING" in str(active.get("dialect_options", {}).get("postgresql_where"))


def test_page_upsert_updates_and_versions(session: Session) -> None:
    site_id, ids = _seed(session)
    source = session.get(Page, ids["/customer-support-automation/"])
    assert source is not None
    assert source.outgoing_links == [
        "https://www.example.com/",
        "https://www.example.com/chatbots/",
    ]
    assert source.language == "en"

    service = PageService(session)
    service.upsert_pages(
        site_id, [PageUpsert(url="/ai-voice-agent/", title="New title", content_html="<p>x</p>")]
    )
    service.upsert_pages(
        site_id, [PageUpsert(url="/ai-voice-agent/", title="New title", content_html="<p>x</p>")]
    )
    session.expire_all()
    voice = session.get(Page, ids["/ai-voice-agent/"])
    assert voice is not None
    assert voice.title == "New title"
    assert voice.content_version == 2  # bumped once: only the first upsert changed content


def test_active_pair_unique_index_and_check_constraints(session: Session) -> None:
    site_id, ids = _seed(session)
    repo = SqlAlchemyInterlinkRepository(session)

    def make(status: SuggestionStatus, score: int = 90) -> InternalLinkSuggestion:
        return InternalLinkSuggestion(
            id=uuid.uuid4(),
            site_id=site_id,
            source_page_id=ids["/customer-support-automation/"],
            target_page_id=ids["/ai-voice-agent/"],
            anchor_text="AI voice agents",
            context=CONTEXT,
            relevance_score=score,
            reason="r",
            status=status,
        )

    assert repo.add_suggestion(make(SuggestionStatus.REJECTED))
    assert repo.add_suggestion(make(SuggestionStatus.REJECTED))  # rejected rows don't collide
    assert repo.add_suggestion(make(SuggestionStatus.PENDING))
    assert not repo.add_suggestion(make(SuggestionStatus.APPROVED))  # active duplicate
    repo.commit()
    assert repo.active_target_ids(ids["/customer-support-automation/"]) == {ids["/ai-voice-agent/"]}

    # Re-approving an old rejected suggestion while one is active -> ConflictError at commit.
    rejected_items, total = repo.list_suggestions(
        SuggestionFilters(status=SuggestionStatus.REJECTED), offset=0, limit=10
    )
    assert total == 2
    rejected = rejected_items[0]
    rejected.status = SuggestionStatus.APPROVED
    with pytest.raises(ConflictError):
        repo.commit()

    with pytest.raises(IntegrityError):
        repo.add_suggestion(make(SuggestionStatus.REJECTED, score=101))
    session.rollback()


def test_content_store_optimistic_locking(session: Session) -> None:
    _, ids = _seed(session)
    store = DatabaseContentStore(session)
    page = session.get(Page, ids["/ai-voice-agent/"])
    assert page is not None
    store.save_content(page, '<p>See <a href="/chatbots/">bots</a></p>', expected_version=1)
    session.commit()
    assert page.content_version == 2
    assert page.outgoing_links == ["https://www.example.com/chatbots/"]
    with pytest.raises(ConflictError):
        store.save_content(page, "<p>stale</p>", expected_version=1)


def test_end_to_end_http_flow(
    session: Session, engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, ids = _seed(session)
    voice_id = ids["/ai-voice-agent/"]
    provider = FakeAIProvider(
        {
            "suggestions": [
                {
                    "target_page_id": str(voice_id),
                    "target_url": "/ai-voice-agent/",
                    "relevance_score": 94,
                    "reason": "Directly covers AI voice agents for support.",
                    "anchor_text": "AI voice agents",
                    "suggested_context": CONTEXT,
                }
            ]
        }
    )
    monkeypatch.setattr(interlink_deps, "get_ai_provider", lambda: provider)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def db() -> Iterator[Session]:
        with factory() as s:
            yield s

    app = create_app()
    app.dependency_overrides[get_db] = db
    source_id = str(ids["/customer-support-automation/"])
    with TestClient(app) as client:
        res = client.post("/api/interlink/analyze", json={"source_page_id": source_id})
        assert res.status_code == 200, res.text
        body = res.json()
        # Only the eligible page reached the AI (404/noindex/already-linked were filtered).
        assert body["candidates_retrieved"] == 1
        [suggestion] = body["suggestions"]
        sid = suggestion["id"]

        again = client.post("/api/interlink/analyze", json={"source_page_id": source_id}).json()
        assert again["suggestions"] == []

        listed = client.get("/api/interlink/suggestions", params={"status": "PENDING"}).json()
        assert listed["total"] == 1

        assert client.post(f"/api/interlink/suggestions/{sid}/apply").status_code == 409
        assert (
            client.post(f"/api/interlink/suggestions/{sid}/approve").json()["status"] == "APPROVED"
        )
        applied = client.post(f"/api/interlink/suggestions/{sid}/apply")
        assert applied.status_code == 200, applied.text
        assert applied.json()["status"] == "APPLIED"

        page = client.get(f"/api/pages/{source_id}").json()
        assert page["content_html"].count('<a href="/ai-voice-agent/">AI voice agents</a>') == 1
        assert page["content_version"] == 2
        assert "https://www.example.com/ai-voice-agent/" in page["outgoing_links"]

        assert client.post(f"/api/interlink/suggestions/{sid}/apply").status_code == 409
        assert client.get("/health/db").status_code in (200, 503)


# ---------------------------------------------------------------------------
# Regression: GET /api/interlink/suggestions must return persisted suggestions
# (status / site_id / source_page_id / target_page_id / min_relevance_score / paging).


@pytest.fixture
def listed_suggestions(
    session: Session, engine: Engine
) -> Iterator[tuple[TestClient, dict[str, uuid.UUID]]]:
    site_id, ids = _seed(session)
    other_site = PageService(session).create_site(
        SiteCreate(name="Other", base_url="https://other.example.org")  # type: ignore[arg-type]
    )
    other_ids = PageService(session).upsert_pages(
        other_site.id, [PageUpsert(url="/a/", title="A"), PageUpsert(url="/b/", title="B")]
    )
    source, voice, chatbots = (
        ids["/customer-support-automation/"],
        ids["/ai-voice-agent/"],
        ids["/chatbots/"],
    )

    def make(site: uuid.UUID, src: uuid.UUID, tgt: uuid.UUID, status: SuggestionStatus, score: int):
        return InternalLinkSuggestion(
            id=uuid.uuid4(),
            site_id=site,
            source_page_id=src,
            target_page_id=tgt,
            anchor_text="voice agents",
            context=CONTEXT,
            relevance_score=score,
            reason="r",
            status=status,
            ai_provider="gemini",
            ai_model="gemini-test",
        )

    rows = {
        # Mirrors the reported record: PENDING, score 88, source -> AI Voice Agent.
        "pending": make(site_id, source, voice, SuggestionStatus.PENDING, 88),
        "approved_low": make(site_id, source, chatbots, SuggestionStatus.APPROVED, 72),
        "rejected": make(site_id, voice, source, SuggestionStatus.REJECTED, 95),
        "other_site": make(other_site.id, other_ids[0], other_ids[1], SuggestionStatus.PENDING, 90),
    }
    # Persist with one session and commit, then read through separate request sessions
    # (same pattern as analyze -> list in production).
    session.add_all(rows.values())
    session.commit()

    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def db() -> Iterator[Session]:
        with factory() as s:
            yield s

    app = create_app()
    app.dependency_overrides[get_db] = db
    ids_out = {k: v.id for k, v in rows.items()}
    ids_out |= {"site": site_id, "source": source, "voice": voice, "chatbots": chatbots}
    with TestClient(app) as client:
        yield client, ids_out


def _list_ids(client: TestClient, **params: object) -> tuple[set[str], dict[str, object]]:
    res = client.get("/api/interlink/suggestions", params=params)
    assert res.status_code == 200, res.text
    body = res.json()
    return {item["id"] for item in body["items"]}, body


def test_list_status_pending_returns_persisted_suggestion(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, body = _list_ids(client, status="PENDING")
    assert found == {str(ids["pending"]), str(ids["other_site"])}
    assert body["total"] == 2
    item = next(i for i in body["items"] if i["id"] == str(ids["pending"]))  # type: ignore[attr-defined]
    assert item["status"] == "PENDING"
    assert item["relevance_score"] == 88
    assert item["anchor_text"] == "voice agents"
    # The detail endpoint and the list agree on the same record.
    detail = client.get(f"/api/interlink/suggestions/{ids['pending']}").json()
    assert detail["id"] == item["id"] and detail["status"] == item["status"]


def test_list_without_filters_returns_all(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, body = _list_ids(client)
    assert str(ids["pending"]) in found
    assert body["total"] == 4 and len(found) == 4
    for status, key in [("APPROVED", "approved_low"), ("REJECTED", "rejected")]:
        assert _list_ids(client, status=status)[0] == {str(ids[key])}
    assert _list_ids(client, status="APPLIED")[1]["total"] == 0


def test_list_filters_by_site_id(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, _ = _list_ids(client, site_id=str(ids["site"]))
    assert found == {str(ids["pending"]), str(ids["approved_low"]), str(ids["rejected"])}
    found, _ = _list_ids(client, site_id=str(ids["site"]), status="PENDING")
    assert found == {str(ids["pending"])}
    assert _list_ids(client, site_id=str(uuid.uuid4()))[1]["total"] == 0


def test_list_filters_by_source_page_id(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, _ = _list_ids(client, source_page_id=str(ids["source"]))
    assert found == {str(ids["pending"]), str(ids["approved_low"])}
    found, _ = _list_ids(client, source_page_id=str(ids["voice"]))
    assert found == {str(ids["rejected"])}


def test_list_filters_by_target_page_id(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, _ = _list_ids(client, target_page_id=str(ids["voice"]))
    assert found == {str(ids["pending"])}
    found, _ = _list_ids(client, target_page_id=str(ids["chatbots"]), status="PENDING")
    assert found == set()


def test_list_filters_by_min_relevance_score(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, ids = listed_suggestions
    found, _ = _list_ids(client, min_relevance_score=80)
    assert found == {str(ids["pending"]), str(ids["rejected"]), str(ids["other_site"])}
    found, _ = _list_ids(client, min_relevance_score=88, status="PENDING")
    assert found == {str(ids["pending"]), str(ids["other_site"])}
    found, _ = _list_ids(client, min_relevance_score=89, site_id=str(ids["site"]), status="PENDING")
    assert found == set()


def test_list_pagination(listed_suggestions) -> None:  # type: ignore[no-untyped-def]
    client, _ = listed_suggestions
    _, body = _list_ids(client, page=1, page_size=20)
    assert (body["page"], body["page_size"], body["total"]) == (1, 20, 4)
    _, body = _list_ids(client, page=1, page_size=100)
    assert body["page_size"] == 100 and len(body["items"]) == 4  # type: ignore[arg-type]
    first, body1 = _list_ids(client, page=1, page_size=3)
    second, body2 = _list_ids(client, page=2, page_size=3)
    assert len(first) == 3 and len(second) == 1 and not first & second
    assert body1["total"] == body2["total"] == 4
    assert _list_ids(client, page=3, page_size=3)[0] == set()
    assert client.get("/api/interlink/suggestions", params={"page_size": 101}).status_code == 422
