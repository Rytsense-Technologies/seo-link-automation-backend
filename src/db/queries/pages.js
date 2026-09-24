/** Page inventory service: sites and page upsert/read (app/pages/service.py). */

import { randomUUID } from 'node:crypto';
import { getPool, runQuery } from '../pool.js';
import { ConflictError, DatabaseError, NotFoundError, UnprocessableError } from '../../utils/errors.js';
import { normalizeUrl, sameHost } from '../../utils/urls.js';
import { urlsplit, urlunsplit } from '../../utils/pyurl.js';
import { normalizeCrawlUrl } from '../../crawler/urls.js';
import { pyStrip, pySortedUnique } from '../../utils/pytext.js';
import { internalLinksFor } from '../../content/store.js';
import { logger } from '../../utils/logger.js';

export const PAGE_COLUMNS_NO_CONTENT = `id, site_id, url, title, h1, meta_description, content_version, canonical_url,
  http_status, redirect_url, is_indexable, has_noindex, language, region, page_type, keywords, outgoing_links,
  last_crawled_at, created_at, updated_at`;
export const PAGE_COLUMNS = `${PAGE_COLUMNS_NO_CONTENT}, content_html`;

const UPSERT_COLUMNS = [
  'id', 'site_id', 'url', 'title', 'h1', 'meta_description', 'content_html', 'canonical_url',
  'http_status', 'redirect_url', 'is_indexable', 'has_noindex', 'language', 'region', 'page_type',
  'keywords', 'outgoing_links', 'last_crawled_at',
];

/**
 * The stored-URL forms a reviewer's URL may correspond to, best match first: the crawler's form
 * (tracking parameters removed, query sorted) and the plain normalised form, each with and without
 * a trailing slash, `www.` and either scheme - the variations `urlKey` treats as the same page.
 * Returns [] when the input is not an absolute http(s) URL. Nothing is fetched.
 */
export function pageUrlCandidates(rawUrl) {
  let bases;
  try {
    bases = [normalizeCrawlUrl(rawUrl), normalizeUrl(rawUrl)].filter(Boolean);
  } catch {
    return []; // malformed netloc
  }
  const candidates = new Set();
  for (const base of bases) {
    const parts = urlsplit(base);
    const bareHost = parts.netloc.startsWith('www.') ? parts.netloc.slice(4) : parts.netloc;
    const trimmed = parts.path.replace(/\/+$/, '');
    const paths = trimmed ? [parts.path, trimmed === parts.path ? `${trimmed}/` : trimmed] : ['/'];
    const schemes = [parts.scheme, parts.scheme === 'https' ? 'http' : 'https'];
    const netlocs = [parts.netloc, bareHost === parts.netloc ? `www.${bareHost}` : bareHost];
    for (const path of paths) {
      for (const netloc of netlocs) {
        for (const scheme of schemes) candidates.add(urlunsplit([scheme, netloc, path, parts.query, '']));
      }
    }
  }
  return [...candidates];
}

export class PageService {
  /** @param executor pg Pool or client */
  constructor(executor = getPool()) {
    this.executor = executor;
  }

  // Sites -------------------------------------------------------------
  async createSite({ name, base_url: rawBaseUrl, default_language = null, default_region = null }) {
    const baseUrl = normalizeUrl(rawBaseUrl);
    try {
      const { rows } = await runQuery(
        this.executor,
        `INSERT INTO sites (id, name, base_url, default_language, default_region)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, base_url, default_language, default_region, created_at, updated_at`,
        [randomUUID(), name, baseUrl, default_language, default_region],
      );
      return rows[0];
    } catch (err) {
      if (err instanceof DatabaseError && err.sqlState?.startsWith('23')) {
        throw new ConflictError('A site with this base_url already exists');
      }
      throw err;
    }
  }

  async listSites() {
    const { rows } = await runQuery(
      this.executor,
      `SELECT id, name, base_url, default_language, default_region, created_at, updated_at
         FROM sites ORDER BY created_at`,
    );
    return rows;
  }

  async getSite(siteId) {
    const { rows } = await runQuery(
      this.executor,
      `SELECT id, name, base_url, default_language, default_region, created_at, updated_at
         FROM sites WHERE id = $1`,
      [siteId],
    );
    if (!rows.length) throw new NotFoundError('Site not found', { code: 'SITE_NOT_FOUND' });
    return rows[0];
  }

