/** Data access for the interlink module (app/interlink/repository.py). */

import { connect, getPool, runQuery, wrapDbError } from '../db/pool.js';
import { ConflictError, DatabaseError } from '../utils/errors.js';
import { PAGE_COLUMNS } from '../db/queries/pages.js';

export const SuggestionStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  APPLIED: 'APPLIED',
});
// A source -> target pair may have at most one suggestion in these states.
export const ACTIVE_STATUSES = [SuggestionStatus.PENDING, SuggestionStatus.APPROVED, SuggestionStatus.APPLIED];
export const ACTIVE_PAIR_INDEX = 'uq_internal_link_suggestions_active_pair';

const SUGGESTION_COLUMNS = `s.id, s.site_id, s.source_page_id, s.target_page_id, s.anchor_text, s.context,
  s.relevance_score, s.reason, s.status::text AS status, s.retrieval_score, s.ai_provider, s.ai_model,
  s.rejection_reason, s.reviewed_at, s.applied_at, s.created_at, s.updated_at`;
const WITH_PAGES = `${SUGGESTION_COLUMNS},
  json_build_object('id', sp.id, 'url', sp.url, 'title', sp.title, 'h1', sp.h1) AS source_page,
  json_build_object('id', tp.id, 'url', tp.url, 'title', tp.title, 'h1', tp.h1) AS target_page`;
const FROM_JOINED = `internal_link_suggestions s
  JOIN pages sp ON sp.id = s.source_page_id
  JOIN pages tp ON tp.id = s.target_page_id`;

/**
 * Unit of work mirroring a SQLAlchemy Session: a dedicated connection, a transaction that begins
 * on first use (autobegin), and explicit `commit()` / `rollback()` that end it.
 */
export class PgSession {
  constructor(pool = getPool()) {
    this.pool = pool;
    this.client = null;
    this.inTransaction = false;
  }

  async query(text, params = []) {
    if (this.client === null) this.client = await connect(this.pool);
    if (!this.inTransaction) {
      await runQuery(this.client, 'BEGIN');
      this.inTransaction = true;
    }
    return runQuery(this.client, text, params);
  }

  async commit() {
    if (this.inTransaction) {
      this.inTransaction = false;
      await runQuery(this.client, 'COMMIT');
    }
  }

  async rollback() {
    if (this.inTransaction) {
      this.inTransaction = false;
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* connection may be broken */
      }
    }
  }

  async close() {
    await this.rollback();
    if (this.client !== null) {
      this.client.release();
      this.client = null;
    }
  }
}

function isActivePairViolation(err) {
  return err instanceof DatabaseError && err.sqlState === '23505' && err.constraint === ACTIVE_PAIR_INDEX;
}

export class PgInterlinkRepository {
  constructor(session) {
    this.session = session;
  }

  async getPage(pageId, { forUpdate = false } = {}) {
    const { rows } = await this.session.query(
      `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [pageId],
    );
    return rows[0] ?? null;
  }

  /**
   * Cheap SQL pre-filter; `candidate-filter` remains the authoritative rule set. `content_html`
   * is only loaded for pages without title and H1 (needed by the EMPTY_CONTENT rule).
   */
  async listCandidatePool(source) {
    const { rows } = await this.session.query(
      `SELECT id, site_id, url, title, h1, meta_description, content_version, canonical_url, http_status,
              redirect_url, is_indexable, has_noindex, language, region, page_type, keywords, outgoing_links,
              last_crawled_at, created_at, updated_at,
              CASE WHEN btrim(coalesce(title, '')) = '' AND btrim(coalesce(h1, '')) = ''
                   THEN content_html END AS content_html
         FROM pages
        WHERE site_id = $1 AND id <> $2 AND http_status >= 200 AND http_status < 300
          AND redirect_url IS NULL AND has_noindex IS false AND is_indexable IS true
        ORDER BY url`,
      [source.site_id, source.id],
    );
    return rows;
  }

  async loadContents(pageIds) {
    if (!pageIds.length) return new Map();
    const { rows } = await this.session.query('SELECT id, content_html FROM pages WHERE id = ANY($1::uuid[])', [pageIds]);
    const byId = new Map(rows.filter((r) => r.content_html).map((r) => [r.id, r.content_html]));
    // Keep the requested order (Python iterates the DB rows; the order is only used for a dict).
    return new Map(pageIds.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]));
  }

  async getSuggestion(suggestionId, { forUpdate = false } = {}) {
    const { rows } = await this.session.query(
      `SELECT ${WITH_PAGES} FROM ${FROM_JOINED} WHERE s.id = $1${forUpdate ? ' FOR UPDATE OF s' : ''}`,
      [suggestionId],
    );
    return rows[0] ?? null;
  }

  async listSuggestions(filters, { offset, limit }) {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (filters.status) add('s.status = ?::interlink_suggestion_status', filters.status);
    if (filters.site_id) add('s.site_id = ?', filters.site_id);
    if (filters.source_page_id) add('s.source_page_id = ?', filters.source_page_id);
    if (filters.target_page_id) add('s.target_page_id = ?', filters.target_page_id);
    if (filters.min_relevance_score !== null && filters.min_relevance_score !== undefined) {
      add('s.relevance_score >= ?', filters.min_relevance_score);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows: countRows } = await this.session.query(
      `SELECT count(*)::int AS total FROM internal_link_suggestions s ${where}`,
      params,
    );
    const { rows } = await this.session.query(
      `SELECT ${WITH_PAGES} FROM ${FROM_JOINED} ${where}
        ORDER BY s.created_at DESC, s.relevance_score DESC, s.id
        OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
      [...params, offset, limit],
    );
    return [rows, countRows[0].total];
  }

