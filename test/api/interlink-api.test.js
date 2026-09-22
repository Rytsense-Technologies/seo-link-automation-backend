// Port of tests/api/test_interlink_api.py — HTTP-level tests (service wired to in-memory fakes, AI mocked).
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AIProviderError } from '../../src/interlink/provider.js';
import { SuggestionStatus } from '../../src/interlink/repository.js';
import { DatabaseError } from '../../src/utils/errors.js';
import {
  FakeAIProvider,
  FakeContentStore,
  buildService,
  cleanSettings,
  crmItem,
  makeSiteFixture,
  voiceItem,
} from '../helpers/fakes.js';

const CONTEXT = 'Businesses can use AI voice agents to automate repetitive customer support interactions.';

const serviceDep = (factory) => async () => ({ service: factory(), close: async () => {} });

let site;
let app;

async function makeApp({ provider, settings = cleanSettings() } = {}) {
  const store = new FakeContentStore();
  return buildApp({ settings, deps: { interlinkService: serviceDep(() => buildService(site.repo, provider ?? null, { store })) } });
}

beforeEach(async () => {
  site = makeSiteFixture();
  app = await makeApp({ provider: new FakeAIProvider({ suggestions: [voiceItem(site), crmItem(site)] }) });
});
afterEach(async () => {
  await app.close();
});

const post = (url, payload) => app.inject({ method: 'POST', url, ...(payload !== undefined ? { payload } : {}) });
const get = (url, query) => app.inject({ method: 'GET', url, query });

function suggestion(status = SuggestionStatus.PENDING, kw = {}) {
  return site.repo.putSuggestion({
    source_page_id: site.source.id,
    target_page_id: site.voice.id,
    anchor_text: 'AI voice agents',
    context: CONTEXT,
    status,
    ...kw,
  });
}

