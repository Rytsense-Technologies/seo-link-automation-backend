/**
 * Site crawler: robots.txt -> sitemaps -> BFS over same-site HTML pages -> `pages` table
 * (app/crawler/service.py).
 *
 * The crawler only reads the website and writes the local page inventory. It never modifies the
 * live site; internal links are still applied only through the manual approval workflow.
 */

import { performance } from 'node:perf_hooks';
import { AppError, DatabaseError, UnprocessableError } from '../utils/errors.js';
import { urlKey } from '../utils/urls.js';
import { urlsplit, urlunsplit } from '../utils/pyurl.js';
import { pyCompare, pyLen } from '../utils/pytext.js';
import { extractPage } from './extract.js';
import { FetchError } from './fetcher.js';
import { RobotsRules, parseRobots } from './robots.js';
import { SitemapError, parseSitemap } from './sitemap.js';
import { SSRFError, validateUrl } from './ssrf.js';
import { SiteScope, isAsset, looksLikeTrap, normalizeCrawlUrl } from './urls.js';
import { logger } from '../utils/logger.js';

export const MAX_REPORTED_ERRORS = 200;
export const SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,*/*;q=0.5';

export const SkipReason = Object.freeze({
  ROBOTS_DISALLOWED: 'ROBOTS_DISALLOWED',
  NOT_HTML: 'NOT_HTML',
  MAX_PAGES_REACHED: 'MAX_PAGES_REACHED',
  DUPLICATE_FINAL_URL: 'DUPLICATE_FINAL_URL',
  UNEXPECTED_STATUS: 'UNEXPECTED_STATUS',
  DISCOVERY_LIMIT: 'DISCOVERY_LIMIT',
});

/** Informational classifications of stored pages (not skips). */
export const PageCondition = Object.freeze({
  HTML_REDIRECT: 'HTML_REDIRECT',
  UNUSABLE_CONTENT: 'UNUSABLE_CONTENT',
});

export function crawlConfig(overrides = {}) {
  return {
    requestDelaySeconds: 0.5,
    maxCrawlDelaySeconds: 10.0,
    maxPagesLimit: 1000,
    maxSitemaps: 50,
    maxResponseBytes: 5_000_000,
    allowedPorts: [80, 443],
    userAgent: 'SEOLinkAutomationBot/0.1',
    // URLs tracked for de-duplication/reporting: max(maxPages * factor, minDiscoveryLimit).
    // Only `maxPages` are fetched; this just bounds memory on huge/trap sites.
    discoveryFactor: 10,
    minDiscoveryLimit: 10_000,
    ...overrides,
  };
}

/** Mirrors pydantic's PageUpsert construction (defaults + field constraints). */
export class PageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function pageUpsert(fields) {
  const page = {
    url: fields.url,
    title: fields.title ?? null,
    h1: fields.h1 ?? null,
    meta_description: fields.meta_description ?? null,
    content_html: fields.content_html ?? null,
    canonical_url: fields.canonical_url ?? null,
    http_status: fields.http_status === undefined ? 200 : fields.http_status,
    redirect_url: fields.redirect_url ?? null,
    is_indexable: fields.is_indexable ?? true,
    has_noindex: fields.has_noindex ?? false,
    language: fields.language ?? null,
    region: fields.region ?? null,
    page_type: fields.page_type ?? null,
    keywords: fields.keywords ?? [],
    outgoing_links: fields.outgoing_links === undefined ? null : fields.outgoing_links,
    last_crawled_at: fields.last_crawled_at ?? null,
  };
  const maxLen = { url: 2048, canonical_url: 2048, redirect_url: 2048, language: 16, region: 16, page_type: 64 };
  const len = pyLen(page.url ?? '');
  if (len < 1 || len > 2048) throw new PageValidationError('url length');
  for (const [key, limit] of Object.entries(maxLen)) {
    if (page[key] !== null && pyLen(page[key]) > limit) throw new PageValidationError(`${key} too long`);
  }
  if (page.http_status !== null && !(page.http_status >= 100 && page.http_status <= 599)) {
    throw new PageValidationError('http_status range');
  }
  if (page.keywords.length > 100) throw new PageValidationError('too many keywords');
  return page;
}

