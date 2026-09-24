// Re-analysis ("Analyze Again") against a dedicated, disposable PostgreSQL database, using the exact
// request the frontend sends. No AI provider is configured in tests, so ai_fallback yields the
// deterministic generator: no AI is called. Nothing here changes analyze; it pins its guarantees.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PageService } from '../../src/db/queries/pages.js';
import { SOURCE_HTML, cleanSettings } from '../helpers/fakes.js';
import { DB_URL, closeTestDatabase, openTestDatabase, seed, truncate } from './db.js';

const SOURCE = '/customer-support-automation/';
const VOICE = '/ai-voice-agent/';

describe.skipIf(!DB_URL)('re-analysis + PostgreSQL', () => {
  let pool;
  let app;
  let siteId;
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
    [siteId, ids] = await seed(pool);
  });

  // The body the frontend's "Analyze" / "Analyze Again" sends.
  const analyze = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/interlink/analyze',
      payload: { source_page_id: ids[SOURCE], use_ai: true, ai_fallback: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const review = async (suggestionId, action, payload) => {
    const res = await app.inject({ method: 'POST', url: `/api/interlink/suggestions/${suggestionId}/${action}`, ...(payload ? { payload } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const suggestions = async () =>
    (
      await pool.query(
        `SELECT s.id, s.status::text AS status, s.reviewed_at, s.applied_at, s.anchor_text, p.url AS target
           FROM internal_link_suggestions s JOIN pages p ON p.id = s.target_page_id ORDER BY s.created_at, s.id`,
      )
    ).rows;
  const addPage = (page) => new PageService(pool).upsertPages(siteId, [page]);
  const CRM_PAGE = {
    url: '/crm-integration/',
    title: 'CRM Integration',
    h1: 'CRM Integration',
    keywords: ['crm integration'],
    content_html: '<p>Connect your CRM integration to every support tool.</p>',
  };

  it('analyze again creates no duplicate for a pair that already has a suggestion', async () => {
    const first = await analyze();
    expect(first.generation_mode).toBe('deterministic_fallback');
    expect(first.suggestions.map((s) => s.target_page_id)).toEqual([ids[VOICE]]);

    const again = await analyze();
    expect(again.suggestions).toEqual([]);
    expect(again.excluded_counts.ACTIVE_SUGGESTION_EXISTS).toBe(1);
    expect(await suggestions()).toHaveLength(1);
  });

  it.each(['APPROVED', 'APPLIED'])('keeps an %s suggestion as it is, and does not re-suggest its pair', async (status) => {
    const [created] = (await analyze()).suggestions;
    await review(created.id, 'approve');
    if (status === 'APPLIED') {
      await pool.query(`UPDATE internal_link_suggestions SET status = 'APPLIED', applied_at = now() WHERE id = $1`, [created.id]);
    }
    const [before] = await suggestions();

    const again = await analyze();

    expect(again.suggestions).toEqual([]);
    const after = await suggestions();
    expect(after).toEqual([before]); // same row, same status, same review/apply timestamps
    expect(after[0].status).toBe(status);
  });

  it('respects the rejection cooldown, then allows the pair again once it has passed', async () => {
    const [created] = (await analyze()).suggestions;
    await review(created.id, 'reject', { reason: 'Not now' });

    const withinCooldown = await analyze();
    expect(withinCooldown.suggestions).toEqual([]);
    expect(withinCooldown.excluded_counts.RECENTLY_REJECTED).toBe(1);
    expect((await suggestions()).map((s) => s.status)).toEqual(['REJECTED']);

    // 31 days later (INTERLINK_REJECTION_COOLDOWN_DAYS defaults to 30; the cooldown runs from updated_at).
    await pool.query(
      `UPDATE internal_link_suggestions SET reviewed_at = now() - interval '31 days', updated_at = now() - interval '31 days' WHERE id = $1`,
      [created.id],
    );
    const afterCooldown = await analyze();
    expect(afterCooldown.suggestions.map((s) => s.target_page_id)).toEqual([ids[VOICE]]);
    // The rejected decision stays in the history next to the new suggestion.
    expect((await suggestions()).map((s) => s.status)).toEqual(['REJECTED', 'PENDING']);
  });

  it('finds a newly indexed target page on re-analysis, without touching existing suggestions', async () => {
    const [voice] = (await analyze()).suggestions;
    await review(voice.id, 'approve');
    const [approvedBefore] = await suggestions();

    await addPage(CRM_PAGE); // e.g. added by the regular crawl or by page discovery
    const again = await analyze();

    expect(again.suggestions.map((s) => s.anchor_text)).toEqual(['CRM integration']);
    const after = await suggestions();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(approvedBefore);
    expect(after[1]).toMatchObject({ status: 'PENDING', target: 'https://www.example.com/crm-integration/' });
  });

  it('analyses the latest source content: a changed page bumps content_version and can yield new links', async () => {
    const [voice] = (await analyze()).suggestions;
    await review(voice.id, 'approve');
    await addPage(CRM_PAGE);
    await addPage({ url: '/dental-insurance-verification/', title: 'Dental Insurance Verification', h1: 'Dental Insurance Verification', content_html: '<p>Verify dental insurance.</p>' });
    const versionBefore = (await pool.query('SELECT content_version FROM pages WHERE id = $1', [ids[SOURCE]])).rows[0].content_version;

    // The source page is re-crawled with an extra paragraph.
    await addPage({
      url: SOURCE,
      title: 'Customer Support Automation',
      h1: 'Customer Support Automation',
      keywords: ['customer support automation', 'voice agents'],
      content_html: SOURCE_HTML.replace(
        '</body>',
        '<p>Clinics also rely on dental insurance verification before appointments.</p></body>',
      ),
    });
    const versionAfter = (await pool.query('SELECT content_version FROM pages WHERE id = $1', [ids[SOURCE]])).rows[0].content_version;
    expect(versionAfter).toBe(versionBefore + 1);

    const again = await analyze();
    const targets = again.suggestions.map((s) => s.target_page_id).sort();
    const { rows } = await pool.query('SELECT id FROM pages WHERE url = ANY($1) ORDER BY id', [[
      'https://www.example.com/crm-integration/',
      'https://www.example.com/dental-insurance-verification/',
    ]]);
    expect(targets).toEqual(rows.map((r) => r.id).sort());
    const statuses = (await suggestions()).map((s) => `${s.anchor_text}:${s.status}`);
    expect(statuses).toContain(`${voice.anchor_text}:APPROVED`);
    expect(new Set(statuses).size).toBe(statuses.length); // no pair twice
  });
});
