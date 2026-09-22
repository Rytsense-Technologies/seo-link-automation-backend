from __future__ import annotations

from app.crawler.robots import RobotsRules, parse_robots
from app.crawler.schemas import CrawlRequest
from tests.crawler_fakes import BASE, MockSite, make_crawler, make_site

UA = "SEOLinkAutomationBot/0.1"

ROBOTS = """
# comment
User-agent: *
Disallow: /admin/
Disallow: /*?s=
Disallow: /*.pdf$
Allow: /admin/public/
Crawl-delay: 2

User-agent: OtherBot
Disallow: /

Sitemap: https://example.com/sitemap_index.xml
Sitemap: https://example.com/post-sitemap.xml
"""


def test_parse_rules_wildcards_and_precedence() -> None:
    rules = parse_robots(ROBOTS, UA)
    assert rules.can_fetch(f"{BASE}/services/")
    assert not rules.can_fetch(f"{BASE}/admin/settings")
    assert rules.can_fetch(f"{BASE}/admin/public/page")  # longer Allow wins
    assert not rules.can_fetch(f"{BASE}/blog/?s=ai")  # '*' wildcard
    assert not rules.can_fetch(f"{BASE}/files/brochure.pdf")  # '$' anchor
    assert rules.can_fetch(f"{BASE}/files/brochure.pdf?download=1")
    assert rules.can_fetch(f"{BASE}/robots.txt")
    assert rules.crawl_delay == 2
    assert rules.sitemaps == [
        "https://example.com/sitemap_index.xml",
        "https://example.com/post-sitemap.xml",
    ]


def test_specific_user_agent_group_wins() -> None:
    text = "User-agent: *\nDisallow:\n\nUser-agent: seolinkautomationbot\nDisallow: /private/\n"
    rules = parse_robots(text, UA)
    assert not rules.can_fetch(f"{BASE}/private/x")
    assert rules.can_fetch(f"{BASE}/public/")
    blocked = parse_robots("User-agent: SEOLinkAutomationBot\nDisallow: /\n", UA)
    assert not blocked.can_fetch(f"{BASE}/anything")


def test_allow_wins_ties_and_empty_disallow_allows() -> None:
    rules = parse_robots("User-agent: *\nDisallow: /page\nAllow: /page\n", UA)
    assert rules.can_fetch(f"{BASE}/page")
    assert parse_robots("User-agent: *\nDisallow:\n", UA).can_fetch(f"{BASE}/x")
    assert parse_robots("", UA).can_fetch(f"{BASE}/x")


def test_disallow_all_and_allow_all_policies() -> None:
    assert not RobotsRules.disallowing_all().can_fetch(f"{BASE}/")
    assert RobotsRules.allowing_all().can_fetch(f"{BASE}/admin/")


def _crawl(mock: MockSite) -> tuple:  # type: ignore[type-arg]
    crawler, store, sleeps = make_crawler(mock)
    return crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False)), store, sleeps


def test_crawl_respects_robots_disallow() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, "User-agent: *\nDisallow: /private/\n")
    mock.html("/", "Home", '<a href="/private/secret/">s</a> <a href="/public/">p</a>')
    mock.html("/public/", "Public", "<p>public</p>")
    mock.html("/private/secret/", "Secret", "<p>secret</p>")
    report, store, _ = _crawl(mock)
    assert "/private/secret/" not in mock.requested_paths()  # never requested
    assert report.skipped_reasons["ROBOTS_DISALLOWED"] == 1
    assert {p.split(BASE)[1] for p in store.pages} == {"/", "/public/"}
    assert report.robots.policy == "parsed" and report.robots.status == 200


def test_robots_404_means_allow_all() -> None:
    mock = MockSite()
    mock.html("/", "Home", "<p>hi</p>")
    report, store, _ = _crawl(mock)
    assert report.robots.policy == "allow_all" and report.robots.status == 404
    assert len(store.pages) == 1


def test_robots_5xx_means_disallow_all() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 503, "down")
    mock.html("/", "Home", "<p>hi</p>")
    report, store, _ = _crawl(mock)
    assert report.robots.policy == "disallow_all"
    assert report.pages_crawled == 0 and store.pages == {}
    assert "/" not in mock.requested_paths()
    assert report.errors[0].url.endswith("/robots.txt")


def test_crawl_delay_is_honoured_and_capped() -> None:
    mock = MockSite()
    mock.add("/robots.txt", 200, "User-agent: *\nCrawl-delay: 60\n")
    mock.html("/", "Home", '<a href="/a/">a</a>')
    mock.html("/a/", "A", "<p>a</p>")
    crawler, _, sleeps = make_crawler(mock, max_crawl_delay_seconds=3.0)
    crawler.crawl(make_site(), CrawlRequest(use_sitemaps=False))
    assert sleeps and set(sleeps) == {3.0}