class Report {
  constructor() {
    this.robots = null;
    this.sitemapsProcessed = 0;
    this.crawled = 0;
    this.created = 0;
    this.updated = 0;
    this.skipped = new Map();
    this.conditions = new Map();
    this.errors = [];
    this.errorsTruncated = false;
  }

  count(map, key, n = 1) {
    map.set(key, (map.get(key) ?? 0) + n);
  }

  error(url, message, status = null) {
    if (this.errors.length >= MAX_REPORTED_ERRORS) {
      this.errorsTruncated = true;
      return;
    }
    this.errors.push({ url, error: message, status });
  }
}

const sleepReal = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const nowSeconds = () => performance.now() / 1000;

/** Python `round(x, 3)` (half-even on the decimal representation is not observable here). */
const round3 = (x) => Math.round(x * 1000) / 1000;

export class SiteCrawler {
  constructor(store, fetcher, config, { sleep = sleepReal, clock = nowSeconds } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.config = config;
    this.sleep = sleep;
    this.clock = clock;
    this.requestsMade = 0;
    this.delay = config.requestDelaySeconds;
    this.discovered = 0;
  }

  // ------------------------------------------------------------------ entry point
  async crawl(site, request) {
    const started = this.clock();
    const scope = SiteScope.forSite(site.base_url, { includeWwwVariant: request.include_www_variant });
    const startUrl = normalizeCrawlUrl(String(request.start_url ?? site.base_url));
    if (startUrl === null || !scope.contains(startUrl)) {
      throw new UnprocessableError("start_url must be an http(s) URL on the site's host", {
        code: 'START_URL_OUT_OF_SCOPE',
        details: { allowed_hosts: [...scope.hosts].sort(pyCompare) },
      });
    }
    try {
      validateUrl(startUrl, { allowedPorts: this.config.allowedPorts });
    } catch (err) {
      if (err instanceof SSRFError) throw new UnprocessableError(err.message, { code: 'START_URL_BLOCKED' });
      throw err;
    }
    const maxPages = Math.min(request.max_pages, this.config.maxPagesLimit);

    const report = await this.store.siteLock(site.id, () =>
      this.run(site, scope, startUrl, maxPages, request.use_sitemaps),
    );

    return {
      site_id: site.id,
      start_url: startUrl,
      robots: report.robots,
      sitemaps_processed: report.sitemapsProcessed,
      pages_discovered: this.discovered,
      pages_crawled: report.crawled,
      pages_created: report.created,
      pages_updated: report.updated,
      pages_skipped: [...report.skipped.values()].reduce((a, b) => a + b, 0),
      skipped_reasons: Object.fromEntries(report.skipped),
      max_pages_reached: (report.skipped.get(SkipReason.MAX_PAGES_REACHED) ?? 0) > 0,
      html_redirects: report.conditions.get(PageCondition.HTML_REDIRECT) ?? 0,
      unusable_pages: report.conditions.get(PageCondition.UNUSABLE_CONTENT) ?? 0,
      errors: report.errors,
      errors_truncated: report.errorsTruncated,
      duration_seconds: round3(this.clock() - started),
    };
  }

