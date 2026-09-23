// Phase 2 HTTP tests for /api/interlink/*: deterministic mode, explicit AI fallback, review flow and
// input safety. Service wired to in-memory fakes; no DB, no network, no real AI provider.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LexicalCandidateRetriever } from '../../src/interlink/candidate-retriever.js';
import { AIProviderError } from '../../src/interlink/provider.js';
import { PgInterlinkRepository } from '../../src/interlink/repository.js';
import { InterlinkService } from '../../src/interlink/service.js';
import { ServiceUnavailableError } from '../../src/utils/errors.js';
import { FakeAIProvider, FakeContentStore, buildService, cleanSettings, defaultConfig, makeSiteFixture, voiceItem } from '../helpers/fakes.js';

let site;
let app;

const serviceDep = (factory) => async () => ({ service: factory(), close: async () => {} });

async function makeApp(factory) {
  return buildApp({ settings: cleanSettings(), deps: { interlinkService: serviceDep(factory) } });
}

function notConfiguredService() {
  return new InterlinkService(site.repo, {
    config: defaultConfig(),
    retriever: new LexicalCandidateRetriever(),
    analyzerFactory: async () => {
      throw new ServiceUnavailableError('No AI provider is configured (set AI_PROVIDER and AI_API_KEY)', {
        code: 'AI_PROVIDER_NOT_CONFIGURED',
      });
    },
    contentStore: new FakeContentStore(),
  });
}

beforeEach(async () => {
  site = makeSiteFixture();
  app = await makeApp(() => buildService(site.repo, new FakeAIProvider(new AIProviderError('provider down'))));
});
afterEach(async () => {
  await app.close();
});

const post = (url, payload) => app.inject({ method: 'POST', url, ...(payload !== undefined ? { payload } : {}) });
const get = (url, query) => app.inject({ method: 'GET', url, query });
const analyze = (body) => post('/api/interlink/analyze', { source_page_id: site.source.id, ...body });

