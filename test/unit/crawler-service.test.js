// Port of tests/unit/test_crawler_service.py
import { describe, expect, it } from 'vitest';
import { UnprocessableError } from '../../src/utils/errors.js';
import {
  BASE,
  FakeCrawlStore,
  MockSite,
  ROBOTS_ALLOW_ALL,
  connectError,
  crawlRequest,
  htmlPage,
  makeCrawler,
  makeSite,
  oldPage,
} from '../helpers/crawler-fakes.js';

function siteWithPages() {
  const mock = new MockSite();
  mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
  mock.html(
    '/',
    'Home',
    '<h1>Welcome</h1><p>See <a href="/services/">services</a>, <a href="/services/ai-voice-agent/">voice agents</a> and ' +
      '<a href="https://facebook.com/example">Facebook</a>, <a href="/logo.png">logo</a>, <a href="mailto:a@example.com">mail</a>.</p>',
  );
  mock.html('/services/', 'Services', '<p><a href="/services/ai-voice-agent/#pricing">Voice</a></p>');
  mock.html('/services/ai-voice-agent/', 'AI Voice Agent', '<h1>AI Voice Agents</h1><p>We automate calls.</p>', {
    canonical: `${BASE}/services/ai-voice-agent/`,
  });
  return mock;
}

async function crawl(mock, store = null, request = {}) {
  const [crawler, crawlStore] = makeCrawler(mock, store);
  return [await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false, ...request })), crawlStore];
}
const count = (arr, v) => arr.filter((x) => x === v).length;

