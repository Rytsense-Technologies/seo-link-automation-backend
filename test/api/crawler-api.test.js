// Port of tests/api/test_crawler_api.py — POST /api/sites/{site_id}/crawl (mock website, in-memory store).
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NotFoundError } from '../../src/utils/errors.js';
import { cleanSettings } from '../helpers/fakes.js';
import { BASE, MockSite, ROBOTS_ALLOW_ALL, makeCrawler, makeSite } from '../helpers/crawler-fakes.js';

class FakePages {
  constructor(site) {
    this.site = site;
  }

  async getSite(siteId) {
    if (siteId !== this.site.id) throw new NotFoundError('Site not found', { code: 'SITE_NOT_FOUND' });
    return this.site;
  }
}

let app;

beforeEach(async () => {
  const mock = new MockSite();
  mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
  mock.html('/', 'Home', '<p><a href="/about/">About us</a></p>');
  mock.html('/about/', 'About', '<p>About copy.</p>');
  const site = makeSite();
  app = await buildApp({
    settings: cleanSettings(),
    deps: {
      pageService: () => new FakePages(site),
      siteCrawler: () => ({ crawler: makeCrawler(mock)[0], close: async () => {} }),
    },
  });
});
afterEach(async () => {
  await app.close();
});

const crawl = (siteId, payload) =>
  app.inject({ method: 'POST', url: `/api/sites/${siteId}/crawl`, ...(payload !== undefined ? { payload } : {}) });

describe('crawl API', () => {
  it('returns the crawl report', async () => {
    const siteId = makeSite().id;
    const res = await crawl(siteId, { start_url: `${BASE}/`, max_pages: 100 });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.site_id).toBe(siteId);
    expect(body.start_url).toBe(`${BASE}/`);
    expect(body.pages_discovered).toBe(2);
    expect(body.pages_crawled).toBe(2);
    expect(body.pages_created).toBe(2);
    expect(body.pages_updated).toBe(0);
    expect(body.pages_skipped).toBe(0);
    expect(body.errors).toEqual([]);
    expect(body.robots.policy).toBe('parsed');
    for (const key of ['sitemaps_processed', 'skipped_reasons', 'max_pages_reached', 'duration_seconds']) {
      expect(body).toHaveProperty(key);
    }
  });

  it('the body is optional and defaults to the site base URL', async () => {
    const res = await crawl(makeSite().id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().start_url).toBe(`${BASE}/`);
  });

  it('validation and not found', async () => {
    const siteId = makeSite().id;
    for (const body of [{ max_pages: 0 }, { max_pages: 5000 }, { start_url: 'not a url' }]) {
      const res = await crawl(siteId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    let res = await crawl(siteId, { start_url: 'https://other.com/' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('START_URL_OUT_OF_SCOPE');
    res = await crawl(randomUUID(), {});
    expect(res.statusCode).toBe(404);
    expect((await crawl('not-a-uuid', {})).statusCode).toBe(422);
  });

  it('OpenAPI documents the crawl endpoint', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const op = spec.paths['/api/sites/{site_id}/crawl'].post;
    expect(op.responses).toHaveProperty('409');
    expect(op.responses).toHaveProperty('422');
    expect(spec.components.schemas).toHaveProperty('CrawlRequest');
    expect(spec.components.schemas).toHaveProperty('CrawlResponse');
  });
});
