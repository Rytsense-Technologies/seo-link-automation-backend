// Port of tests/integration/test_crawler_postgres.py — crawler persistence against real PostgreSQL (mock website; no network).
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgCrawlStore } from '../../src/crawler/store.js';
import { PageService } from '../../src/db/queries/pages.js';
import { ExclusionReason, filterCandidates } from '../../src/interlink/candidate-filter.js';
import { PgInterlinkRepository, PgSession } from '../../src/interlink/repository.js';
import { ConflictError } from '../../src/utils/errors.js';
import { ROBOTS_ALLOW_ALL, MockSite, crawlRequest, makeCrawler } from '../helpers/crawler-fakes.js';
import { interlinkConfig } from '../../src/interlink/service.js';
import { DB_URL, closeTestDatabase, openTestDatabase, truncate } from './db.js';

const BASE = 'https://example.com';
const FIXTURE = new URL('../../tests/fixtures/next_redirect_error_shell.html', import.meta.url);

function mockSite() {
  const mock = new MockSite();
  mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
  mock.html(
    '/',
    'Home',
    '<p><a href="/services/">Services</a> <a href="/services">again</a> <a href="/services/?utm_source=x#top">tracked</a></p>',
  );
  mock.html('/services/', 'Services', '<p>We build AI voice agents.</p>');
  return mock;
}

describe.skipIf(!DB_URL)('crawler + PostgreSQL', () => {
  let pool;

  beforeAll(async () => {
    pool = await openTestDatabase();
  });
  afterAll(async () => {
    if (pool) await closeTestDatabase(pool);
  });
  beforeEach(async () => {
    await truncate(pool);
  });

  const createSite = () => new PageService(pool).createSite({ name: 'Ex', base_url: BASE });

  async function crawl(siteId, mock) {
    const [crawler] = makeCrawler(mock, new PgCrawlStore(pool));
    const site = await new PageService(pool).getSite(siteId);
    return crawler.crawl(site, crawlRequest({ use_sitemaps: false }));
  }

  async function pages(siteId) {
    const { rows } = await pool.query('SELECT * FROM pages WHERE site_id = $1', [siteId]);
    return Object.fromEntries(rows.map((r) => [r.url, r]));
  }

  it('crawl inserts then updates without duplicates', async () => {
    const site = await createSite();
    const mock = mockSite();

    const first = await crawl(site.id, mock);
    expect([first.pages_created, first.pages_updated]).toEqual([2, 0]);
    let rows = await pages(site.id);
    expect(new Set(Object.keys(rows))).toEqual(new Set([`${BASE}/`, `${BASE}/services/`]));
    const services = rows[`${BASE}/services/`];
    expect(services.title).toBe('Services');
    expect(services.http_status).toBe(200);
    expect(services.content_html ?? '').toContain('AI voice agents');
    expect(rows[`${BASE}/`].outgoing_links).toEqual([`${BASE}/services/`]);
    expect(services.content_version).toBe(1);

    // Unchanged re-crawl: same rows, no version bump.
    const second = await crawl(site.id, mock);
    expect([second.pages_created, second.pages_updated]).toEqual([0, 2]);
    expect((await pages(site.id))[`${BASE}/services/`].content_version).toBe(1);

    // Changed content: row updated in place, version bumped.
    mock.html('/services/', 'Services v2', '<p>Now with CRM integration.</p>');
    const third = await crawl(site.id, mock);
    expect(third.pages_created).toBe(0);
    rows = await pages(site.id);
    expect(Object.keys(rows)).toHaveLength(2);
    expect(rows[`${BASE}/services/`].title).toBe('Services v2');
    expect(rows[`${BASE}/services/`].content_version).toBe(2);
    const { rows: count } = await pool.query('SELECT count(*)::int AS n FROM pages WHERE site_id = $1', [site.id]);
    expect(count[0].n).toBe(2);
  });

  it('an error status update keeps existing content', async () => {
    const site = await createSite();
    const mock = mockSite();
    await crawl(site.id, mock);
    mock.add('/services/', 404, 'gone', { content_type: 'text/html' });
    const report = await crawl(site.id, mock);
    expect(report.errors.some((e) => e.status === 404)).toBe(true);
    const services = (await pages(site.id))[`${BASE}/services/`];
    expect(services.http_status).toBe(404);
    expect(services.content_html ?? '').toContain('AI voice agents');
  });

  it('a concurrent crawl of the same site is rejected', async () => {
    const site = await createSite();
    const first = new PgCrawlStore(pool);
    const second = new PgCrawlStore(pool);
    await first.siteLock(site.id, async () => {
      const err = await second.siteLock(site.id, async () => {}).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('CRAWL_IN_PROGRESS');
    });
    await second.siteLock(site.id, async () => {}); // released after the first crawl finishes
  });

  it('HTML-redirect and empty pages are excluded from interlinking', async () => {
    const site = await createSite();
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<p>Try our <a href="/ai-readiness-assessment/">assessment</a>.</p>');
    mock.routes.set('/ai-readiness-assessment/', [200, fs.readFileSync(FIXTURE, 'utf8'), { 'content-type': 'text/html' }]);
    mock.html('/us/ai-readiness-assessment/', 'AI Readiness Assessment', '<p>Assessment.</p>');
    const report = await crawl(site.id, mock);
    expect(report.html_redirects).toBe(1);

    const rows = await pages(site.id);
    const redirecting = rows[`${BASE}/ai-readiness-assessment/`];
    expect(redirecting.http_status).toBe(200);
    expect(redirecting.is_indexable).toBe(false);
    expect(redirecting.redirect_url).toBe(`${BASE}/us/ai-readiness-assessment/`);
    expect(rows[`${BASE}/us/ai-readiness-assessment/`].is_indexable).toBe(true);

    // Same shape as the pre-existing empty row: indexable=true, no title/H1, empty content.
    await new PageService(pool).upsertPages(site.id, [{ url: '/legacy-empty/', title: null, h1: null, content_html: '' }]);
    const session = new PgSession(pool);
    try {
      const repo = new PgInterlinkRepository(session);
      const source = await repo.getPage(rows[`${BASE}/`].id);
      expect(source).not.toBeNull();
      const candidatePool = await repo.listCandidatePool(source);
      expect(candidatePool.map((p) => p.url)).not.toContain(`${BASE}/ai-readiness-assessment/`); // SQL pre-filter
      const result = filterCandidates(source, candidatePool, interlinkConfig().filters);
      expect((result.excluded.get(ExclusionReason.EMPTY_CONTENT) ?? []).map((p) => p.url)).toEqual([`${BASE}/legacy-empty/`]);
      expect(new Set(result.accepted.map((p) => p.url))).toEqual(new Set([`${BASE}/us/ai-readiness-assessment/`]));
    } finally {
      await session.close();
    }
  });
});