  // ------------------------------------------------------------------ crawl
  async run(site, scope, startUrl, maxPages, useSitemaps) {
    const report = new Report();
    const start = urlsplit(startUrl);
    const origin = urlunsplit([start.scheme, start.netloc, '', '', '']);
    const robots = await this.loadRobots(origin, scope, report);
    this.delay = Math.max(
      this.config.requestDelaySeconds,
      Math.min(robots.crawlDelay || 0.0, this.config.maxCrawlDelaySeconds),
    );
    this.discovered = 0;
    if (robots.disallowAll) {
      report.error(`${origin}/robots.txt`, 'robots.txt disallows crawling this site');
      return report;
    }

    const existing = await this.store.existingUrls(site.id);
    const queue = [];
    const seen = new Set();
    const processed = new Set();
    const discoveryCap = Math.max(maxPages * this.config.discoveryFactor, this.config.minDiscoveryLimit);

    const enqueue = (raw, base = null) => {
      const url = normalizeCrawlUrl(raw, base);
      if (url === null || !scope.contains(url) || isAsset(url) || looksLikeTrap(url)) return;
      const key = urlKey(url);
      if (seen.has(key)) return;
      if (seen.size >= discoveryCap) {
        report.count(report.skipped, SkipReason.DISCOVERY_LIMIT);
        return;
      }
      seen.add(key);
      this.discovered += 1;
      if (!robots.canFetch(url)) {
        report.count(report.skipped, SkipReason.ROBOTS_DISALLOWED);
        return;
      }
      queue.push(url);
    };

    enqueue(startUrl);
    if (useSitemaps) {
      for (const pageUrl of await this.discoverSitemapUrls(origin, scope, robots, report)) enqueue(pageUrl);
    }

    const mayFollow = (target) => {
      const normalised = normalizeCrawlUrl(target);
      return Boolean(normalised && scope.contains(normalised) && robots.canFetch(normalised) && !isAsset(normalised));
    };

    let head = 0;
    while (head < queue.length) {
      if (report.crawled >= maxPages) {
        report.count(report.skipped, SkipReason.MAX_PAGES_REACHED, queue.length - head);
        break;
      }
      const url = queue[head];
      head += 1;
      if (processed.has(urlKey(url))) continue;
      processed.add(urlKey(url));
      await this.pause();
      report.crawled += 1;
      let result;
      try {
        result = await this.fetcher.fetch(url, { mayFollow });
      } catch (err) {
        if (err instanceof FetchError) {
          report.error(url, err.message, err.status);
        } else {
          // one broken page must never stop the crawl
          logger.error({ err }, `Unexpected error fetching ${url}`);
          report.error(url, `Unexpected error: ${errorName(err)}`);
        }
        continue;
      }
      try {
        await this.handleResult(site, scope, url, result, existing, processed, enqueue, report);
      } catch (err) {
        await this.store.rollback();
        if (err instanceof DatabaseError || err instanceof AppError) {
          logger.warn(`Failed to store ${url}: ${err.message}`);
          report.error(url, `Failed to store page: ${errorName(err)}`, result.status);
        } else {
          logger.error({ err }, `Unexpected error processing ${url}`);
          report.error(url, `Unexpected error: ${errorName(err)}`, result.status);
        }
      }
    }

    logger.info(
      `Crawl of ${site.base_url}: discovered=${this.discovered} crawled=${report.crawled} ` +
        `created=${report.created} updated=${report.updated} errors=${report.errors.length}`,
    );
    return report;
  }

