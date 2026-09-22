// Port of tests/integration/test_postgres.py — runs against a dedicated, disposable PostgreSQL database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DatabaseContentStore } from '../../src/content/store.js';
import { HEAD_REVISION, currentRevision } from '../../src/db/migrate.js';
import { PageService } from '../../src/db/queries/pages.js';
import { PgInterlinkRepository, PgSession, SuggestionStatus } from '../../src/interlink/repository.js';
import { ConflictError, DatabaseError } from '../../src/utils/errors.js';
import { FakeAIProvider, cleanSettings } from '../helpers/fakes.js';
import { DB_URL, closeTestDatabase, getPageRow, openTestDatabase, seed, truncate } from './db.js';

const CONTEXT = 'Businesses can use AI voice agents to automate repetitive customer support interactions.';

function suggestionRow(siteId, source, target, status, score, extra = {}) {
  return {
    id: randomUUID(),
    site_id: siteId,
    source_page_id: source,
    target_page_id: target,
    anchor_text: 'AI voice agents',
    context: CONTEXT,
    relevance_score: score,
    reason: 'r',
    status,
    retrieval_score: null,
    ai_provider: null,
    ai_model: null,
    ...extra,
  };
}

describe.skipIf(!DB_URL)('PostgreSQL integration', () => {
  let pool;
  const sessions = [];
  const newSession = () => {
    const s = new PgSession(pool);
    sessions.push(s);
    return s;
  };

  beforeAll(async () => {
    pool = await openTestDatabase();
  });
  afterAll(async () => {
    for (const s of sessions) await s.close();
    if (pool) await closeTestDatabase(pool);
  });
  beforeEach(async () => {
    await truncate(pool);
  });

  it('migration matches the reference schema', async () => {
    expect(await currentRevision(pool)).toBe(HEAD_REVISION);
    const { rows: tables } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.map((t) => t.table_name)).toEqual(['alembic_version', 'internal_link_suggestions', 'pages', 'sites']);
    const { rows: cols } = await pool.query(
      `SELECT table_name, count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name`,
    );
    expect(Object.fromEntries(cols.map((c) => [c.table_name, c.n]))).toEqual({
      alembic_version: 1,
      internal_link_suggestions: 17,
      pages: 21,
      sites: 7,
    });
    const { rows: indexes } = await pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'internal_link_suggestions'",
    );
    const active = indexes.find((i) => i.indexname === 'uq_internal_link_suggestions_active_pair');
    expect(active.indexdef).toMatch(/^CREATE UNIQUE INDEX/);
    expect(active.indexdef).toContain('PENDING');
    const { rows: constraints } = await pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'internal_link_suggestions'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(constraints.map((c) => c.conname)).toEqual([
      'ck_internal_link_suggestions_no_self_link',
      'ck_internal_link_suggestions_relevance_score_range',
    ]);
    const { rows: enumRows } = await pool.query('SELECT unnest(enum_range(NULL::interlink_suggestion_status))::text AS v');
    expect(enumRows.map((r) => r.v)).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED']);
  });

  it('page upsert updates and versions', async () => {
    const [siteId, ids] = await seed(pool);
    const source = await getPageRow(pool, ids['/customer-support-automation/']);
    expect(source.outgoing_links).toEqual(['https://www.example.com/', 'https://www.example.com/chatbots/']);
    expect(source.language).toBe('en');

    const service = new PageService(pool);
    await service.upsertPages(siteId, [{ url: '/ai-voice-agent/', title: 'New title', content_html: '<p>x</p>' }]);
    await service.upsertPages(siteId, [{ url: '/ai-voice-agent/', title: 'New title', content_html: '<p>x</p>' }]);
    const voice = await getPageRow(pool, ids['/ai-voice-agent/']);
    expect(voice.title).toBe('New title');
    expect(voice.content_version).toBe(2); // bumped once: only the first upsert changed content
  });

  it('active-pair unique index and check constraints', async () => {
    const [siteId, ids] = await seed(pool);
    const repo = new PgInterlinkRepository(newSession());
    const make = (status, score = 90) =>
      suggestionRow(siteId, ids['/customer-support-automation/'], ids['/ai-voice-agent/'], status, score);

    expect(await repo.addSuggestion(make(SuggestionStatus.REJECTED))).toBe(true);
    expect(await repo.addSuggestion(make(SuggestionStatus.REJECTED))).toBe(true); // rejected rows don't collide
    expect(await repo.addSuggestion(make(SuggestionStatus.PENDING))).toBe(true);
    expect(await repo.addSuggestion(make(SuggestionStatus.APPROVED))).toBe(false); // active duplicate
    await repo.commit();
    expect(await repo.activeTargetIds(ids['/customer-support-automation/'])).toEqual(new Set([ids['/ai-voice-agent/']]));

    // Re-approving an old rejected suggestion while one is active -> ConflictError.
    // (Python raises at the ORM flush inside commit(); Node persists explicitly via saveSuggestion.)
    const [rejectedItems, total] = await repo.listSuggestions({ status: SuggestionStatus.REJECTED }, { offset: 0, limit: 10 });
    expect(total).toBe(2);
    const [rejected] = rejectedItems;
    rejected.status = SuggestionStatus.APPROVED;
    const conflict = await repo.saveSuggestion(rejected).catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect(conflict.code).toBe('ACTIVE_SUGGESTION_EXISTS');

    const integrity = await repo.addSuggestion(make(SuggestionStatus.REJECTED, 101)).catch((e) => e);
    expect(integrity).toBeInstanceOf(DatabaseError);
    expect(integrity.name).toBe('IntegrityError');
    await repo.rollback();
  });

  it('content store optimistic locking', async () => {
    const [, ids] = await seed(pool);
    const session = newSession();
    const store = new DatabaseContentStore(session);
    const page = await getPageRow(pool, ids['/ai-voice-agent/']);
    await store.saveContent(page, '<p>See <a href="/chatbots/">bots</a></p>', { expectedVersion: 1 });
    await session.commit();
    expect(page.content_version).toBe(2);
    expect(page.outgoing_links).toEqual(['https://www.example.com/chatbots/']);
    expect((await getPageRow(pool, page.id)).content_version).toBe(2);
    await expect(store.saveContent(page, '<p>stale</p>', { expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError);
    await session.rollback();
  });

  it('end-to-end HTTP flow', async () => {
    const [, ids] = await seed(pool);
    const voiceId = ids['/ai-voice-agent/'];
    const provider = new FakeAIProvider({
      suggestions: [
        {
          target_page_id: voiceId,
          target_url: '/ai-voice-agent/',
          relevance_score: 94,
          reason: 'Directly covers AI voice agents for support.',
          anchor_text: 'AI voice agents',
          suggested_context: CONTEXT,
        },
      ],
    });
    const app = await buildApp({ settings: cleanSettings(), deps: { pool: () => pool, aiProvider: async () => provider } });
    try {
      const sourceId = ids['/customer-support-automation/'];
      const post = (url, payload) => app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });
      const res = await post('/api/interlink/analyze', { source_page_id: sourceId });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      // Only the eligible page reached the AI (404/noindex/already-linked were filtered).
      expect(body.candidates_retrieved).toBe(1);
      expect(body.suggestions).toHaveLength(1);
      const sid = body.suggestions[0].id;

      const again = (await post('/api/interlink/analyze', { source_page_id: sourceId })).json();
      expect(again.suggestions).toEqual([]);

      const listed = (await app.inject({ method: 'GET', url: '/api/interlink/suggestions', query: { status: 'PENDING' } })).json();
      expect(listed.total).toBe(1);

      expect((await post(`/api/interlink/suggestions/${sid}/apply`)).statusCode).toBe(409);
      expect((await post(`/api/interlink/suggestions/${sid}/approve`)).json().status).toBe('APPROVED');
      const applied = await post(`/api/interlink/suggestions/${sid}/apply`);
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().status).toBe('APPLIED');

      const page = (await app.inject({ method: 'GET', url: `/api/pages/${sourceId}` })).json();
      expect(page.content_html.split('<a href="/ai-voice-agent/">AI voice agents</a>')).toHaveLength(2);
      expect(page.content_version).toBe(2);
      expect(page.outgoing_links).toContain('https://www.example.com/ai-voice-agent/');

      expect((await post(`/api/interlink/suggestions/${sid}/apply`)).statusCode).toBe(409);
      expect([200, 503]).toContain((await app.inject({ method: 'GET', url: '/health/db' })).statusCode);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Regression: GET /api/interlink/suggestions must return persisted suggestions
  // (status / site_id / source_page_id / target_page_id / min_relevance_score / paging).
  describe('listing persisted suggestions', () => {
    let app;
    let ids;

    beforeEach(async () => {
      const [siteId, seeded] = await seed(pool);
      const pages = new PageService(pool);
      const other = await pages.createSite({ name: 'Other', base_url: 'https://other.example.org' });
      const otherIds = await pages.upsertPages(other.id, [
        { url: '/a/', title: 'A' },
        { url: '/b/', title: 'B' },
      ]);
      const source = seeded['/customer-support-automation/'];
      const voice = seeded['/ai-voice-agent/'];
      const chatbots = seeded['/chatbots/'];
      const extra = { anchor_text: 'voice agents', ai_provider: 'gemini', ai_model: 'gemini-test' };
      const rows = {
        // Mirrors the reported record: PENDING, score 88, source -> AI Voice Agent.
        pending: suggestionRow(siteId, source, voice, SuggestionStatus.PENDING, 88, extra),
        approved_low: suggestionRow(siteId, source, chatbots, SuggestionStatus.APPROVED, 72, extra),
        rejected: suggestionRow(siteId, voice, source, SuggestionStatus.REJECTED, 95, extra),
        other_site: suggestionRow(other.id, otherIds[0], otherIds[1], SuggestionStatus.PENDING, 90, extra),
      };
      // Persist with one session and commit, then read through separate request sessions.
      const session = newSession();
      const repo = new PgInterlinkRepository(session);
      for (const row of Object.values(rows)) expect(await repo.addSuggestion(row)).toBe(true);
      await repo.commit();
      await session.close();

      ids = { ...Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.id])), site: siteId, source, voice, chatbots };
      app = await buildApp({ settings: cleanSettings(), deps: { pool: () => pool } });
      return async () => app.close();
    });

    async function listIds(query = {}) {
      const params = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
      const res = await app.inject({ method: 'GET', url: '/api/interlink/suggestions', query: params });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      return [new Set(body.items.map((i) => i.id)), body];
    }

    it('status=PENDING returns the persisted suggestion', async () => {
      const [found, body] = await listIds({ status: 'PENDING' });
      expect(found).toEqual(new Set([ids.pending, ids.other_site]));
      expect(body.total).toBe(2);
      const item = body.items.find((i) => i.id === ids.pending);
      expect(item.status).toBe('PENDING');
      expect(item.relevance_score).toBe(88);
      expect(item.anchor_text).toBe('voice agents');
      // The detail endpoint and the list agree on the same record.
      const detail = (await app.inject({ method: 'GET', url: `/api/interlink/suggestions/${ids.pending}` })).json();
      expect(detail.id).toBe(item.id);
      expect(detail.status).toBe(item.status);
    });

    it('without filters returns all', async () => {
      const [found, body] = await listIds();
      expect(found.has(ids.pending)).toBe(true);
      expect(body.total).toBe(4);
      expect(found.size).toBe(4);
      for (const [status, key] of [
        ['APPROVED', 'approved_low'],
        ['REJECTED', 'rejected'],
      ]) {
        expect((await listIds({ status }))[0]).toEqual(new Set([ids[key]]));
      }
      expect((await listIds({ status: 'APPLIED' }))[1].total).toBe(0);
    });

    it('filters by site_id', async () => {
      expect((await listIds({ site_id: ids.site }))[0]).toEqual(new Set([ids.pending, ids.approved_low, ids.rejected]));
      expect((await listIds({ site_id: ids.site, status: 'PENDING' }))[0]).toEqual(new Set([ids.pending]));
      expect((await listIds({ site_id: randomUUID() }))[1].total).toBe(0);
    });

    it('filters by source_page_id', async () => {
      expect((await listIds({ source_page_id: ids.source }))[0]).toEqual(new Set([ids.pending, ids.approved_low]));
      expect((await listIds({ source_page_id: ids.voice }))[0]).toEqual(new Set([ids.rejected]));
    });

    it('filters by target_page_id', async () => {
      expect((await listIds({ target_page_id: ids.voice }))[0]).toEqual(new Set([ids.pending]));
      expect((await listIds({ target_page_id: ids.chatbots, status: 'PENDING' }))[0]).toEqual(new Set());
    });

    it('filters by min_relevance_score', async () => {
      expect((await listIds({ min_relevance_score: 80 }))[0]).toEqual(new Set([ids.pending, ids.rejected, ids.other_site]));
      expect((await listIds({ min_relevance_score: 88, status: 'PENDING' }))[0]).toEqual(new Set([ids.pending, ids.other_site]));
      expect((await listIds({ min_relevance_score: 89, site_id: ids.site, status: 'PENDING' }))[0]).toEqual(new Set());
    });

    it('paginates', async () => {
      let [, body] = await listIds({ page: 1, page_size: 20 });
      expect([body.page, body.page_size, body.total]).toEqual([1, 20, 4]);
      [, body] = await listIds({ page: 1, page_size: 100 });
      expect(body.page_size).toBe(100);
      expect(body.items).toHaveLength(4);
      const [first, body1] = await listIds({ page: 1, page_size: 3 });
      const [second, body2] = await listIds({ page: 2, page_size: 3 });
      expect(first.size).toBe(3);
      expect(second.size).toBe(1);
      expect([...first].some((id) => second.has(id))).toBe(false);
      expect(body1.total).toBe(4);
      expect(body2.total).toBe(4);
      expect((await listIds({ page: 3, page_size: 3 }))[0]).toEqual(new Set());
      const res = await app.inject({ method: 'GET', url: '/api/interlink/suggestions', query: { page_size: '101' } });
      expect(res.statusCode).toBe(422);
    });
  });
});