describe('analyze: generation modes', () => {
  it('use_ai=false returns deterministic suggestions with explainable candidates', async () => {
    const res = await analyze({ use_ai: false });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.generation_mode).toBe('deterministic');
    expect(body.ai_error).toBeNull();
    expect(body.min_relevance_score).toBe(35);
    expect(body.suggestions).toHaveLength(3);
    for (const s of body.suggestions) {
      expect(s.status).toBe('PENDING');
      expect(Number.isInteger(s.relevance_score)).toBe(true);
      expect(s.context).toContain(s.anchor_text);
    }
    const [top] = body.candidates;
    expect(Object.keys(top).sort()).toEqual(['retrieval_score', 'score', 'signals', 'target_page_id', 'target_url']);
    expect(Object.keys(top.signals).sort()).toEqual(
      ['content_h1', 'content_title', 'h1_overlap', 'keyword_overlap', 'phrase_overlap', 'quality', 'region_language', 'slug_similarity', 'title_overlap'],
    );
  });

  it('AI failure without ai_fallback keeps returning 502', async () => {
    const res = await analyze({});
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_PROVIDER_ERROR');
    expect(site.repo.suggestions.size).toBe(0);
    expect((await analyze({ ai_fallback: false })).statusCode).toBe(502);
  });

  it('AI failure with ai_fallback=true returns deterministic_fallback', async () => {
    const res = await analyze({ ai_fallback: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().generation_mode).toBe('deterministic_fallback');
    expect(res.json().ai_error).toBe('AI_PROVIDER_ERROR');
    expect(res.json().suggestions.length).toBeGreaterThan(0);
  });

  it('AI not configured: 503 by default, fallback only when requested', async () => {
    await app.close();
    app = await makeApp(notConfiguredService);
    const strict = await analyze({});
    expect(strict.statusCode).toBe(503);
    expect(strict.json().error.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    const fallback = await analyze({ ai_fallback: true, dry_run: true });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().ai_error).toBe('AI_PROVIDER_NOT_CONFIGURED');
  });

  it('AI success reports mode ai', async () => {
    await app.close();
    app = await makeApp(() => buildService(site.repo, new FakeAIProvider({ suggestions: [voiceItem(site)] })));
    const res = await analyze({ ai_fallback: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().generation_mode).toBe('ai');
    expect(res.json().suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id]);
  });

  it('validates the new flags (lax Pydantic booleans)', async () => {
    let res = await analyze({ use_ai: 'maybe' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.errors[0].loc).toEqual(['body', 'use_ai']);
    res = await analyze({ ai_fallback: [] });
    expect(res.statusCode).toBe(422);
    res = await analyze({ use_ai: 'no', dry_run: 'yes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().generation_mode).toBe('deterministic');
    expect(res.json().dry_run).toBe(true);
  });

  it('rejects out-of-range limits and unknown sources', async () => {
    expect((await analyze({ use_ai: false, max_suggestions: 0 })).statusCode).toBe(422);
    expect((await analyze({ use_ai: false, max_suggestions: 51 })).statusCode).toBe(422);
    expect((await analyze({ use_ai: false, min_relevance_score: -1 })).statusCode).toBe(422);
    const res = await post('/api/interlink/analyze', { source_page_id: randomUUID(), use_ai: false });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PAGE_NOT_FOUND');
  });
});

describe('review workflow for deterministic suggestions', () => {
  it('list with filters and pagination', async () => {
    await analyze({ use_ai: false });
    let body = (await get('/api/interlink/suggestions', { source_page_id: site.source.id, page_size: '2' })).json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
    const page2 = (await get('/api/interlink/suggestions', { source_page_id: site.source.id, page_size: '2', page: '2' })).json();
    expect(page2.items).toHaveLength(1);
    expect(new Set([...body.items, ...page2.items].map((s) => s.id)).size).toBe(3);
    body = (await get('/api/interlink/suggestions', { target_page_id: site.voice.id })).json();
    expect(body.items.map((s) => s.target_page_id)).toEqual([site.voice.id]);
    const top = Math.max(...page2.items.concat(body.items).map((s) => s.relevance_score));
    body = (await get('/api/interlink/suggestions', { min_relevance_score: String(top) })).json();
    expect(body.items.every((s) => s.relevance_score >= top)).toBe(true);
    expect((await get('/api/interlink/suggestions', { status: 'APPROVED' })).json().total).toBe(0);
  });

  it('approve, reject, invalid transitions and 404', async () => {
    const [first, second] = (await analyze({ use_ai: false })).json().suggestions;
    const detail = (await get(`/api/interlink/suggestions/${first.id}`)).json();
    expect(detail.ai_provider).toBe('deterministic');
    expect(detail.ai_model).toBeNull();
    expect(detail.target_url).toBe(detail.target_page.url);

    const approved = await post(`/api/interlink/suggestions/${first.id}/approve`);
    expect(approved.json().status).toBe('APPROVED');
    expect(approved.json().reviewed_at).not.toBeNull();
    // Approval never changes page content.
    expect(site.source.content_version).toBe(1);

    const rejected = await post(`/api/interlink/suggestions/${second.id}/reject`, { reason: 'Not a good fit' });
    expect(rejected.json().status).toBe('REJECTED');
    expect(rejected.json().rejection_reason).toBe('Not a good fit');

    site.repo.suggestions.get(first.id).status = 'APPLIED';
    const invalid = await post(`/api/interlink/suggestions/${first.id}/reject`);
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error.code).toBe('INVALID_STATUS_TRANSITION');

    const missing = await post(`/api/interlink/suggestions/${randomUUID()}/approve`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SUGGESTION_NOT_FOUND');
    expect((await get(`/api/interlink/suggestions/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('input safety', () => {
  it.each([
    ['status', "PENDING' OR '1'='1"],
    ['source_page_id', "1; DROP TABLE pages; --"],
    ['target_page_id', "' UNION SELECT * FROM sites --"],
    ['min_relevance_score', '0 OR 1=1'],
  ])('rejects injection-shaped %s filters with 422', async (field, value) => {
    const res = await get('/api/interlink/suggestions', { [field]: value });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('repository filters are always bound parameters, never interpolated', async () => {
    const calls = [];
    const session = { query: async (text, params) => (calls.push({ text, params }), { rows: [{ total: 0 }] }) };
    const repo = new PgInterlinkRepository(session);
    const evil = "x'; DROP TABLE pages; --";
    await repo.listSuggestions(
      { status: evil, site_id: evil, source_page_id: evil, target_page_id: evil, min_relevance_score: evil },
      { offset: 0, limit: 10 },
    );
    for (const { text, params } of calls) {
      expect(text).not.toContain('DROP TABLE');
      expect(text).toMatch(/\$\d/);
      expect(params).toContain(evil);
    }
  });

  it('documents the additions in OpenAPI', async () => {
    const spec = (await get('/openapi.json')).json();
    const schemas = spec.components.schemas;
    expect(Object.keys(schemas.AnalyzeRequest.properties)).toEqual(expect.arrayContaining(['use_ai', 'ai_fallback']));
    expect(schemas.AnalyzeRequest.properties.ai_fallback.default).toBe(false);
    expect(schemas.AnalyzeResponse.required).toEqual(expect.arrayContaining(['generation_mode', 'ai_error', 'candidates']));
    expect(schemas.AnalyzeResponse.properties.generation_mode.enum).toEqual(['ai', 'deterministic', 'deterministic_fallback']);
    expect(schemas).toHaveProperty('CandidateScore');
    expect(schemas).toHaveProperty('ScoreSignals');
    // No new routes: the interlink surface is unchanged.
    const interlinkPaths = Object.keys(spec.paths).filter((p) => p.includes('interlink')).sort();
    expect(interlinkPaths).toEqual([
      '/api/interlink/analyze',
      '/api/interlink/suggestions',
      '/api/interlink/suggestions/{suggestion_id}',
      '/api/interlink/suggestions/{suggestion_id}/apply',
      '/api/interlink/suggestions/{suggestion_id}/approve',
      '/api/interlink/suggestions/{suggestion_id}/reject',
    ]);
  });
});
