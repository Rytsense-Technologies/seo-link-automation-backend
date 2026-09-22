/** Mock website (injected fetch) and in-memory crawl store (port of tests/crawler_fakes.py). */

import { createHash } from 'node:crypto';
import { urlKey } from '../../src/utils/urls.js';
import { DatabaseError } from '../../src/utils/errors.js';
import { Fetcher, fetcherConfig } from '../../src/crawler/fetcher.js';
import { SiteCrawler, crawlConfig, pageUpsert } from '../../src/crawler/service.js';

export const BASE = 'https://example.com';
export const SITE_ID = '00000000-0000-0000-0000-0000000c2a71';
export const ROBOTS_ALLOW_ALL = 'User-agent: *\nDisallow:\n';

export function htmlPage(title, body, { canonical = null, headExtra = '', nav = '<a href="/">Home</a>', footer = '© Example' } = {}) {
  const canon = canonical ? `<link rel="canonical" href="${canonical}">` : '';
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>${canon}${headExtra}</head>` +
    `<body><header><nav>${nav}</nav></header><main>${body}</main>` +
    `<footer>${footer}</footer></body></html>`
  );
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A connection-level failure like undici raises (mapped to "ConnectError"). */
export function connectError(message = 'connection reset') {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code: 'ECONNREFUSED' }) });
}

/** Routes keyed by path (+query). Values: [status, body, headers] or a responder function. */
export class MockSite {
  constructor() {
    this.routes = new Map();
    this.requests = [];
  }

  html(path, title, body, options = {}) {
    this.routes.set(path, [200, htmlPage(title, body, options), { 'content-type': 'text/html' }]);
  }

  add(path, status, body = '', headers = {}) {
    this.routes.set(path, [status, body, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.replaceAll('_', '-'), v]))]);
  }

  fetch = async (url) => {
    this.requests.push(url);
    const u = new URL(url);
    const route = this.routes.get(u.pathname + u.search) ?? this.routes.get(u.pathname);
    if (route === undefined) {
      return new Response(Buffer.from('not found'), { status: 404, headers: { 'content-type': 'text/html' } });
    }
    if (typeof route === 'function') return route({ url });
    const [status, body, headers] = route;
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    return new Response(NULL_BODY.has(status) ? null : bytes, { status, headers });
  };

  requestedPaths() {
    return this.requests.map((r) => {
      const u = new URL(r);
      return u.pathname + u.search;
    });
  }
}

export class FakeCrawlStore {
  constructor() {
    this.pages = new Map();
    this.upserts = 0;
    this.statusUpdates = [];
    this.failOn = new Set();
    this.locked = false;
  }

  async existingUrls() {
    return new Map([...this.pages.keys()].map((u) => [urlKey(u), u]));
  }

  async upsertPage(siteId, page) {
    if (this.failOn.has(page.url)) {
      throw new DatabaseError(Object.assign(new Error('db down'), { code: '08006' }));
    }
    this.pages.set(page.url, page);
    this.upserts += 1;
    return createHash('sha1').update(page.url).digest('hex');
  }

  async updateStatus(siteId, url, { httpStatus, redirectUrl }) {
    if (!this.pages.has(url)) return false;
    this.pages.set(url, { ...this.pages.get(url), http_status: httpStatus, redirect_url: redirectUrl });
    this.statusUpdates.push([url, httpStatus, redirectUrl]);
    return true;
  }

  async rollback() {}

  async siteLock(siteId, fn) {
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
    }
  }
}

export function makeSite(baseUrl = BASE) {
  return { id: SITE_ID, name: 'Example', base_url: `${baseUrl}/` };
}

export function makeCrawler(mock, store = null, config = {}) {
  const crawlStore = store ?? new FakeCrawlStore();
  const sleeps = [];
  const { maxRetries, maxRedirects, ...rest } = config;
  const fetcher = new Fetcher(
    mock.fetch,
    fetcherConfig({
      userAgent: 'SEOLinkAutomationBot/0.1',
      maxResponseBytes: rest.maxResponseBytes ?? 5_000_000,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(maxRedirects !== undefined ? { maxRedirects } : {}),
    }),
    { sleep: (s) => sleeps.push(s) },
  );
  const crawler = new SiteCrawler(crawlStore, fetcher, crawlConfig({ requestDelaySeconds: 0.0, ...rest }), {
    sleep: (s) => sleeps.push(s),
  });
  return [crawler, crawlStore, sleeps];
}

/** CrawlRequest defaults as Fastify/Pydantic apply them. */
export function crawlRequest(overrides = {}) {
  return { start_url: null, max_pages: 100, use_sitemaps: true, include_www_variant: false, ...overrides };
}

export const oldPage = (url) => pageUpsert({ url, title: 'old', content_html: '<p>old content</p>' });
