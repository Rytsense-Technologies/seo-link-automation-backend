// Phase 2 against a dedicated, disposable PostgreSQL database: deterministic generation and the
// explicit AI fallback through the real repository. No AI provider is configured (AI_PROVIDER=none).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { HEAD_REVISION, currentRevision } from '../../src/db/migrate.js';
import { cleanSettings } from '../helpers/fakes.js';
import { DB_URL, closeTestDatabase, openTestDatabase, seed, truncate } from './db.js';

async function pagesFingerprint(pool) {
  const { rows } = await pool.query(
    `SELECT id, url, content_version, md5(coalesce(content_html, '')) AS html, outgoing_links, http_status,
            redirect_url, is_indexable, updated_at
       FROM pages ORDER BY id`,
  );
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe.skipIf(!DB_URL)('interlink deterministic generation + PostgreSQL', () => {
  let pool;
  let app;
  let ids;

  beforeAll(async () => {
    pool = await openTestDatabase();
    app = await buildApp({ settings: cleanSettings(), deps: { pool: () => pool } });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closeTestDatabase(pool);
  });
  beforeEach(async () => {
    await truncate(pool);
    [, ids] = await seed(pool);
  });

  const analyze = (body) =>
    app.inject({ method: 'POST', url: '/api/interlink/analyze', payload: { source_page_id: ids['/customer-support-automation/'], ...body } });

  it('use_ai=false stores PENDING suggestions for eligible targets only', async () => {
    const before = await pagesFingerprint(pool);
    const res = await analyze({ use_ai: false });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.generation_mode).toBe('deterministic');
    // /chatbots/ is already linked; /old/ (404) and /beta/ (noindex) never leave the SQL pre-filter.
    expect(body.excluded_counts).toEqual({ ALREADY_LINKED: 1 });
    const seen = new Set(body.candidates.map((c) => c.target_page_id));
    for (const url of ['/old/', '/beta/', '/chatbots/']) expect(seen.has(ids[url])).toBe(false);
    expect(body.suggestions.map((s) => s.target_page_id)).toEqual([ids['/ai-voice-agent/']]);

    const { rows } = await pool.query('SELECT *, status::text AS status FROM internal_link_suggestions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      ai_provider: 'deterministic',
      ai_model: null,
      source_page_id: ids['/customer-support-automation/'],
      target_page_id: ids['/ai-voice-agent/'],
      reviewed_at: null,
      applied_at: null,
    });
    expect(rows[0].context).toContain(rows[0].anchor_text);
    expect(rows[0].relevance_score).toBeGreaterThanOrEqual(35);
    expect(rows[0].relevance_score).toBeLessThanOrEqual(100);

    // Page rows (content, versions, links, timestamps) are untouched.
    expect(await pagesFingerprint(pool)).toBe(before);
  });

  it('is idempotent: re-running creates no duplicates', async () => {
    await analyze({ use_ai: false });
    const again = (await analyze({ use_ai: false })).json();
    expect(again.suggestions).toEqual([]);
    expect(again.excluded_counts.ACTIVE_SUGGESTION_EXISTS).toBe(1);
    const { rows } = await pool.query(
      'SELECT source_page_id, target_page_id, count(*)::int AS n FROM internal_link_suggestions GROUP BY 1, 2',
    );
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  it('AI not configured: 503 unless ai_fallback=true', async () => {
    const strict = await analyze({});
    expect(strict.statusCode).toBe(503);
    expect(strict.json().error.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect((await pool.query('SELECT count(*)::int AS n FROM internal_link_suggestions')).rows[0].n).toBe(0);

    const fallback = await analyze({ ai_fallback: true });
    expect(fallback.statusCode, fallback.body).toBe(200);
    expect(fallback.json().generation_mode).toBe('deterministic_fallback');
    expect(fallback.json().ai_error).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(fallback.json().suggestions).toHaveLength(1);
  });

  it('approve/reject work on deterministic suggestions and never touch page content', async () => {
    const [s] = (await analyze({ use_ai: false })).json().suggestions;
    const before = await pagesFingerprint(pool);
    const approve = await app.inject({ method: 'POST', url: `/api/interlink/suggestions/${s.id}/approve` });
    expect(approve.json().status).toBe('APPROVED');
    const reject = await app.inject({ method: 'POST', url: `/api/interlink/suggestions/${s.id}/reject`, payload: { reason: 'no' } });
    expect(reject.json().status).toBe('REJECTED');
    expect(await pagesFingerprint(pool)).toBe(before);
  });

  it('lists suggestions with the target URL taken from the pages table', async () => {
    await analyze({ use_ai: false });
    const listed = await app.inject({ method: 'GET', url: '/api/interlink/suggestions', query: { status: 'PENDING' } });
    expect(listed.statusCode, listed.body).toBe(200);
    const { items, total } = listed.json();
    expect(total).toBeGreaterThan(0);

    const { rows } = await pool.query('SELECT id, url FROM pages');
    const urlById = new Map(rows.map((r) => [r.id, r.url]));
    for (const item of items) {
      expect(item.target_url).toBe(urlById.get(item.target_page_id));
      expect(item.target_page_id).toBe(ids['/ai-voice-agent/']);
    }
  });

  it('schema is unchanged and constraints still protect the table', async () => {
    expect(await currentRevision(pool)).toBe(HEAD_REVISION);
    expect(HEAD_REVISION).toBe('20260922_0001');
    const insert = (source, target) =>
      pool.query(
        `INSERT INTO internal_link_suggestions (id, site_id, source_page_id, target_page_id, anchor_text, context,
           relevance_score, reason, status, ai_provider)
         SELECT $1, site_id, $2, $3, 'a', 'c', 50, 'r', 'PENDING', 'deterministic' FROM pages WHERE id = $2`,
        [randomUUID(), source, target],
      );
    const src = ids['/customer-support-automation/'];
    await expect(insert(src, randomUUID())).rejects.toMatchObject({ code: '23503' }); // FK
    await expect(insert(src, src)).rejects.toMatchObject({ code: '23514' }); // no self-link
    await insert(src, ids['/ai-voice-agent/']);
    await expect(insert(src, ids['/ai-voice-agent/'])).rejects.toMatchObject({ code: '23505' }); // active pair
  });
});
