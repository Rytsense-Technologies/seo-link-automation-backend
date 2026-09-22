"""HTTP-level tests for /api/interlink (service wired to in-memory fakes, AI mocked)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.core.config import Settings, get_settings
from app.interlink.dependencies import get_interlink_service
from app.interlink.models import SuggestionStatus
from app.main import create_app
from tests.conftest import Site, crm_item, voice_item
from tests.fakes import FakeAIProvider, FakeContentStore, build_service

CONTEXT = "Businesses can use AI voice agents to automate repetitive customer support interactions."


@pytest.fixture
def provider(site: Site) -> FakeAIProvider:
    return FakeAIProvider({"suggestions": [voice_item(site), crm_item(site)]})


@pytest.fixture
def client(site: Site, provider: FakeAIProvider) -> Iterator[TestClient]:
    app = create_app()
    store = FakeContentStore()
    app.dependency_overrides[get_interlink_service] = lambda: build_service(
        site.repo, provider, store=store
    )
    with TestClient(app) as c:
        yield c


def _suggestion(site: Site, status: SuggestionStatus = SuggestionStatus.PENDING, **kw: object):  # type: ignore[no-untyped-def]
    values: dict[str, object] = {
        "source_page_id": site.source.id,
        "target_page_id": site.voice.id,
        "anchor_text": "AI voice agents",
        "context": CONTEXT,
        "status": status,
    }
    values.update(kw)
    return site.repo.put_suggestion(**values)


def test_analyze_endpoint(client: TestClient, site: Site) -> None:
    res = client.post("/api/interlink/analyze", json={"source_page_id": str(site.source.id)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["min_relevance_score"] == 70
    assert body["dry_run"] is False
    assert [s["target_page_id"] for s in body["suggestions"]] == [
        str(site.voice.id),
        str(site.crm.id),
    ]
    first = body["suggestions"][0]
    assert first["status"] == "PENDING"
    assert first["anchor_text"] == "AI voice agents"
    assert first["relevance_score"] == 94
    assert body["excluded_counts"]["NOINDEX"] == 1


def test_analyze_validation_errors(client: TestClient) -> None:
    res = client.post("/api/interlink/analyze", json={"source_page_id": "not-a-uuid"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    res = client.post(
        "/api/interlink/analyze",
        json={"source_page_id": str(uuid.uuid4()), "min_relevance_score": 101},
    )
    assert res.status_code == 422
    res = client.post("/api/interlink/analyze", json={"source_page_id": str(uuid.uuid4())})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "PAGE_NOT_FOUND"


def test_analyze_ai_failure_returns_502(client: TestClient, site: Site) -> None:
    from app.ai.base import AIProviderError

    client.app.dependency_overrides[get_interlink_service] = lambda: build_service(  # type: ignore[attr-defined]
        site.repo, FakeAIProvider(AIProviderError("provider down"))
    )
    res = client.post("/api/interlink/analyze", json={"source_page_id": str(site.source.id)})
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "AI_PROVIDER_ERROR"


def test_list_and_filter_suggestions(client: TestClient, site: Site) -> None:
    _suggestion(site, relevance_score=95)
    _suggestion(site, SuggestionStatus.REJECTED, target_page_id=site.crm.id, relevance_score=71)
    _suggestion(site, SuggestionStatus.APPLIED, target_page_id=site.dental.id, relevance_score=80)

    body = client.get("/api/interlink/suggestions").json()
    assert body["total"] == 3 and body["page"] == 1 and body["page_size"] == 20

    body = client.get("/api/interlink/suggestions", params={"status": "REJECTED"}).json()
    assert [i["target_page_id"] for i in body["items"]] == [str(site.crm.id)]

    body = client.get("/api/interlink/suggestions", params={"min_relevance_score": 80}).json()
    assert body["total"] == 2

    body = client.get(
        "/api/interlink/suggestions", params={"target_page_id": str(site.dental.id)}
    ).json()
    assert body["total"] == 1

    body = client.get(
        "/api/interlink/suggestions", params={"source_page_id": str(site.source.id), "page_size": 2}
    ).json()
    assert body["total"] == 3 and len(body["items"]) == 2

    for params in (
        {"status": "DONE"},
        {"page": 0},
        {"page_size": 1000},
        {"min_relevance_score": -1},
    ):
        assert client.get("/api/interlink/suggestions", params=params).status_code == 422


def test_get_suggestion_detail(client: TestClient, site: Site) -> None:
    s = _suggestion(site)
    res = client.get(f"/api/interlink/suggestions/{s.id}")
    assert res.status_code == 200
    body = res.json()
    assert body["target_url"] == site.voice.url
    assert body["source_page"]["url"] == site.source.url
    assert body["target_page"]["title"] == site.voice.title
    assert client.get(f"/api/interlink/suggestions/{uuid.uuid4()}").status_code == 404
    assert client.get("/api/interlink/suggestions/123").status_code == 422


def test_approve_reject_endpoints(client: TestClient, site: Site) -> None:
    s = _suggestion(site)
    res = client.post(f"/api/interlink/suggestions/{s.id}/approve")
    assert res.status_code == 200 and res.json()["status"] == "APPROVED"

    res = client.post(f"/api/interlink/suggestions/{s.id}/approve")
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "INVALID_STATUS_TRANSITION"

    res = client.post(f"/api/interlink/suggestions/{s.id}/reject", json={"reason": "off-topic"})
    assert res.status_code == 200
    assert res.json()["status"] == "REJECTED"
    assert res.json()["rejection_reason"] == "off-topic"

    other = _suggestion(site, target_page_id=site.crm.id)
    res = client.post(f"/api/interlink/suggestions/{other.id}/reject")  # body optional
    assert res.status_code == 200

    long_reason = {"reason": "x" * 2001}
    res = client.post(f"/api/interlink/suggestions/{other.id}/reject", json=long_reason)
    assert res.status_code == 422


def test_apply_endpoint(client: TestClient, site: Site) -> None:
    s = _suggestion(site)
    res = client.post(f"/api/interlink/suggestions/{s.id}/apply")
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SUGGESTION_NOT_APPROVED"

    client.post(f"/api/interlink/suggestions/{s.id}/approve")
    res = client.post(f"/api/interlink/suggestions/{s.id}/apply")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "APPLIED"
    assert res.json()["applied_at"] is not None
    assert '<a href="/ai-voice-agent/">AI voice agents</a>' in (site.source.content_html or "")

    res = client.post(f"/api/interlink/suggestions/{s.id}/apply")
    assert res.status_code == 409


def test_apply_endpoint_unprocessable_when_context_missing(client: TestClient, site: Site) -> None:
    s = _suggestion(site, SuggestionStatus.APPROVED, context="This sentence is not on the page.")
    res = client.post(f"/api/interlink/suggestions/{s.id}/apply")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "CONTEXT_NOT_FOUND"


def test_database_errors_return_503(client: TestClient, site: Site) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    site.repo.list_suggestions = broken  # type: ignore[method-assign,assignment]
    site.repo.get_suggestion = broken  # type: ignore[method-assign,assignment]
    res = client.get("/api/interlink/suggestions")
    assert res.status_code == 503
    assert res.json() == {
        "error": {"code": "DATABASE_ERROR", "message": "A database error occurred", "details": None}
    }
    assert client.post(f"/api/interlink/suggestions/{uuid.uuid4()}/approve").status_code == 503


def test_api_key_is_enforced_when_configured(site: Site) -> None:
    app = create_app()
    app.dependency_overrides[get_interlink_service] = lambda: build_service(site.repo)
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, api_key="secret")  # type: ignore[call-arg]
    with TestClient(app) as c:
        assert c.get("/api/interlink/suggestions").status_code == 401
        assert (
            c.get("/api/interlink/suggestions", headers={"X-API-Key": "wrong"}).status_code == 401
        )
        ok = c.get("/api/interlink/suggestions", headers={"X-API-Key": "secret"})
        assert ok.status_code == 200


def test_openapi_documents_interlink_endpoints(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    for path, method in [
        ("/api/interlink/analyze", "post"),
        ("/api/interlink/suggestions", "get"),
        ("/api/interlink/suggestions/{suggestion_id}", "get"),
        ("/api/interlink/suggestions/{suggestion_id}/approve", "post"),
        ("/api/interlink/suggestions/{suggestion_id}/reject", "post"),
        ("/api/interlink/suggestions/{suggestion_id}/apply", "post"),
    ]:
        assert method in paths[path], path
        assert "422" in paths[path][method]["responses"]
    schemas = spec["components"]["schemas"]
    assert schemas["SuggestionStatus"]["enum"] == ["PENDING", "APPROVED", "REJECTED", "APPLIED"]
    assert "AnalyzeRequest" in schemas and "SuggestionDetail" in schemas
    assert "ErrorResponse" in schemas