  async activeTargetIds(sourcePageId) {
    const { rows } = await this.session.query(
      `SELECT target_page_id FROM internal_link_suggestions
        WHERE source_page_id = $1 AND status::text = ANY($2::text[])`,
      [sourcePageId, ACTIVE_STATUSES],
    );
    return new Set(rows.map((r) => r.target_page_id));
  }

  async rejectedTargetIdsSince(sourcePageId, since) {
    const { rows } = await this.session.query(
      `SELECT target_page_id FROM internal_link_suggestions
        WHERE source_page_id = $1 AND status = 'REJECTED' AND updated_at >= $2`,
      [sourcePageId, since],
    );
    return new Set(rows.map((r) => r.target_page_id));
  }

  async anchorsByTarget(targetIds) {
    if (!targetIds.length) return new Map();
    const { rows } = await this.session.query(
      `SELECT target_page_id, anchor_text FROM internal_link_suggestions
        WHERE target_page_id = ANY($1::uuid[]) AND status::text = ANY($2::text[])`,
      [targetIds, ACTIVE_STATUSES],
    );
    const result = new Map();
    for (const { target_page_id: id, anchor_text: anchor } of rows) {
      if (!result.has(id)) result.set(id, []);
      result.get(id).push(anchor);
    }
    return result;
  }

  /** Insert; false (without failing the transaction) on an active-pair duplicate. */
  async addSuggestion(s) {
    await this.session.query('SAVEPOINT add_suggestion');
    try {
      const { rows } = await this.session.query(
        `INSERT INTO internal_link_suggestions
           (id, site_id, source_page_id, target_page_id, anchor_text, context, relevance_score, reason, status,
            retrieval_score, ai_provider, ai_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::interlink_suggestion_status, $10, $11, $12)
         RETURNING created_at, updated_at`,
        [
          s.id, s.site_id, s.source_page_id, s.target_page_id, s.anchor_text, s.context, s.relevance_score,
          s.reason, s.status, s.retrieval_score, s.ai_provider, s.ai_model,
        ],
      );
      await this.session.query('RELEASE SAVEPOINT add_suggestion');
      s.created_at = rows[0].created_at;
      s.updated_at = rows[0].updated_at;
      return true;
    } catch (err) {
      const wrapped = wrapDbError(err);
      await this.session.query('ROLLBACK TO SAVEPOINT add_suggestion');
      // Concurrent analysis already created the active pair (partial unique index).
      if (isActivePairViolation(wrapped)) return false;
      throw wrapped;
    }
  }

  /** Persist review/apply field changes (the ORM flush); active-pair clashes -> 409. */
  async saveSuggestion(s) {
    try {
      const { rows } = await this.session.query(
        `UPDATE internal_link_suggestions
            SET status = $2::interlink_suggestion_status, rejection_reason = $3, reviewed_at = $4, applied_at = $5,
                updated_at = now()
          WHERE id = $1
          RETURNING updated_at, reviewed_at, applied_at`,
        [s.id, s.status, s.rejection_reason, s.reviewed_at, s.applied_at],
      );
      Object.assign(s, rows[0]);
    } catch (err) {
      await this.session.rollback();
      if (isActivePairViolation(err)) {
        throw new ConflictError('Another active suggestion already exists for this source and target', {
          code: 'ACTIVE_SUGGESTION_EXISTS',
        });
      }
      throw err;
    }
  }

  async commit() {
    await this.session.commit();
  }

  async rollback() {
    await this.session.rollback();
  }
}