describe('site crawler', () => {
  it('inserts new pages with extracted data', async () => {
    const [report, store] = await crawl(siteWithPages());
    expect(report.pages_crawled).toBe(3);
    expect(report.pages_created).toBe(3);
    expect(report.pages_updated).toBe(0);
    expect(new Set(store.pages.keys())).toEqual(new Set([`${BASE}/`, `${BASE}/services/`, `${BASE}/services/ai-voice-agent/`]));
    const voice = store.pages.get(`${BASE}/services/ai-voice-agent/`);
    expect(voice.title).toBe('AI Voice Agent');
    expect(voice.h1).toBe('AI Voice Agents');
    expect(voice.http_status).toBe(200);
    expect(voice.redirect_url).toBeNull();
    expect(voice.canonical_url).toBe(`${BASE}/services/ai-voice-agent/`);
    expect(voice.language).toBe('en');
    expect(voice.is_indexable).toBe(true);
    expect(voice.has_noindex).toBe(false);
    expect(voice.content_html).toContain('We automate calls.');
    expect(voice.content_html).not.toContain('© Example'); // footer excluded from content
    expect(store.pages.get(`${BASE}/`).outgoing_links).toEqual([`${BASE}/services/`, `${BASE}/services/ai-voice-agent/`]);
    expect(report.errors).toEqual([]);
  });

  it('uses navigation and footer links for discovery only', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<p>Body copy.</p>', { nav: '<a href="/nav-only/">Nav</a>', footer: '<a href="/footer-only/">Footer</a>' });
    mock.html('/nav-only/', 'Nav only', '<p>x</p>');
    mock.html('/footer-only/', 'Footer only', '<p>y</p>');
    const [, store] = await crawl(mock);
    expect(store.pages.has(`${BASE}/nav-only/`) && store.pages.has(`${BASE}/footer-only/`)).toBe(true);
    // Chrome links are not counted as the page's contextual (content) links.
    expect(store.pages.get(`${BASE}/`).outgoing_links).toEqual([]);
    expect(store.pages.get(`${BASE}/`).content_html).not.toContain('Nav');
  });

  it('stays on the same domain and skips assets and special schemes', async () => {
    const mock = siteWithPages();
    await crawl(mock);
    expect(mock.requests.every((u) => u.startsWith(BASE))).toBe(true);
    expect(mock.requests.some((u) => u.includes('facebook') || u.endsWith('.png'))).toBe(false);
  });

  it('re-crawl updates existing pages without duplicates', async () => {
    const mock = siteWithPages();
    const [, store] = await crawl(mock);
    mock.html('/services/', 'Services (updated)', '<p>New copy.</p>');
    const [second] = await crawl(mock, store);
    expect(second.pages_created).toBe(0);
    expect(second.pages_updated).toBe(3);
    expect(store.pages.size).toBe(3);
    expect(store.pages.get(`${BASE}/services/`).title).toBe('Services (updated)');
  });

  it('crawls duplicate URL variants once', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html(
      '/',
      'Home',
      '<a href="/page">a</a> <a href="/page/">b</a> <a href="/page/#s">c</a> <a href="/page?utm_source=x">d</a> <a href="/page?utm_campaign=y&gclid=1">e</a>',
    );
    mock.html('/page/', 'Page', '<p>page</p>');
    mock.html('/page', 'Page', '<p>page</p>');
    const [report, store] = await crawl(mock);
    expect(mock.requestedPaths().filter((p) => p.startsWith('/page'))).toHaveLength(1);
    expect(report.pages_discovered).toBe(2); // "/" and one "/page"
    expect([...store.pages.keys()].filter((u) => u.includes('/page'))).toHaveLength(1);
  });

  it('reuses the existing stored URL form', async () => {
    const store = new FakeCrawlStore();
    await store.upsertPage(makeSite().id, oldPage(`${BASE}/page`)); // stored without trailing slash
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/page/">p</a>');
    mock.html('/page/', 'Page', '<p>page</p>');
    const [report] = await crawl(mock, store);
    expect(store.pages.has(`${BASE}/page/`)).toBe(false);
    expect(store.pages.get(`${BASE}/page`).title).toBe('Page');
    expect(report.pages_updated).toBe(1);
    expect(report.pages_created).toBe(1);
  });

  it('continues after errors', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/broken/">x</a> <a href="/down/">y</a> <a href="/boom/">z</a> <a href="/ok/">ok</a>');
    mock.add('/broken/', 404, 'nope', { content_type: 'text/html' });
    mock.add('/down/', 500, 'err', { content_type: 'text/html' });
    mock.routes.set('/boom/', () => {
      throw connectError('connection reset');
    });
    mock.html('/ok/', 'OK', '<p>fine</p>');
    const [report, store] = await crawl(mock);
    expect(store.pages.has(`${BASE}/ok/`)).toBe(true); // later pages still crawled
    const errors = Object.fromEntries(report.errors.map((e) => [e.url.replace(BASE, ''), e]));
    expect(errors['/broken/'].status).toBe(404);
    expect(errors['/broken/'].error).toContain('404');
    expect(errors['/down/'].status).toBe(500);
    expect(errors['/boom/'].error).toContain('ConnectError');
    expect(errors['/boom/'].status).toBeNull();
    // 5xx and connection errors were retried (max_retries=2 -> 3 attempts each).
    expect(count(mock.requestedPaths(), '/down/')).toBe(3);
    expect(count(mock.requestedPaths(), '/boom/')).toBe(3);
    expect(count(mock.requestedPaths(), '/broken/')).toBe(1);
  });

  it('a database failure for one page does not stop the crawl', async () => {
    const store = new FakeCrawlStore();
    store.failOn = new Set([`${BASE}/services/`]);
    const [report] = await crawl(siteWithPages(), store);
    expect(store.pages.has(`${BASE}/services/ai-voice-agent/`)).toBe(true);
    expect(report.errors.some((e) => e.url === `${BASE}/services/` && e.error.includes('Failed to store page'))).toBe(true);
  });

  it('an existing page that now 404s keeps its content', async () => {
    const store = new FakeCrawlStore();
    await store.upsertPage(makeSite().id, oldPage(`${BASE}/gone/`));
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/gone/">gone</a>');
    await crawl(mock, store);
    const gone = store.pages.get(`${BASE}/gone/`);
    expect(gone.http_status).toBe(404);
    expect(gone.content_html).toBe('<p>old content</p>'); // not wiped by an error response
    expect(store.statusUpdates).toContainEqual([`${BASE}/gone/`, 404, null]);
  });

  it('new 404 pages are not inserted', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/missing/">m</a>');
    const [report, store] = await crawl(mock);
    expect(store.pages.has(`${BASE}/missing/`)).toBe(false);
    expect(report.errors[0].status).toBe(404);
  });

  it('410 is treated like other 4xx (status recorded, content kept)', async () => {
    const store = new FakeCrawlStore();
    await store.upsertPage(makeSite().id, oldPage(`${BASE}/retired/`));
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/retired/">r</a>');
    mock.add('/retired/', 410, 'gone', { content_type: 'text/html' });
    const [report] = await crawl(mock, store);
    expect(report.errors).toContainEqual({ url: `${BASE}/retired/`, error: 'HTTP 410', status: 410 });
    expect(store.pages.get(`${BASE}/retired/`).http_status).toBe(410);
    expect(store.pages.get(`${BASE}/retired/`).content_html).toBe('<p>old content</p>');
  });

  it('respects max_pages', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', Array.from({ length: 20 }, (_, i) => `<a href="/p${i}/">${i}</a>`).join(' '));
    for (let i = 0; i < 20; i += 1) mock.html(`/p${i}/`, `P${i}`, '<p>x</p>');
    const [report, store] = await crawl(mock, null, { max_pages: 5 });
    expect(report.pages_crawled).toBe(5);
    expect(store.pages.size).toBe(5);
    expect(report.max_pages_reached).toBe(true);
    expect(report.skipped_reasons.MAX_PAGES_REACHED).toBe(16);
    expect(report.pages_discovered).toBe(21);
    expect(mock.requestedPaths().filter((p) => p !== '/robots.txt')).toHaveLength(5);
  });

  it('records redirects and stores the final page', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/old-page/">old</a> <a href="/leaves/">x</a>');
    mock.add('/old-page/', 301, '', { location: '/new-page/' });
    mock.html('/new-page/', 'New page', '<p>new</p>');
    mock.add('/leaves/', 302, '', { location: 'https://other.com/landing' });
    const [, store] = await crawl(mock);
    const old = store.pages.get(`${BASE}/old-page/`);
    expect(old.http_status).toBe(301);
    expect(old.redirect_url).toBe(`${BASE}/new-page/`);
    expect(store.pages.get(`${BASE}/new-page/`).title).toBe('New page');
    expect(store.pages.get(`${BASE}/leaves/`).redirect_url).toBe('https://other.com/landing');
    expect(mock.requests.some((u) => u.includes('other.com'))).toBe(false); // external target not fetched
  });

  it('skips a duplicate final URL reached through a redirect', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/target/">t</a> <a href="/alias/">a</a>');
    mock.html('/target/', 'Target', '<p>t</p>');
    mock.add('/alias/', 301, '', { location: '/target/' });
    const [report] = await crawl(mock);
    expect(report.skipped_reasons.DUPLICATE_FINAL_URL).toBe(1);
  });

  it('bounds redirect loops', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/loop-a/">a</a> <a href="/ok/">ok</a>');
    mock.add('/loop-a/', 302, '', { location: '/loop-b/' });
    mock.add('/loop-b/', 302, '', { location: '/loop-a/' });
    mock.html('/ok/', 'OK', '<p>ok</p>');
    const [report, store] = await crawl(mock);
    expect(report.errors.some((e) => e.error.includes('Too many redirects'))).toBe(true);
    expect(store.pages.has(`${BASE}/ok/`)).toBe(true);
  });

  it('handles non-HTML and oversized responses', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<a href="/feed/">feed</a> <a href="/huge/">huge</a>');
    mock.add('/feed/', 200, '{}', { content_type: 'application/json' });
    mock.add('/huge/', 200, htmlPage('Huge', 'x'.repeat(50_000)), { content_type: 'text/html' });
    const [crawler, store] = makeCrawler(mock, null, { maxResponseBytes: 20_000 });
    const report = await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false }));
    expect(report.skipped_reasons.NOT_HTML).toBe(1);
    expect(report.errors.some((e) => e.url.endsWith('/huge/') && e.error.includes('too large'))).toBe(true);
    expect(new Set(store.pages.keys())).toEqual(new Set([`${BASE}/`]));
  });

  it('stores noindex pages but marks them', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.routes.set('/', [200, htmlPage('Home', '<p>x</p>', { headExtra: '<meta name="robots" content="noindex">' }), { 'content-type': 'text/html' }]);
    const [, store] = await crawl(mock);
    const home = store.pages.get(`${BASE}/`);
    expect(home.has_noindex).toBe(true);
    expect(home.is_indexable).toBe(false);
  });

  it('start_url must be in scope', async () => {
    const [crawler] = makeCrawler(new MockSite());
    for (const bad of ['https://other.com/', 'https://www.example.com/']) {
      const err = await crawler.crawl(makeSite(), crawlRequest({ start_url: bad })).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableError);
      expect(err.code).toBe('START_URL_OUT_OF_SCOPE');
    }
  });

  it('blocks an internal site base URL', async () => {
    const [crawler] = makeCrawler(new MockSite());
    const err = await crawler.crawl(makeSite('http://127.0.0.1'), crawlRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(err.code).toBe('START_URL_BLOCKED');
  });

  it('pauses politely between requests', async () => {
    const [crawler, , sleeps] = makeCrawler(siteWithPages(), null, { requestDelaySeconds: 0.25 });
    await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false }));
    // robots.txt + 3 pages = 4 requests -> 3 pauses.
    expect(sleeps).toEqual([0.25, 0.25, 0.25]);
  });

  it('holds the site lock while crawling', async () => {
    const store = new FakeCrawlStore();
    const seen = [];
    const original = store.existingUrls.bind(store);
    store.existingUrls = async (siteId) => {
      seen.push(store.locked);
      return original(siteId);
    };
    await crawl(siteWithPages(), store);
    expect(seen).toEqual([true]);
    expect(store.locked).toBe(false);
  });

  it('bounds discovery tracking', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', Array.from({ length: 30 }, (_, i) => `<a href="/p${i}/">${i}</a>`).join(' '));
    const [crawler] = makeCrawler(mock, null, { discoveryFactor: 2, minDiscoveryLimit: 10 });
    const report = await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false, max_pages: 1 }));
    expect(report.pages_discovered).toBe(10);
    expect(report.skipped_reasons.DISCOVERY_LIMIT).toBe(21);
  });
});
