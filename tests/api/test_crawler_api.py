"""HTTP-level tests for POST /api/sites/{site_id}/crawl (mock website, in-memory store)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.exceptions import NotFoundError
from app.crawler.dependencies import get_site_crawler
from app.main import create_app
from app.pages.models import Site
from app.pages.router import get_page_service
from tests.crawler_fakes import BASE, ROBOTS_ALLOW_ALL, MockSite, make_crawler, make_site


class _FakePages:
    def __init__(self, site: Site) -> None:
        self._site = site

    def get_site(self, site_id: uuid.UUID) -> Site:
        if site_id != self._site.id:
            raise NotFoundError("Site not found", code="SITE_NOT_FOUND")
        return self._site


@pytest.fixture
def mock() -> MockSite:
    site = MockSite()
    site.add("/robots.txt", 200, ROBOTS_ALLOW_ALL)
    site.html("/", "Home", '<p><a href="/about/">About us</a></p>')
    site.html("/about/", "About", "<p>About copy.</p>")
    return site


@pytest.fixture
def client(mock: MockSite) -> Iterator[TestClient]:
    app = create_app()
    site = make_site()
    app.dependency_overrides[get_page_service] = lambda: _FakePages(site)
    app.dependency_overrides[get_site_crawler] = lambda: make_crawler(mock)[0]
    with TestClient(app) as c:
        yield c


def test_crawl_endpoint_returns_report(client: TestClient) -> None:
    site_id = make_site().id
    res = client.post(
        f"/api/sites/{site_id}/crawl", json={"start_url": f"{BASE}/", "max_pages": 100}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["site_id"] == str(site_id)
    assert body["start_url"] == f"{BASE}/"
    assert body["pages_discovered"] == 2
    assert body["pages_crawled"] == 2
    assert body["pages_created"] == 2
    assert body["pages_updated"] == 0
    assert body["pages_skipped"] == 0
    assert body["errors"] == []
    assert body["robots"]["policy"] == "parsed"
    assert set(body) >= {
        "sitemaps_processed",
        "skipped_reasons",
        "max_pages_reached",
        "duration_seconds",
    }


def test_body_is_optional_and_defaults_to_site_base_url(client: TestClient) -> None:
    res = client.post(f"/api/sites/{make_site().id}/crawl")
    assert res.status_code == 200, res.text
    assert res.json()["start_url"] == f"{BASE}/"


def test_validation_and_not_found(client: TestClient) -> None:
    site_id = make_site().id
    for body in ({"max_pages": 0}, {"max_pages": 5000}, {"start_url": "not a url"}):
        res = client.post(f"/api/sites/{site_id}/crawl", json=body)
        assert res.status_code == 422, body
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    res = client.post(f"/api/sites/{site_id}/crawl", json={"start_url": "https://other.com/"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "START_URL_OUT_OF_SCOPE"
    res = client.post(f"/api/sites/{uuid.uuid4()}/crawl", json={})
    assert res.status_code == 404
    assert client.post("/api/sites/not-a-uuid/crawl", json={}).status_code == 422


def test_openapi_documents_crawl_endpoint(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/sites/{site_id}/crawl"]["post"]
    assert "409" in op["responses"] and "422" in op["responses"]
    assert "CrawlRequest" in spec["components"]["schemas"]
    assert "CrawlResponse" in spec["components"]["schemas"]
