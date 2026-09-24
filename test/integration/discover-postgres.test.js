// POST /api/pages/discover logic (discoverPage) against a dedicated, disposable PostgreSQL database,
// with the real SiteCrawler + PgCrawlStore and a mocked website (no network).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discoverPage } from '../../src/crawler/discover.js';
import { SSRFError } from '../../src/crawler/ssrf.js';
import { PgCrawlStore } from '../../src/crawler/store.js';
import { PageService } from '../../src/db/queries/pages.js';
import { ConflictError, NotFoundError, UnprocessableError, UpstreamError } from '../../src/utils/errors.js';
import { MockSite, ROBOTS_ALLOW_ALL, connectError, makeCrawler } from '../helpers/crawler-fakes.js';
import { DB_URL, closeTestDatabase, openTestDatabase, truncate } from './db.js';

const BASE = 'https://example.com';

describe.skipIf(!DB_URL)('discoverPage (PostgreSQL + crawler)', () => {
  let pool;
  let pages;
  let site;
  let mock;

  beforeAll(async () => {
    pool = await openTestDatabase();
    pages = new PageService(pool);
  });
  afterAll(async () => {
    if (pool) await closeTestDatabase(pool);
  });
  beforeEach(async () => {
    await truncate(pool);
    site = await pages.createSite({ name: 'Example', base_url: BASE });
    mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<p>Home page with a <a href="/elsewhere/">link</a>.</p>');
  });

  const discover = (url, crawlerConfig = {}) => {
    const [crawler] = makeCrawler(mock, new PgCrawlStore(pool), crawlerConfig);
    return discoverPage({ pageService: pages, crawler }, url);
  };
  const expectError = async (promise, ErrorClass, code) => {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.code).toBe(code);
    return error;
  };
  const row = async (url) => (await pool.query('SELECT * FROM pages WHERE url = $1', [url])).rows[0] ?? null;
  const pageCount = async () => (await pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n;

  it('adds a new page of an indexed site, fetching only robots.txt and that page', async () => {
    mock.html('/new-page/', 'New Page', '<p>Fresh copy about <a href="/other/">another page</a>.</p>');

    const { site: found, page } = await discover('  HTTPS://Example.com/new-page/?utm_source=newsletter#pricing  ');

    expect(found.id).toBe(site.id);
    expect(page.url).toBe('https://example.com/new-page/'); // normalised: case, tracking params, fragment
    expect(page.title).toBe('New Page');
    expect(page.http_status).toBe(200);
    expect(page).not.toHaveProperty('content_html');
    expect(mock.requestedPaths()).toEqual(['/robots.txt', '/new-page/']);
    const stored = await row(page.url);
    expect(stored.content_html).toContain('Fresh copy');
    expect(stored.content_version).toBe(1);
    expect(await pageCount()).toBe(1); // linked pages are discovered, never fetched or stored
  });

  it('re-discovering keeps the page id and bumps content_version only when content changed', async () => {
    mock.html('/new-page/', 'New Page', '<p>Version one.</p>');
    const first = await discover('https://example.com/new-page/');
    const same = await discover('https://example.com/new-page/');
    expect(same.page.id).toBe(first.page.id);
    expect((await row(first.page.url)).content_version).toBe(1);

    mock.html('/new-page/', 'New Page', '<p>Version two.</p>');
    const changed = await discover('https://example.com/new-page/?utm_source=newsletter#top');
    expect(changed.page.id).toBe(first.page.id);
    const stored = await row(first.page.url);
    expect(stored.content_version).toBe(2);
    expect(stored.content_html).toContain('Version two');
  });

  it('follows a same-site redirect to the page it ends on', async () => {
    mock.add('/old-page/', 301, '', { location: '/new-page/' });
    mock.html('/new-page/', 'New Page', '<p>Moved here.</p>');

    const { page } = await discover('https://example.com/old-page/');

    expect(page.url).toBe('https://example.com/new-page/');
    expect(page.title).toBe('New Page');
    const hop = await row('https://example.com/old-page/');
    expect([hop.http_status, hop.redirect_url]).toEqual([301, 'https://example.com/new-page/']);
  });

  it('refuses a redirect that leaves the site', async () => {
    mock.add('/moved/', 301, '', { location: 'https://evil.test/landing' });
    const error = await expectError(discover('https://example.com/moved/'), UnprocessableError, 'PAGE_REDIRECTED');
    expect(error.details.redirect_url).toBe('https://evil.test/landing');
    expect(mock.requestedPaths()).toEqual(['/robots.txt', '/moved/']); // the off-site target is never requested
  });

  it.each([404, 410, 500])('reports a page that returns HTTP %s without storing it', async (status) => {
    mock.add('/missing/', status, 'nope', { 'content-type': 'text/html' });
    const error = await expectError(discover('https://example.com/missing/', { maxRetries: 0 }), UnprocessableError, 'PAGE_HTTP_ERROR');
    expect(error.details.http_status).toBe(status);
    expect(await pageCount()).toBe(0);
  });

  it('marks an already indexed page that now returns 404 and reports it', async () => {
    mock.html('/gone/', 'Gone soon', '<p>Here today.</p>');
    await discover('https://example.com/gone/');
    mock.add('/gone/', 404, 'nope', { 'content-type': 'text/html' });

    const error = await expectError(discover('https://example.com/gone/'), UnprocessableError, 'PAGE_HTTP_ERROR');
    expect(error.details.http_status).toBe(404);
    const stored = await row('https://example.com/gone/');
    expect(stored.http_status).toBe(404);
    expect(stored.content_html).toContain('Here today'); // stored content is kept, as in a full crawl
  });

  it('honours robots.txt', async () => {
    mock.add('/robots.txt', 200, 'User-agent: *\nDisallow: /private/\n');
    mock.html('/private/page/', 'Private', '<p>Hidden.</p>');
    await expectError(discover('https://example.com/private/page/'), UnprocessableError, 'PAGE_BLOCKED_BY_ROBOTS');
    expect(mock.requestedPaths()).toEqual(['/robots.txt']);
  });

  it('does not store a non-HTML resource', async () => {
    mock.add('/report', 200, '%PDF-1.7', { 'content-type': 'application/pdf' });
    await expectError(discover('https://example.com/report'), UnprocessableError, 'PAGE_NOT_HTML');
    expect(await pageCount()).toBe(0);
  });

  it('reports a page that cannot be fetched (network error or timeout)', async () => {
    mock.routes.set('/slow/', () => {
      throw connectError('timed out');
    });
    await expectError(discover('https://example.com/slow/', { maxRetries: 0 }), UpstreamError, 'PAGE_FETCH_FAILED');
  });

  it('keeps SSRF protection: a host resolving to a blocked address is never fetched', async () => {
    mock.routes.set('/internal/', () => {
      throw new TypeError('fetch failed', { cause: new SSRFError('Blocked by SSRF protection: 10.0.0.5 is private') });
    });
    await expectError(discover('https://example.com/internal/', { maxRetries: 0 }), UnprocessableError, 'PAGE_URL_BLOCKED');
    expect(await pageCount()).toBe(0);
  });

  it('keeps SSRF protection: disallowed ports are rejected before any request', async () => {
    await expectError(discover('https://example.com:8443/admin/'), UnprocessableError, 'START_URL_BLOCKED');
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects URLs that are not on an indexed site, or not http(s), before any request', async () => {
    await expectError(discover('https://other.test/page/'), NotFoundError, 'SITE_NOT_FOUND');
    await expectError(discover('ftp://example.com/page/'), UnprocessableError, 'INVALID_PAGE_URL');
    await expectError(discover('javascript:alert(1)'), UnprocessableError, 'INVALID_PAGE_URL');
    expect(mock.requests).toHaveLength(0);
  });

  it('accepts the www. variant of the site host', async () => {
    mock.html('/www-page/', 'WWW Page', '<p>Served on www.</p>');
    const { page } = await discover('https://www.example.com/www-page/');
    expect(page.url).toBe('https://www.example.com/www-page/');
  });

  it('waits its turn: a running crawl of the site blocks discovery', async () => {
    mock.html('/new-page/', 'New Page', '<p>Copy.</p>');
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`crawl:${site.id}`]);
      await expectError(discover('https://example.com/new-page/'), ConflictError, 'CRAWL_IN_PROGRESS');
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
    expect(await pageCount()).toBe(0);
  });
});