  async handleResult(site, scope, requested, result, existing, processed, enqueue, report) {
    // Record every redirect hop so interlinking never targets a redirecting URL.
    for (const [hopUrl, hopStatus, location] of result.redirects) {
      const hop = normalizeCrawlUrl(hopUrl);
      const target = normalizeCrawlUrl(location) || location;
      if (hop === null) continue;
      await this.save(
        site,
        pageUpsert({
          url: existing.get(urlKey(hop)) ?? hop,
          http_status: hopStatus,
          redirect_url: target,
          last_crawled_at: new Date().toISOString(),
        }),
        existing,
        report,
        { statusOnly: true },
      );
    }
    if (result.blockedRedirect !== null) return; // redirect leaves the site / is disallowed

    const final = normalizeCrawlUrl(result.finalUrl) || requested;
    const finalKey = urlKey(final);
    if (finalKey !== urlKey(requested)) {
      if (processed.has(finalKey)) {
        report.count(report.skipped, SkipReason.DUPLICATE_FINAL_URL);
        return;
      }
      processed.add(finalKey);
    }
    const storedUrl = existing.get(finalKey) ?? final;
    const status = result.status;

    if (status >= 200 && status < 300) {
      if (!result.isHtml) {
        report.count(report.skipped, SkipReason.NOT_HTML);
        return;
      }
      const page = extractPage(result.text(), final, { xRobotsTag: result.headers.get('x-robots-tag') });
      const htmlRedirectUrl = this.resolveHtmlRedirect(page.htmlRedirect, final, finalKey, scope, enqueue, report);
      for (const link of page.links) enqueue(link, null);
      if (page.canonicalUrl) enqueue(page.canonicalUrl, null);
      // Internal contextual links only (same site, not assets, not self-links).
      // One entry per page (/a and /a/ are the same page), using the stored URL form.
      const contentLinks = new Map();
      for (const link of page.contentLinks) {
        const key = urlKey(link);
        if (scope.contains(link) && !isAsset(link) && key !== finalKey && !contentLinks.has(key)) {
          contentLinks.set(key, existing.get(key) ?? link);
        }
      }
      await this.save(
        site,
        pageUpsert({
          url: storedUrl,
          title: page.title,
          h1: page.h1,
          meta_description: page.metaDescription,
          content_html: page.contentHtml,
          canonical_url: page.canonicalUrl,
          http_status: status,
          // An HTML-level redirect is stored like an HTTP redirect (the true HTTP status is
          // kept): interlink filters exclude pages with redirect_url.
          redirect_url: htmlRedirectUrl,
          // Redirecting or content-less pages are not usable content pages.
          is_indexable: !page.noindex && htmlRedirectUrl === null && !page.isEmpty,
          has_noindex: page.noindex,
          language: page.language,
          keywords: page.keywords,
          outgoing_links: [...contentLinks.values()],
          last_crawled_at: new Date().toISOString(),
        }),
        existing,
        report,
      );
      if (page.isEmpty && htmlRedirectUrl === null) report.count(report.conditions, PageCondition.UNUSABLE_CONTENT);
    } else if (status >= 400) {
      report.error(requested, `HTTP ${status}`, status);
      // Keep stored content; only mark the existing page's new status.
      if (
        existing.has(finalKey) &&
        (await this.store.updateStatus(site.id, existing.get(finalKey), { httpStatus: status, redirectUrl: null }))
      ) {
        report.updated += 1;
      }
    } else {
      report.count(report.skipped, SkipReason.UNEXPECTED_STATUS);
    }
  }

  /**
   * Validate an HTML-declared redirect; queue it when safe. Returns the URL to store. The raw
   * target comes from page markup/script data and is untrusted: it goes through the same
   * normalisation, scope, SSRF (and, via `enqueue`, robots/asset/trap) checks as any discovered
   * link. Unsafe or unparseable targets are reported and ignored.
   */
  resolveHtmlRedirect(redirect, pageUrl, pageKey, scope, enqueue, report) {
    if (redirect === null) return null;
    if (redirect.hasUnsafeScheme) {
      report.error(pageUrl, `Ignored unsafe ${redirect.type} target`, 200);
      return null;
    }
    const target = normalizeCrawlUrl(redirect.target, pageUrl);
    if (target === null) {
      report.error(pageUrl, `Ignored invalid ${redirect.type} target`, 200);
      return null;
    }
    if (urlKey(target) === pageKey) return null; // redirect to itself: nothing to follow
    report.count(report.conditions, PageCondition.HTML_REDIRECT);
    try {
      validateUrl(target, { allowedPorts: this.config.allowedPorts });
    } catch (err) {
      if (!(err instanceof SSRFError)) throw err;
      // Still a redirect in a browser (so the page is not a content page); never followed.
      report.error(pageUrl, `${redirect.type} target blocked by SSRF protection`, 200);
      return target;
    }
    if (scope.contains(target)) {
      enqueue(target, null); // also applies robots / asset / trap / duplicate checks
    } else {
      logger.info(`${redirect.type} on ${pageUrl} points off-site (${target}); not followed`);
    }
    return target;
  }

