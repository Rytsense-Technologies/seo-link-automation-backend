// POST /api/pages/discover: route wiring, the exact (minimal) crawl it requests, and error pass-through.
// Crawl + storage behaviour is covered against PostgreSQL in test/integration/discover-postgres.test.js.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ConflictError, NotFoundError } from '../../src/utils/errors.js';
import { cleanSettings } from '../helpers/fakes.js';

const SITE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example',
  base_url: 'https://example.com/',
  default_language: 'en',
  default_region: null,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
};
const PAGE = {
  id: '22222222-2222-4222-8222-222222222222',
  site_id: SITE.id,
  url: 'https://example.com/new-page/',
  title: 'New Page',
  h1: 'New Page',
  meta_description: null,
  canonical_url: null,
  http_status: 200,
  redirect_url: null,
  is_indexable: true,
  has_noindex: false,
  language: 'en',
  region: null,
  page_type: null,
  keywords: [],
  outgoing_links: [],
  content_version: 1,
  last_crawled_at: '2026-09-23T10:00:00.000Z',
  created_at: '2026-09-23T10:00:00.000Z',
  updated_at: '2026-09-23T10:00:00.000Z',
};

let app;
let crawls;
let closed;
let crawlImpl;
let siteForUrl;

beforeEach(async () => {
  crawls = [];
  closed = 0;
  crawlImpl = async () => ({ errors: [], skipped_reasons: {}, robots: { policy: 'allow_all' } });
  siteForUrl = async (url) => ({ url, candidates: [url], sites: [SITE] });
  app = await buildApp({
    settings: cleanSettings(),
    deps: {
      pageService: () => ({
        siteForUrl: (url) => siteForUrl(url),
        resolvePage: async () => ({ site: SITE, page: PAGE }),
      }),
      siteCrawler: () => ({
        crawler: {
          crawl: async (site, request) => {
            crawls.push({ site, request });
            return crawlImpl();
          },
        },
        close: async () => {
          closed += 1;
        },
      }),
    },
  });
});
afterEach(async () => {
  await app.close();
});

const discover = (payload) => app.inject({ method: 'POST', url: '/api/pages/discover', payload });

describe('POST /api/pages/discover', () => {
  it('crawls exactly the one URL (no sitemaps) and returns the stored page and its site', async () => {
    const res = await discover({ url: 'https://example.com/new-page/' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ site: SITE, page: PAGE });
    expect(crawls).toEqual([
      {
        site: SITE,
        request: { start_url: 'https://example.com/new-page/', max_pages: 1, use_sitemaps: false, include_www_variant: false },
      },
    ]);
    expect(closed).toBe(1);
  });

  it('includes the www. variant only when the URL uses it', async () => {
    await discover({ url: 'https://www.example.com/new-page/' });
    expect(crawls[0].request.include_www_variant).toBe(true);
  });

  it('requires a url', async () => {
    const res = await discover({});
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(crawls).toHaveLength(0);
  });

  it('does not crawl a URL on a host no site uses', async () => {
    siteForUrl = async () => {
      throw new NotFoundError('No indexed website matches this URL', { code: 'SITE_NOT_FOUND' });
    };
    const res = await discover({ url: 'https://other.test/page/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SITE_NOT_FOUND');
    expect(crawls).toHaveLength(0);
  });

  it('passes crawler conflicts through, and always closes the HTTP client', async () => {
    crawlImpl = async () => {
      throw new ConflictError('A crawl for this site is already running', { code: 'CRAWL_IN_PROGRESS' });
    };
    const res = await discover({ url: 'https://example.com/new-page/' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CRAWL_IN_PROGRESS');
    expect(closed).toBe(1);
  });

  it('never returns page content', async () => {
    const res = await discover({ url: 'https://example.com/new-page/' });
    expect(res.json().page).not.toHaveProperty('content_html');
  });
});
