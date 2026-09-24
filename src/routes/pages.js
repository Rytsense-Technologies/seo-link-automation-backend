/** /api/pages routes (app/pages/router.py). */

import { discoverPage } from '../crawler/discover.js';
import { ERROR_RESPONSES, errorResponses, normaliseUuid, uuid } from '../schemas/common.js';

export default async function pagesRoutes(app) {
  app.get(
    '/pages',
    {
      schema: {
        tags: ['pages'],
        summary: 'List Pages',
        querystring: {
          type: 'object',
          properties: {
            site_id: { ...uuid, type: ['string', 'null'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: { $ref: 'PageList#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { site_id: siteId = null, page, page_size: pageSize } = request.query;
      const [items, total] = await app.deps
        .pageService()
        .listPages({ siteId: siteId ? normaliseUuid(siteId) : null, page, pageSize });
      return { items, total, page, page_size: pageSize };
    },
  );

  app.get(
    '/pages/resolve',
    {
      schema: {
        tags: ['pages'],
        summary: 'Resolve a URL to its indexed page',
        description: `Looks up the page a URL refers to, so a client can start from a URL instead of a page id.
The URL is normalised like the crawler does (fragment and tracking parameters removed) and matched
ignoring trailing slash, \`www.\` and scheme. The site is the one whose host the URL is on, or
\`site_id\` when given. Nothing is fetched: this only reads the page inventory.

Errors: \`422 INVALID_PAGE_URL\` (not an absolute http(s) URL, or not on \`site_id\`),
\`404 SITE_NOT_FOUND\` (no site on that host), \`404 PAGE_NOT_FOUND\` (not crawled/imported yet).`,
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            site_id: { ...uuid, type: ['string', 'null'] },
          },
          required: ['url'],
        },
        response: { 200: { $ref: 'PageResolution#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { url, site_id: siteId = null } = request.query;
      return app.deps.pageService().resolvePage(url, { siteId: siteId ? normaliseUuid(siteId) : null });
    },
  );

  app.post(
    '/pages/discover',
    {
      schema: {
        tags: ['pages'],
        summary: 'Crawl one URL into the page inventory',
        description: `Adds (or refreshes) a single page of an indexed site so it can be analysed immediately.
The site is the one whose host the URL is on. Runs the regular crawler limited to this one URL
(no sitemaps): robots.txt, SSRF protection, allowed ports, redirect-hop validation, extraction
and content versioning are exactly those of a full crawl. Only the local page inventory is
written; the website is never modified. A URL that redirects returns the page it redirects to.

Errors: \`422 INVALID_PAGE_URL | START_URL_OUT_OF_SCOPE | START_URL_BLOCKED | PAGE_HTTP_ERROR |
PAGE_BLOCKED_BY_ROBOTS | PAGE_NOT_HTML | PAGE_URL_BLOCKED | PAGE_REDIRECTED | PAGE_NOT_STORED\`,
\`404 SITE_NOT_FOUND\`, \`409 CRAWL_IN_PROGRESS\`, \`502 PAGE_FETCH_FAILED\`.`,
        body: {
          type: 'object',
          properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
          required: ['url'],
        },
        response: {
          200: { $ref: 'PageResolution#' },
          ...ERROR_RESPONSES,
          ...errorResponses({ 409: 'A crawl for this site is already running', 502: 'The page could not be fetched' }),
        },
      },
    },
    async (request) => {
      const { crawler, close } = app.deps.siteCrawler();
      try {
        return await discoverPage({ pageService: app.deps.pageService(), crawler }, request.body.url);
      } finally {
        await close();
      }
    },
  );

  app.get(
    '/pages/:page_id',
    {
      schema: {
        tags: ['pages'],
        summary: 'Get Page',
        params: { type: 'object', properties: { page_id: uuid }, required: ['page_id'] },
        response: { 200: { $ref: 'PageDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) => app.deps.pageService().getPage(normaliseUuid(request.params.page_id)),
  );
}
