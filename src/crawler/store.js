/** Persistence for crawl results, on top of the existing `pages` table / PageService (app/crawler/store.py). */

import { connect, getPool, runQuery } from '../db/pool.js';
import { ConflictError } from '../utils/errors.js';
import { urlKey } from '../utils/urls.js';
import { PageService } from '../db/queries/pages.js';

/**
 * Store interface used by the crawler (the in-memory fake in tests implements the same methods):
 *   existingUrls(siteId) -> Map(urlKey -> stored url)
 *   upsertPage(siteId, page) -> id
 *   updateStatus(siteId, url, { httpStatus, redirectUrl }) -> boolean
 *   rollback()
 *   siteLock(siteId, fn) -> result of fn (throws ConflictError CRAWL_IN_PROGRESS if held)
 */
export class PgCrawlStore {
  constructor(pool = getPool()) {
    this.pool = pool;
    this.pages = new PageService(pool);
  }

  async existingUrls(siteId) {
    const { rows } = await runQuery(this.pool, 'SELECT url FROM pages WHERE site_id = $1', [siteId]);
    return new Map(rows.map((r) => [urlKey(r.url), r.url]));
  }

  async upsertPage(siteId, page) {
    const [id] = await this.pages.upsertPages(siteId, [page]);
    return id;
  }

  /** Update only status/redirect of an existing page (keeps its content). True if found. */
  async updateStatus(siteId, url, { httpStatus, redirectUrl }) {
    const result = await runQuery(
      this.pool,
      `UPDATE pages SET http_status = $1, redirect_url = $2, updated_at = now()
        WHERE site_id = $3 AND url = $4`,
      [httpStatus, redirectUrl, siteId, url],
    );
    return result.rowCount > 0;
  }

  async rollback() {
    // Every statement autocommits on the pool; nothing to roll back.
  }

  /**
   * Session-level PostgreSQL advisory lock on a dedicated connection. Prevents two crawls of the
   * same site running concurrently (a pooled connection could be reused by other queries).
   */
  async siteLock(siteId, fn) {
    const client = await connect(this.pool);
    const key = `crawl:${siteId}`;
    try {
      const { rows } = await runQuery(client, 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
      if (!rows[0].acquired) {
        throw new ConflictError('A crawl for this site is already running', { code: 'CRAWL_IN_PROGRESS' });
      }
      try {
        return await fn();
      } finally {
        await runQuery(client, 'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      }
    } finally {
      client.release();
    }
  }
}
