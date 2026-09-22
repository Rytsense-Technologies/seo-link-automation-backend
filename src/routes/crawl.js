/** POST /api/sites/:site_id/crawl (app/crawler/router.py). */

import { ERROR_RESPONSES, errorResponses, normaliseUuid, uuid } from '../schemas/common.js';

const DESCRIPTION = `Reads robots.txt (RFC 9309) and honours it, discovers URLs from sitemaps
(robots \`Sitemap:\` lines, sitemap indexes, or \`/sitemap.xml\`) and same-host HTML links,
then inserts or updates rows in \`pages\` (keyed by normalised URL, so re-running is safe).

Only the site's own host is crawled (plus the \`www.\` variant when
\`include_www_variant\` is true). All requests are SSRF-guarded: public IPs only, ports
80/443, no credentials in URLs, and every redirect hop is re-validated.

Crawling only reads the website; it never modifies it. Links are still applied only
through the approve/apply workflow.`;

export default async function crawlRoutes(app) {
  app.post(
    '/sites/:site_id/crawl',
    {
      // FastAPI: `Body(default_factory=CrawlRequest)` -> the body is optional.
      config: { body: 'factory' },
      schema: {
        tags: ['crawler'],
        summary: 'Crawl the site and update its page inventory',
        description: DESCRIPTION,
        params: { type: 'object', properties: { site_id: uuid }, required: ['site_id'] },
        body: { $ref: 'CrawlRequest#' },
        response: {
          200: { $ref: 'CrawlResponse#' },
          ...ERROR_RESPONSES,
          ...errorResponses({ 409: 'A crawl for this site is already running' }),
        },
      },
    },
    async (request) => {
      const site = await app.deps.pageService().getSite(normaliseUuid(request.params.site_id));
      const { crawler, close } = app.deps.siteCrawler();
      try {
        return await crawler.crawl(site, request.body);
      } finally {
        await close();
      }
    },
  );
}