  // Pages -------------------------------------------------------------
  /** @param pages already-validated PageUpsert objects (defaults applied) */
  async upsertPages(siteId, pages) {
    const site = await this.getSite(siteId);
    const rows = new Map();
    for (const item of pages) {
      const url = normalizeUrl(item.url, site.base_url);
      if (url === null || !sameHost(url, site.base_url)) {
        throw new UnprocessableError(`URL is not an internal http(s) URL of this site: ${item.url}`, {
          code: 'INVALID_PAGE_URL',
        });
      }
      const canonical = item.canonical_url ? normalizeUrl(item.canonical_url, url) : null;
      const redirect = item.redirect_url ? normalizeUrl(item.redirect_url, url) : null;
      let outgoing;
      if (item.outgoing_links !== null && item.outgoing_links !== undefined) {
        outgoing = pySortedUnique(
          item.outgoing_links.map((raw) => normalizeUrl(raw, url)).filter((link) => link && sameHost(link, url)),
        );
      } else if (item.content_html) {
        outgoing = internalLinksFor(url, item.content_html);
      } else {
        outgoing = [];
      }
      rows.set(url, {
        id: randomUUID(),
        site_id: site.id,
        url,
        title: item.title ?? null,
        h1: item.h1 ?? null,
        meta_description: item.meta_description ?? null,
        content_html: item.content_html ?? null,
        canonical_url: canonical,
        http_status: item.http_status === undefined ? 200 : item.http_status,
        redirect_url: redirect,
        is_indexable: item.is_indexable ?? true,
        has_noindex: item.has_noindex ?? false,
        language: item.language || site.default_language,
        region: item.region || site.default_region,
        page_type: item.page_type ?? null,
        keywords: (item.keywords ?? []).map((k) => pyStrip(k)).filter(Boolean),
        outgoing_links: outgoing,
        last_crawled_at: item.last_crawled_at ?? null,
      });
    }
    const values = [];
    const tuples = [];
    for (const row of rows.values()) {
      const placeholders = UPSERT_COLUMNS.map((col) => {
        values.push(row[col]);
        return `$${values.length}`;
      });
      tuples.push(`(${placeholders.join(', ')})`);
    }
    const updates = UPSERT_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`);
    const { rows: returned } = await runQuery(
      this.executor,
      `INSERT INTO pages (${UPSERT_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT ON CONSTRAINT uq_pages_site_id_url DO UPDATE SET
         ${updates.join(', ')},
         updated_at = now(),
         -- Only bump the version when content actually changes.
         content_version = pages.content_version
           + CAST(pages.content_html IS DISTINCT FROM EXCLUDED.content_html AS INTEGER)
       RETURNING id`,
      values,
    );
    const ids = returned.map((r) => r.id);
    logger.info(`Upserted ${ids.length} pages for site ${site.id}`);
    return ids;
  }

  async listPages({ siteId = null, page, pageSize }) {
    const where = siteId === null ? '' : 'WHERE site_id = $1';
    const params = siteId === null ? [] : [siteId];
    const { rows: countRows } = await runQuery(
      this.executor,
      `SELECT count(*)::int AS total FROM pages ${where}`,
      params,
    );
    const { rows } = await runQuery(
      this.executor,
      `SELECT ${PAGE_COLUMNS_NO_CONTENT} FROM pages ${where}
        ORDER BY url OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
      [...params, (page - 1) * pageSize, pageSize],
    );
    return [rows, countRows[0].total];
  }

  /**
   * The site(s) a URL typed by a reviewer belongs to, by host (or `siteId`, when given), plus the
   * stored-URL forms to look it up by. Read-only.
   * Errors: 422 INVALID_PAGE_URL (not absolute http(s), or not on `siteId`), 404 SITE_NOT_FOUND.
   */
  async siteForUrl(rawUrl, { siteId = null } = {}) {
    const candidates = pageUrlCandidates(rawUrl);
    if (!candidates.length) {
      throw new UnprocessableError(`URL is not an absolute http(s) URL: ${rawUrl}`, { code: 'INVALID_PAGE_URL' });
    }
    const [url] = candidates;
    const sites = siteId === null ? await this.listSites() : [await this.getSite(siteId)];
    const matching = sites.filter((site) => sameHost(url, site.base_url));
    if (!matching.length) {
      if (siteId !== null) {
        throw new UnprocessableError(`URL is not an internal http(s) URL of this site: ${rawUrl}`, {
          code: 'INVALID_PAGE_URL',
        });
      }
      throw new NotFoundError('No indexed website matches this URL', { code: 'SITE_NOT_FOUND' });
    }
    return { url, candidates, sites: matching };
  }

  /**
   * Finds the indexed page for a URL a reviewer typed, so clients never need page ids up front.
   * The site is the one whose host the URL is on (or `siteId`, when given). Read-only: the URL
   * is only compared with stored URLs, never requested.
   */
  async resolvePage(rawUrl, { siteId = null } = {}) {
    const { candidates, sites } = await this.siteForUrl(rawUrl, { siteId });
    const { rows } = await runQuery(
      this.executor,
      `SELECT ${PAGE_COLUMNS_NO_CONTENT} FROM pages WHERE site_id = ANY($1::uuid[]) AND url = ANY($2::text[])`,
      [sites.map((site) => site.id), candidates],
    );
    if (!rows.length) throw new NotFoundError('Page not found in the indexed website', { code: 'PAGE_NOT_FOUND' });
    const rank = (row) => candidates.indexOf(row.url);
    const page = rows.reduce((best, row) => (rank(row) < rank(best) ? row : best));
    return { site: sites.find((site) => site.id === page.site_id), page };
  }

  async getPage(pageId) {
    const { rows } = await runQuery(this.executor, `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1`, [pageId]);
    if (!rows.length) throw new NotFoundError('Page not found', { code: 'PAGE_NOT_FOUND' });
    return rows[0];
  }
}
