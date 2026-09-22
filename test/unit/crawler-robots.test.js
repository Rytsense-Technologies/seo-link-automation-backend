// Port of tests/unit/test_crawler_robots.py
import { describe, expect, it } from 'vitest';
import { RobotsRules, parseRobots } from '../../src/crawler/robots.js';
import { BASE, MockSite, crawlRequest, makeCrawler, makeSite } from '../helpers/crawler-fakes.js';

const UA = 'SEOLinkAutomationBot/0.1';

const ROBOTS = `
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
`;

const crawl = async (mock, config = {}) => {
  const [crawler, store, sleeps] = makeCrawler(mock, null, config);
  return [await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false })), store, sleeps];
};

describe('robots.txt', () => {
  it('parses rules, wildcards and precedence', () => {
    const rules = parseRobots(ROBOTS, UA);
    expect(rules.canFetch(`${BASE}/services/`)).toBe(true);
    expect(rules.canFetch(`${BASE}/admin/settings`)).toBe(false);
    expect(rules.canFetch(`${BASE}/admin/public/page`)).toBe(true); // longer Allow wins
    expect(rules.canFetch(`${BASE}/blog/?s=ai`)).toBe(false); // '*' wildcard
    expect(rules.canFetch(`${BASE}/files/brochure.pdf`)).toBe(false); // '$' anchor
    expect(rules.canFetch(`${BASE}/files/brochure.pdf?download=1`)).toBe(true);
    expect(rules.canFetch(`${BASE}/robots.txt`)).toBe(true);
    expect(rules.crawlDelay).toBe(2);
    expect(rules.sitemaps).toEqual(['https://example.com/sitemap_index.xml', 'https://example.com/post-sitemap.xml']);
  });

  it('the specific user-agent group wins', () => {
    const rules = parseRobots('User-agent: *\nDisallow:\n\nUser-agent: seolinkautomationbot\nDisallow: /private/\n', UA);
    expect(rules.canFetch(`${BASE}/private/x`)).toBe(false);
    expect(rules.canFetch(`${BASE}/public/`)).toBe(true);
    const blocked = parseRobots('User-agent: SEOLinkAutomationBot\nDisallow: /\n', UA);
    expect(blocked.canFetch(`${BASE}/anything`)).toBe(false);
  });

  it('Allow wins ties and an empty Disallow allows', () => {
    expect(parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n', UA).canFetch(`${BASE}/page`)).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow:\n', UA).canFetch(`${BASE}/x`)).toBe(true);
    expect(parseRobots('', UA).canFetch(`${BASE}/x`)).toBe(true);
  });

  it('disallow-all and allow-all policies', () => {
    expect(RobotsRules.disallowingAll().canFetch(`${BASE}/`)).toBe(false);
    expect(RobotsRules.allowingAll().canFetch(`${BASE}/admin/`)).toBe(true);
  });

  it('crawl respects robots disallow', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, 'User-agent: *\nDisallow: /private/\n');
    mock.html('/', 'Home', '<a href="/private/secret/">s</a> <a href="/public/">p</a>');
    mock.html('/public/', 'Public', '<p>public</p>');
    mock.html('/private/secret/', 'Secret', '<p>secret</p>');
    const [report, store] = await crawl(mock);
    expect(mock.requestedPaths()).not.toContain('/private/secret/'); // never requested
    expect(report.skipped_reasons.ROBOTS_DISALLOWED).toBe(1);
    expect(new Set([...store.pages.keys()].map((p) => p.split(BASE)[1]))).toEqual(new Set(['/', '/public/']));
    expect(report.robots.policy).toBe('parsed');
    expect(report.robots.status).toBe(200);
  });

  it('a 404 robots.txt means allow all', async () => {
    const mock = new MockSite();
    mock.html('/', 'Home', '<p>hi</p>');
    const [report, store] = await crawl(mock);
    expect(report.robots.policy).toBe('allow_all');
    expect(report.robots.status).toBe(404);
    expect(store.pages.size).toBe(1);
  });

  it('a 5xx robots.txt means disallow all', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 503, 'down');
    mock.html('/', 'Home', '<p>hi</p>');
    const [report, store] = await crawl(mock);
    expect(report.robots.policy).toBe('disallow_all');
    expect(report.pages_crawled).toBe(0);
    expect(store.pages.size).toBe(0);
    expect(mock.requestedPaths()).not.toContain('/');
    expect(report.errors[0].url.endsWith('/robots.txt')).toBe(true);
  });

  it('honours and caps Crawl-delay', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, 'User-agent: *\nCrawl-delay: 60\n');
    mock.html('/', 'Home', '<a href="/a/">a</a>');
    mock.html('/a/', 'A', '<p>a</p>');
    const [, , sleeps] = await crawl(mock, { maxCrawlDelaySeconds: 3.0 });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(new Set(sleeps)).toEqual(new Set([3.0]));
  });
});
