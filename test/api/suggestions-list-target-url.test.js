// GET /api/interlink/suggestions must expose the target page URL on every item, so a client does
// not need one detail request per row. The URL comes from the join the listing already performs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { SuggestionStatus } from '../../src/interlink/repository.js';
import { buildService, cleanSettings, makeSiteFixture } from '../helpers/fakes.js';

const CONTEXT = 'Businesses can use AI voice agents to automate repetitive customer support interactions.';

let site;
let app;

const serviceDep = (factory) => async () => ({ service: factory(), close: async () => {} });
const get = (query) => app.inject({ method: 'GET', url: '/api/interlink/suggestions', query });

function suggestion(target, overrides = {}) {
  return site.repo.putSuggestion({
    source_page_id: site.source.id,
    target_page_id: target.id,
    anchor_text: 'AI voice agents',
    context: CONTEXT,
    status: SuggestionStatus.PENDING,
    ...overrides,
  });
}

beforeEach(async () => {
  site = makeSiteFixture();
  app = await buildApp({
    settings: cleanSettings(),
    deps: { interlinkService: serviceDep(() => buildService(site.repo)) },
  });
});
afterEach(async () => {
  await app.close();
});

describe('suggestion list: target_url', () => {
  it('returns the real target page URL, not a fabricated value', async () => {
    suggestion(site.voice);
    const body = (await get({})).json();
    expect(body.items).toHaveLength(1);
    const [item] = body.items;
    expect(item.target_url).toBe(site.voice.url);
    expect(item.target_page_id).toBe(site.voice.id);
    // Each item's URL belongs to its own target, not to a fixed page.
    suggestion(site.crm);
    const both = (await get({})).json().items;
    const byTarget = new Map(both.map((s) => [s.target_page_id, s.target_url]));
    expect(byTarget.get(site.voice.id)).toBe(site.voice.url);
    expect(byTarget.get(site.crm.id)).toBe(site.crm.url);
  });

  it('keeps every existing field unchanged', async () => {
    const stored = suggestion(site.voice, { relevance_score: 91, reason: 'Covers AI voice agents.' });
    const [item] = (await get({})).json().items;
    expect(Object.keys(item).sort()).toEqual(
      [
        'anchor_text', 'applied_at', 'context', 'created_at', 'id', 'relevance_score', 'reason', 'site_id',
        'source_page_id', 'status', 'target_page_id', 'target_url', 'updated_at',
      ].sort(),
    );
    expect(item).toMatchObject({
      id: stored.id,
      site_id: stored.site_id,
      source_page_id: site.source.id,
      target_page_id: site.voice.id,
      anchor_text: 'AI voice agents',
      context: CONTEXT,
      relevance_score: 91,
      reason: 'Covers AI voice agents.',
      status: 'PENDING',
      applied_at: null,
    });
    expect(typeof item.created_at).toBe('string');
    expect(typeof item.updated_at).toBe('string');
  });

  it.each([
    ['status', () => ({ status: 'PENDING' })],
    ['site_id', () => ({ site_id: site.source.site_id })],
    ['source_page_id', () => ({ source_page_id: site.source.id })],
    ['target_page_id', () => ({ target_page_id: site.voice.id })],
    ['min_relevance_score', () => ({ min_relevance_score: '50' })],
  ])('still returns target_url when filtering by %s', async (_name, query) => {
    suggestion(site.voice, { relevance_score: 80 });
    const response = await get(query());
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.target_url).toBe(site.voice.url);
  });

  it('preserves filtering, ordering and the total count', async () => {
    suggestion(site.voice, { relevance_score: 90 });
    suggestion(site.crm, { relevance_score: 60, status: SuggestionStatus.REJECTED });
    suggestion(site.dental, { relevance_score: 40 });

    const pending = (await get({ status: 'PENDING' })).json();
    expect(pending.total).toBe(2);
    expect(pending.items.every((s) => s.status === 'PENDING')).toBe(true);
    expect(pending.items.every((s) => typeof s.target_url === 'string' && s.target_url.length > 0)).toBe(true);

    const scored = (await get({ min_relevance_score: '70' })).json();
    expect(scored.items.map((s) => s.target_url)).toEqual([site.voice.url]);

    const byTarget = (await get({ target_page_id: site.dental.id })).json();
    expect(byTarget.total).toBe(1);
    expect(byTarget.items[0].target_url).toBe(site.dental.url);

    const none = (await get({ status: 'APPLIED' })).json();
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
  });

  it('includes target_url on every item across pages', async () => {
    const targets = [site.voice, site.crm, site.dental, site.chatbots, site.unrelated];
    for (const target of targets) suggestion(target);

    const seen = new Map();
    for (const page of [1, 2, 3]) {
      const response = await get({ page: String(page), page_size: '2' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(5);
      expect(body.page).toBe(page);
      expect(body.page_size).toBe(2);
      for (const item of body.items) {
        expect(item.target_url, `page ${page} item ${item.id}`).toBeTruthy();
        seen.set(item.target_page_id, item.target_url);
      }
    }
    expect(seen.size).toBe(5);
    for (const target of targets) expect(seen.get(target.id)).toBe(target.url);
  });

  it('leaves the detail endpoint contract untouched', async () => {
    const stored = suggestion(site.voice);
    const detail = (await app.inject({ method: 'GET', url: `/api/interlink/suggestions/${stored.id}` })).json();
    expect(detail.target_url).toBe(site.voice.url);
    expect(detail.target_page).toEqual({ id: site.voice.id, url: site.voice.url, title: site.voice.title, h1: site.voice.h1 });
    expect(detail.source_page.id).toBe(site.source.id);
    expect(detail.ai_provider).toBe('fake');
  });

  it('keeps error behaviour unchanged', async () => {
    expect((await get({ status: "PENDING' OR 1=1" })).statusCode).toBe(422);
    expect((await get({ page: '0' })).statusCode).toBe(422);
    expect((await get({ page_size: '101' })).statusCode).toBe(422);
    const missing = await app.inject({ method: 'GET', url: '/api/interlink/suggestions/00000000-0000-0000-0000-000000000000' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SUGGESTION_NOT_FOUND');
  });

  it('documents target_url in the OpenAPI schema', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const schemas = spec.components.schemas;
    expect(schemas.SuggestionList.properties.items.items.$ref).toBe('#/components/schemas/SuggestionListItem');
    expect(schemas.SuggestionListItem.properties.target_url.type).toBe('string');
    expect(schemas.SuggestionListItem.required).toContain('target_url');
    // The analyze and detail contracts are unchanged.
    expect(schemas.SuggestionRead.properties).not.toHaveProperty('target_url');
    expect(schemas.AnalyzeResponse.properties.suggestions.items.$ref).toBe('#/components/schemas/SuggestionRead');
    expect(schemas.SuggestionDetail.required).toContain('target_url');
  });
});
