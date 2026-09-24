// GET /api/pages/resolve: route wiring, validation and error pass-through (lookup logic is covered
// by the PostgreSQL integration suite and the pageUrlCandidates unit tests).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NotFoundError, UnprocessableError } from '../../src/utils/errors.js';
import { cleanSettings } from '../helpers/fakes.js';

const SITE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Example',
  base_url: 'https://www.example.com/',
  default_language: 'en',
  default_region: null,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
};
const PAGE = {
  id: '22222222-2222-4222-8222-222222222222',
  site_id: SITE.id,
  url: 'https://www.example.com/services/',
  title: 'Services',
  h1: 'Our services',
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
  last_crawled_at: null,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
};

let app;
let calls;
let result;

beforeEach(async () => {
  calls = [];
  result = async () => ({ site: SITE, page: PAGE });
  app = await buildApp({
    settings: cleanSettings(),
    deps: {
      pageService: () => ({
        resolvePage: async (url, options) => {
          calls.push({ url, options });
          return result();
        },
      }),
    },
  });
});
afterEach(async () => {
  await app.close();
});

const resolve = (query) => app.inject({ method: 'GET', url: '/api/pages/resolve', query });

describe('GET /api/pages/resolve', () => {
  it('returns the page and its site for a URL', async () => {
    const res = await resolve({ url: 'https://www.example.com/services' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ site: SITE, page: PAGE });
    expect(calls).toEqual([{ url: 'https://www.example.com/services', options: { siteId: null } }]);
  });

  it('passes an optional site_id through, normalised', async () => {
    await resolve({ url: 'https://www.example.com/services', site_id: SITE.id.toUpperCase() });
    expect(calls[0].options).toEqual({ siteId: SITE.id });
  });

  it('never exposes page content', async () => {
    result = async () => ({ site: SITE, page: { ...PAGE, content_html: '<p>secret draft</p>' } });
    const body = (await resolve({ url: PAGE.url })).json();
    expect(body.page).not.toHaveProperty('content_html');
  });

  it('requires a url', async () => {
    const res = await resolve({});
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed site_id before looking anything up', async () => {
    const res = await resolve({ url: PAGE.url, site_id: 'rytsense' });
    expect(res.statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [new UnprocessableError('URL is not an absolute http(s) URL: x', { code: 'INVALID_PAGE_URL' }), 422, 'INVALID_PAGE_URL'],
    [new NotFoundError('No indexed website matches this URL', { code: 'SITE_NOT_FOUND' }), 404, 'SITE_NOT_FOUND'],
    [new NotFoundError('Page not found in the indexed website', { code: 'PAGE_NOT_FOUND' }), 404, 'PAGE_NOT_FOUND'],
  ])('returns the standard error envelope (%s)', async (error, status, code) => {
    result = async () => {
      throw error;
    };
    const res = await resolve({ url: 'https://www.example.com/missing/' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: error.message, details: null } });
  });

  it('is not shadowed by GET /api/pages/:page_id', async () => {
    const res = await resolve({ url: PAGE.url });
    expect(res.statusCode).toBe(200);
  });
});