describe('interlink API', () => {
  it('analyze endpoint', async () => {
    const res = await post('/api/interlink/analyze', { source_page_id: site.source.id });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.min_relevance_score).toBe(70);
    expect(body.dry_run).toBe(false);
    expect(body.suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id, site.crm.id]);
    const [first] = body.suggestions;
    expect(first.status).toBe('PENDING');
    expect(first.anchor_text).toBe('AI voice agents');
    expect(first.relevance_score).toBe(94);
    expect(body.excluded_counts.NOINDEX).toBe(1);
  });

  it('analyze validation errors', async () => {
    let res = await post('/api/interlink/analyze', { source_page_id: 'not-a-uuid' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    res = await post('/api/interlink/analyze', { source_page_id: randomUUID(), min_relevance_score: 101 });
    expect(res.statusCode).toBe(422);
    res = await post('/api/interlink/analyze', { source_page_id: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PAGE_NOT_FOUND');
  });

  it('AI failure returns 502', async () => {
    await app.close();
    app = await makeApp({ provider: new FakeAIProvider(new AIProviderError('provider down')) });
    const res = await post('/api/interlink/analyze', { source_page_id: site.source.id });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_PROVIDER_ERROR');
  });

  it('lists and filters suggestions', async () => {
    suggestion(SuggestionStatus.PENDING, { relevance_score: 95 });
    suggestion(SuggestionStatus.REJECTED, { target_page_id: site.crm.id, relevance_score: 71 });
    suggestion(SuggestionStatus.APPLIED, { target_page_id: site.dental.id, relevance_score: 80 });

    let body = (await get('/api/interlink/suggestions')).json();
    expect([body.total, body.page, body.page_size]).toEqual([3, 1, 20]);

    body = (await get('/api/interlink/suggestions', { status: 'REJECTED' })).json();
    expect(body.items.map((i) => i.target_page_id)).toEqual([site.crm.id]);

    body = (await get('/api/interlink/suggestions', { min_relevance_score: '80' })).json();
    expect(body.total).toBe(2);

    body = (await get('/api/interlink/suggestions', { target_page_id: site.dental.id })).json();
    expect(body.total).toBe(1);

    body = (await get('/api/interlink/suggestions', { source_page_id: site.source.id, page_size: '2' })).json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);

    for (const params of [{ status: 'DONE' }, { page: '0' }, { page_size: '1000' }, { min_relevance_score: '-1' }]) {
      expect((await get('/api/interlink/suggestions', params)).statusCode, JSON.stringify(params)).toBe(422);
    }
  });

  it('suggestion detail', async () => {
    const s = suggestion();
    const res = await get(`/api/interlink/suggestions/${s.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.target_url).toBe(site.voice.url);
    expect(body.source_page.url).toBe(site.source.url);
    expect(body.target_page.title).toBe(site.voice.title);
    expect((await get(`/api/interlink/suggestions/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/api/interlink/suggestions/123')).statusCode).toBe(422);
  });

  it('approve and reject endpoints', async () => {
    const s = suggestion();
    let res = await post(`/api/interlink/suggestions/${s.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');

    res = await post(`/api/interlink/suggestions/${s.id}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATUS_TRANSITION');

    res = await post(`/api/interlink/suggestions/${s.id}/reject`, { reason: 'off-topic' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
    expect(res.json().rejection_reason).toBe('off-topic');

    const other = suggestion(SuggestionStatus.PENDING, { target_page_id: site.crm.id });
    res = await post(`/api/interlink/suggestions/${other.id}/reject`); // body optional
    expect(res.statusCode).toBe(200);

    res = await post(`/api/interlink/suggestions/${other.id}/reject`, { reason: 'x'.repeat(2001) });
    expect(res.statusCode).toBe(422);
  });

  it('apply endpoint', async () => {
    const s = suggestion();
    let res = await post(`/api/interlink/suggestions/${s.id}/apply`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUGGESTION_NOT_APPROVED');

    await post(`/api/interlink/suggestions/${s.id}/approve`);
    res = await post(`/api/interlink/suggestions/${s.id}/apply`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('APPLIED');
    expect(res.json().applied_at).not.toBeNull();
    expect(site.source.content_html ?? '').toContain('<a href="/ai-voice-agent/">AI voice agents</a>');

    res = await post(`/api/interlink/suggestions/${s.id}/apply`);
    expect(res.statusCode).toBe(409);
  });

  it('apply is unprocessable when the context is missing', async () => {
    const s = suggestion(SuggestionStatus.APPROVED, { context: 'This sentence is not on the page.' });
    const res = await post(`/api/interlink/suggestions/${s.id}/apply`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CONTEXT_NOT_FOUND');
  });

  it('database errors return 503', async () => {
    const broken = async () => {
      throw new DatabaseError(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    };
    site.repo.listSuggestions = broken;
    site.repo.getSuggestion = broken;
    const res = await get('/api/interlink/suggestions');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'DATABASE_ERROR', message: 'A database error occurred', details: null } });
    expect((await post(`/api/interlink/suggestions/${randomUUID()}/approve`)).statusCode).toBe(503);
  });

  it('API key is enforced when configured', async () => {
    await app.close();
    app = await makeApp({ settings: cleanSettings({ api_key: 'secret' }) });
    expect((await get('/api/interlink/suggestions')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/interlink/suggestions', headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/interlink/suggestions', headers: { 'X-API-Key': 'secret' } });
    expect(ok.statusCode).toBe(200);
  });

  it('OpenAPI documents the interlink endpoints', async () => {
    const spec = (await get('/openapi.json')).json();
    const { paths } = spec;
    for (const [path, method] of [
      ['/api/interlink/analyze', 'post'],
      ['/api/interlink/suggestions', 'get'],
      ['/api/interlink/suggestions/{suggestion_id}', 'get'],
      ['/api/interlink/suggestions/{suggestion_id}/approve', 'post'],
      ['/api/interlink/suggestions/{suggestion_id}/reject', 'post'],
      ['/api/interlink/suggestions/{suggestion_id}/apply', 'post'],
    ]) {
      expect(paths[path]?.[method], path).toBeDefined();
      expect(paths[path][method].responses, path).toHaveProperty('422');
    }
    const { schemas } = spec.components;
    expect(schemas.SuggestionStatus.enum).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED']);
    expect(schemas).toHaveProperty('AnalyzeRequest');
    expect(schemas).toHaveProperty('SuggestionDetail');
    expect(schemas).toHaveProperty('ErrorResponse');
  });
});