  async save(site, page, existing, report, { statusOnly = false } = {}) {
    const key = urlKey(page.url);
    if (existing.has(key)) {
      if (statusOnly) {
        await this.store.updateStatus(site.id, existing.get(key), {
          httpStatus: page.http_status,
          redirectUrl: page.redirect_url,
        });
      } else {
        await this.store.upsertPage(site.id, page);
      }
      report.updated += 1;
    } else {
      await this.store.upsertPage(site.id, page);
      existing.set(key, page.url);
      report.created += 1;
    }
  }

  // ------------------------------------------------------------------ robots / sitemaps
  async pause() {
    if (this.requestsMade && this.delay > 0) await this.sleep(this.delay);
    this.requestsMade += 1;
  }

  async loadRobots(origin, scope, report) {
    const url = `${origin}/robots.txt`;
    await this.pause();
    let rules;
    try {
      const result = await this.fetcher.fetch(url, {
        mayFollow: (u) => scope.contains(u),
        accept: 'text/plain,*/*;q=0.5',
      });
      if (result.blockedRedirect !== null || result.status >= 500) {
        rules = RobotsRules.disallowingAll(result.status);
      } else if (result.status >= 400 && result.status < 500) {
        rules = RobotsRules.allowingAll(result.status);
      } else if (result.status >= 200 && result.status < 300) {
        rules = parseRobots(result.text(), this.config.userAgent);
        rules.sourceStatus = result.status;
      } else {
        rules = RobotsRules.disallowingAll(result.status);
      }
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      // RFC 9309: unreachable robots.txt -> assume complete disallow.
      report.error(url, `robots.txt unreachable: ${err.message}`, err.status);
      rules = RobotsRules.disallowingAll(err.status);
    }
    const policy = rules.disallowAll ? 'disallow_all' : rules.allowAll ? 'allow_all' : 'parsed';
    report.robots = {
      status: rules.sourceStatus,
      policy,
      sitemaps: rules.sitemaps,
      crawl_delay: rules.crawlDelay,
    };
    return rules;
  }

  async discoverSitemapUrls(origin, scope, robots, report) {
    const declared = robots.sitemaps.map((s) => normalizeCrawlUrl(s)).filter(Boolean);
    const pending = declared.filter((u) => scope.contains(u)).map((u) => [u, true]);
    for (const u of declared) {
      if (!scope.contains(u)) report.error(u, 'Sitemap is outside the site scope; ignored');
    }
    if (!pending.length) pending.push([`${origin}/sitemap.xml`, false]); // conventional location
    const seen = new Set();
    const pages = [];
    while (pending.length && report.sitemapsProcessed < this.config.maxSitemaps) {
      const [sitemapUrl, declaredInRobots] = pending.shift();
      if (seen.has(sitemapUrl) || !robots.canFetch(sitemapUrl)) continue;
      seen.add(sitemapUrl);
      await this.pause();
      let result;
      try {
        result = await this.fetcher.fetch(sitemapUrl, { mayFollow: (u) => scope.contains(u), accept: SITEMAP_ACCEPT });
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        report.error(sitemapUrl, `Sitemap fetch failed: ${err.message}`, err.status);
        continue;
      }
      if (result.status !== 200) {
        if (declaredInRobots || result.status !== 404) {
          report.error(sitemapUrl, `Sitemap HTTP ${result.status}`, result.status);
        }
        continue;
      }
      report.sitemapsProcessed += 1;
      let parsed;
      try {
        parsed = parseSitemap(result.body, { maxBytes: this.config.maxResponseBytes });
      } catch (err) {
        if (!(err instanceof SitemapError)) throw err;
        report.error(sitemapUrl, err.message, result.status);
        continue;
      }
      for (const child of parsed.childSitemaps) {
        const childUrl = normalizeCrawlUrl(child, sitemapUrl);
        if (childUrl && scope.contains(childUrl)) pending.push([childUrl, true]);
      }
      pages.push(...parsed.pageUrls);
    }
    return pages;
  }
}

function errorName(err) {
  return err?.name && err.name !== 'Error' ? err.name : (err?.constructor?.name ?? 'Error');
}
