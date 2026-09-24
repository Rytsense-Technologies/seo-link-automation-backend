/**
 * Single-page discovery: add (or refresh) one URL of an indexed site in the page inventory, so it
 * can be analysed straight away without waiting for the next full crawl.
 *
 * Nothing here fetches anything itself. It runs the existing SiteCrawler limited to one page
 * (no sitemaps), so robots.txt, SSRF protection, allowed ports, redirect-hop validation, scope
 * checks, URL normalisation, extraction, content_version handling and the per-site crawl lock
 * all apply exactly as in a full crawl. The regular crawl stays the source of truth for keeping
 * the whole index current.
 */

import { NotFoundError, UnprocessableError, UpstreamError } from '../utils/errors.js';
import { urlsplit } from '../utils/pyurl.js';
import { SkipReason } from './service.js';

/** Stored redirect records followed (within the site) to reach the page a URL ends up on. */
export const MAX_STORED_REDIRECTS = 5;

const bareHost = (host) => (host.startsWith('www.') ? host.slice(4) : host);

/** Why the crawl did not store the page, as an error with a stable code. */
function crawlFailure(report, url) {
  const skipped = report.skipped_reasons ?? {};
  if (report.robots?.policy === 'disallow_all' || skipped[SkipReason.ROBOTS_DISALLOWED]) {
    return new UnprocessableError("The site's robots.txt does not allow crawling this page", {
      code: 'PAGE_BLOCKED_BY_ROBOTS',
    });
  }
  if (skipped[SkipReason.NOT_HTML]) {
    return new UnprocessableError('The URL is not an HTML page', { code: 'PAGE_NOT_HTML' });
  }
  const failure = report.errors.find((e) => !e.url.endsWith('/robots.txt')) ?? null;
  if (failure?.status) {
    return new UnprocessableError(`The page returned HTTP ${failure.status}`, {
      code: 'PAGE_HTTP_ERROR',
      details: { http_status: failure.status },
    });
  }
  if (failure?.error.startsWith('Blocked by SSRF protection')) {
    return new UnprocessableError('The URL cannot be crawled', { code: 'PAGE_URL_BLOCKED' });
  }
  if (failure) {
    return new UpstreamError('The page could not be fetched', { code: 'PAGE_FETCH_FAILED', details: { reason: failure.error } });
  }
  return new UnprocessableError(`The page was not added to the index: ${url}`, { code: 'PAGE_NOT_STORED' });
}

/** The stored page a URL ends up on, following stored same-site redirect records. */
async function finalPage(pageService, siteId, resolved) {
  let current = resolved;
  for (let hop = 0; current.page.redirect_url && hop < MAX_STORED_REDIRECTS; hop += 1) {
    try {
      current = await pageService.resolvePage(current.page.redirect_url, { siteId });
    } catch (err) {
      if (!(err instanceof NotFoundError || err instanceof UnprocessableError)) throw err;
      throw new UnprocessableError('The URL redirects to a page that could not be added to the index', {
        code: 'PAGE_REDIRECTED',
        details: { redirect_url: current.page.redirect_url },
      });
    }
  }
  return current;
}

/**
 * Crawls exactly one URL of an indexed site and returns the stored page as `{ site, page }`
 * (the same shape as `resolvePage`). A URL that redirects returns the page it redirects to.
 *
 * Errors: 422 INVALID_PAGE_URL, 404 SITE_NOT_FOUND (from the site lookup); 422
 * START_URL_OUT_OF_SCOPE / START_URL_BLOCKED and 409 CRAWL_IN_PROGRESS (from the crawler); 422
 * PAGE_HTTP_ERROR (details.http_status), PAGE_BLOCKED_BY_ROBOTS, PAGE_NOT_HTML, PAGE_URL_BLOCKED,
 * PAGE_REDIRECTED, PAGE_NOT_STORED; 502 PAGE_FETCH_FAILED (timeouts, network errors).
 */
export async function discoverPage({ pageService, crawler }, rawUrl) {
  const { url, sites } = await pageService.siteForUrl(rawUrl);
  const [site] = sites;
  const siteHost = urlsplit(site.base_url).hostname ?? '';
  const includeWww = urlsplit(url).hostname !== siteHost && bareHost(urlsplit(url).hostname ?? '') === bareHost(siteHost);

  const report = await crawler.crawl(site, {
    start_url: url,
    max_pages: 1,
    use_sitemaps: false,
    include_www_variant: includeWww,
  });

  let resolved;
  try {
    resolved = await pageService.resolvePage(url, { siteId: site.id });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    throw crawlFailure(report, url);
  }
  const final = await finalPage(pageService, site.id, resolved);
  const status = final.page.http_status;
  if (status !== null && !(status >= 200 && status < 300)) {
    throw new UnprocessableError(`The page returned HTTP ${status}`, {
      code: 'PAGE_HTTP_ERROR',
      details: { http_status: status },
    });
  }
  return final;
}
