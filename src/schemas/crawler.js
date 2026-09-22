/** Schemas for the crawl endpoint (app/crawler/schemas.py). */

import { httpUrl, uuidOut } from './common.js';

export const CrawlRequest = {
  $id: 'CrawlRequest',
  type: 'object',
  properties: {
    start_url: {
      anyOf: [httpUrl, { type: 'null' }],
      default: null,
      description: "Must be on the site's host. Defaults to the site's base_url.",
      examples: ['https://rytsensetech.com/'],
    },
    max_pages: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Maximum number of pages to fetch' },
    use_sitemaps: { type: 'boolean', default: true, description: 'Discover URLs from robots.txt sitemaps / /sitemap.xml' },
    include_www_variant: {
      type: 'boolean',
      default: false,
      description: 'Also treat the www./non-www. variant of the site host as in scope',
    },
  },
};

export const CrawlError = {
  $id: 'CrawlError',
  type: 'object',
  properties: { url: { type: 'string' }, error: { type: 'string' }, status: { type: ['integer', 'null'], default: null } },
  required: ['url', 'error'],
};

export const RobotsSummary = {
  $id: 'RobotsSummary',
  type: 'object',
  properties: {
    status: { type: ['integer', 'null'], description: 'HTTP status of /robots.txt (null if unreachable)' },
    policy: { type: 'string', examples: ['parsed', 'allow_all', 'disallow_all'] },
    sitemaps: { type: 'array', items: { type: 'string' } },
    crawl_delay: { type: ['number', 'null'] },
  },
  required: ['status', 'policy', 'sitemaps', 'crawl_delay'],
};

export const CrawlResponse = {
  $id: 'CrawlResponse',
  type: 'object',
  properties: {
    site_id: uuidOut,
    start_url: { type: 'string' },
    robots: { $ref: 'RobotsSummary#' },
    sitemaps_processed: { type: 'integer' },
    pages_discovered: { type: 'integer', description: 'Unique in-scope page URLs found' },
    pages_crawled: { type: 'integer', description: 'Page URLs fetched' },
    pages_created: { type: 'integer' },
    pages_updated: { type: 'integer' },
    pages_skipped: { type: 'integer' },
    skipped_reasons: {
      type: 'object',
      additionalProperties: { type: 'integer' },
      examples: [{ ROBOTS_DISALLOWED: 3, NOT_HTML: 1, MAX_PAGES_REACHED: 9 }],
    },
    max_pages_reached: { type: 'boolean' },
    html_redirects: {
      type: 'integer',
      default: 0,
      description: 'Pages that declared a redirect in HTML (Next.js NEXT_REDIRECT / meta refresh)',
    },
    unusable_pages: { type: 'integer', default: 0, description: '2xx HTML pages stored as not indexable: no usable content' },
    errors: { type: 'array', items: { $ref: 'CrawlError#' } },
    errors_truncated: { type: 'boolean', default: false },
    duration_seconds: { type: 'number' },
  },
  required: [
    'site_id', 'start_url', 'robots', 'sitemaps_processed', 'pages_discovered', 'pages_crawled', 'pages_created',
    'pages_updated', 'pages_skipped', 'skipped_reasons', 'max_pages_reached', 'errors', 'duration_seconds',
  ],
};

export const crawlerSchemas = [CrawlRequest, CrawlError, RobotsSummary, CrawlResponse];
