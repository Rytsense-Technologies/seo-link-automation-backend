/** Composition root for the crawler (HTTP client, store, crawler) (app/crawler/dependencies.py). */

import { fetch as undiciFetch } from 'undici';
import { Fetcher, fetcherConfig } from './fetcher.js';
import { SiteCrawler, crawlConfig } from './service.js';
import { createGuardedDispatcher } from './ssrf.js';
import { PgCrawlStore } from './store.js';

/** SSRF-guarded fetch: public IPs only, allowed ports only, no env proxies. */
export function createGuardedFetch(settings) {
  const dispatcher = createGuardedDispatcher({
    allowedPorts: settings.crawler_allowed_ports,
    timeoutSeconds: settings.crawler_timeout_seconds,
  });
  const guardedFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
  guardedFetch.close = () => dispatcher.close();
  return guardedFetch;
}

export function buildSiteCrawler(settings, { pool, fetchImpl }) {
  const ports = [...settings.crawler_allowed_ports];
  const fetcher = new Fetcher(
    fetchImpl,
    fetcherConfig({
      userAgent: settings.crawler_user_agent,
      maxRetries: settings.crawler_max_retries,
      maxRedirects: settings.crawler_max_redirects,
      maxResponseBytes: settings.crawler_max_response_bytes,
      allowedPorts: ports,
      maxRetryAfterSeconds: settings.crawler_max_crawl_delay_seconds,
    }),
  );
  return new SiteCrawler(
    new PgCrawlStore(pool),
    fetcher,
    crawlConfig({
      requestDelaySeconds: settings.crawler_request_delay_seconds,
      maxCrawlDelaySeconds: settings.crawler_max_crawl_delay_seconds,
      maxPagesLimit: settings.crawler_max_pages_limit,
      maxSitemaps: settings.crawler_max_sitemaps,
      maxResponseBytes: settings.crawler_max_response_bytes,
      allowedPorts: ports,
      userAgent: settings.crawler_user_agent,
    }),
  );
}
