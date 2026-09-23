// Phase 2: deterministic generation, explicit AI fallback, and preserved AI error behaviour.
// These tests use in-memory fakes only (no DB, no network, no real AI provider).
import { describe, expect, it, vi } from 'vitest';
import { AIProviderError } from '../../src/interlink/provider.js';
import { LexicalCandidateRetriever } from '../../src/interlink/candidate-retriever.js';
import { RelevanceAnalyzer } from '../../src/interlink/relevance-analyzer.js';
import { InterlinkService, GenerationMode, SkipReason, isAiFailure } from '../../src/interlink/service.js';
import { SuggestionStatus } from '../../src/interlink/repository.js';
import { ServiceUnavailableError, UpstreamError } from '../../src/utils/errors.js';
import { logger } from '../../src/utils/logger.js';
import { FakeAIProvider, FakeContentStore, buildService, defaultConfig, makePage, makeSiteFixture, voiceItem } from '../helpers/fakes.js';

const request = (site, overrides = {}) => ({ source_page_id: site.source.id, dry_run: false, ...overrides });

function serviceWithFactory(repo, factory, { store = new FakeContentStore(), config = defaultConfig() } = {}) {
  return new InterlinkService(repo, { config, retriever: new LexicalCandidateRetriever(), analyzerFactory: factory, contentStore: store });
}

const notConfigured = async () => {
  throw new ServiceUnavailableError('No AI provider is configured (set AI_PROVIDER and AI_API_KEY)', {
    code: 'AI_PROVIDER_NOT_CONFIGURED',
  });
};

const snapshotPages = (repo) => JSON.stringify([...repo.pages.values()].map((p) => ({ ...p })));

describe('deterministic mode (use_ai=false)', () => {
  it('generates PENDING suggestions without resolving or calling the AI provider', async () => {
    const site = makeSiteFixture();
    const factory = vi.fn(notConfigured);
    const out = await serviceWithFactory(site.repo, factory).analyze(request(site, { use_ai: false }));
    expect(factory).not.toHaveBeenCalled();
    expect(out.generation_mode).toBe(GenerationMode.DETERMINISTIC);
    expect(out.ai_error).toBeNull();
    expect(out.min_relevance_score).toBe(35);
    expect(out.suggestions.map((s) => s.target_page_id).sort()).toEqual([site.voice.id, site.crm.id, site.dental.id].sort());
    for (const s of out.suggestions) {
      expect(s.status).toBe(SuggestionStatus.PENDING);
      expect(s.ai_provider).toBe('deterministic');
      expect(s.ai_model).toBeNull();
      expect(s.retrieval_score).toBeGreaterThan(0);
      expect(s.relevance_score).toBe(Math.round(s.retrieval_score * 100));
      // The anchor is real source text inside the verbatim context sentence.
      expect(s.context.includes(s.anchor_text)).toBe(true);
      expect(site.source.content_html.replace(/\s+/g, ' ')).toContain(s.anchor_text);
    }
    expect(site.repo.suggestions.size).toBe(3);
    expect(site.repo.commits).toBe(1);
  });

  it('only eligible targets are suggested; filtered pages are counted, not scored', async () => {
    const site = makeSiteFixture();
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false }));
    const ineligible = [site.notFound, site.serverError, site.redirected, site.noindex, site.spanish, site.utility, site.canonicalised, site.chatbots];
    const ids = new Set([...out.suggestions, ...out.candidates].map((x) => x.target_page_id));
    for (const page of ineligible) expect(ids.has(page.id)).toBe(false);
    expect(out.excluded_counts).toMatchObject({ HTTP_404: 1, HTTP_5XX: 1, REDIRECTED: 1, NOINDEX: 1, ALREADY_LINKED: 1 });
    expect(out.candidates_after_filtering).toBe(4);
  });

  it('reports explainable scores for the candidate pool', async () => {
    const site = makeSiteFixture();
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false, dry_run: true }));
    expect(out.candidates.length).toBe(4);
    const scores = out.candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const unrelated = out.candidates.find((c) => c.target_page_id === site.unrelated.id);
    expect(unrelated.score).toBe(0);
    expect(unrelated.retrieval_score).toBeNull();
    expect(out.skipped).toContainEqual({ target_page_id: site.unrelated.id, target_url: site.unrelated.url, reason: SkipReason.BELOW_THRESHOLD });
  });

  it('respects max_suggestions', async () => {
    const site = makeSiteFixture();
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false, max_suggestions: 1 }));
    expect(out.suggestions).toHaveLength(1);
    expect(out.skipped.filter((s) => s.reason === SkipReason.MAX_SUGGESTIONS_REACHED)).toHaveLength(2);
    expect(site.repo.suggestions.size).toBe(1);
  });

  it('respects min_relevance_score (can only raise the deterministic threshold)', async () => {
    const site = makeSiteFixture();
    const high = await buildService(site.repo).analyze(request(site, { use_ai: false, min_relevance_score: 99, dry_run: true }));
    expect(high.min_relevance_score).toBe(99);
    expect(high.suggestions).toEqual([]);
    const low = await buildService(site.repo).analyze(request(site, { use_ai: false, min_relevance_score: 1, dry_run: true }));
    expect(low.min_relevance_score).toBe(35);
  });

  it('is idempotent: a second run creates no duplicates', async () => {
    const site = makeSiteFixture();
    const first = await buildService(site.repo).analyze(request(site, { use_ai: false }));
    const second = await buildService(site.repo).analyze(request(site, { use_ai: false }));
    expect(first.suggestions).toHaveLength(3);
    expect(second.suggestions).toEqual([]);
    expect(second.excluded_counts.ACTIVE_SUGGESTION_EXISTS).toBe(3);
    expect(site.repo.suggestions.size).toBe(3);
  });

  it('a concurrent duplicate (insert refused) is skipped, not duplicated', async () => {
    const site = makeSiteFixture();
    site.repo.addSuggestion = async () => false;
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false }));
    expect(out.suggestions).toEqual([]);
    expect(out.skipped.filter((s) => s.reason === SkipReason.ACTIVE_SUGGESTION_EXISTS)).toHaveLength(3);
  });

  it('dry_run stores nothing', async () => {
    const site = makeSiteFixture();
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false, dry_run: true }));
    expect(out.suggestions).toHaveLength(3);
    expect(site.repo.suggestions.size).toBe(0);
    expect(site.repo.commits).toBe(0);
  });

  it('never modifies page rows or content', async () => {
    const site = makeSiteFixture();
    const store = new FakeContentStore();
    const before = snapshotPages(site.repo);
    await serviceWithFactory(site.repo, notConfigured, { store }).analyze(request(site, { use_ai: false }));
    await serviceWithFactory(site.repo, notConfigured, { store }).analyze(request(site, { ai_fallback: true }));
    expect(snapshotPages(site.repo)).toBe(before);
    expect(store.saved).toEqual([]);
  });

  it('skips targets whose name never appears in the source (NO_ANCHOR_IN_SOURCE)', async () => {
    const site = makeSiteFixture();
    // Shares vocabulary with the source, but no title/H1/keyword phrase appears in a source sentence.
    const related = site.repo.addPage(
      makePage('/support-ticket-routing/', { title: 'Ticket Routing', h1: 'Support Ticket Routing', keywords: ['repetitive customer tickets'] }),
    );
    const out = await buildService(site.repo, null, { config: defaultConfig({ deterministicMinScore: 0 }) }).analyze(
      request(site, { use_ai: false, dry_run: true }),
    );
    expect(out.suggestions.some((s) => s.target_page_id === related.id)).toBe(false);
    expect(out.skipped).toContainEqual({ target_page_id: related.id, target_url: related.url, reason: SkipReason.NO_ANCHOR_IN_SOURCE });
  });

  it('scores the anchor it actually stores, not the best one it could not use', async () => {
    const site = makeSiteFixture();
    // Two targets whose best anchor is the same sentence: the second must fall back to another
    // anchor, and its stored score must reflect that anchor rather than the unavailable one.
    site.repo.addPage(makePage('/voice-agents-handbook/', { title: 'AI Voice Agents Handbook', h1: 'AI Voice Agents' }));
    const out = await buildService(site.repo, null, { config: defaultConfig({ deterministicMinScore: 0 }) }).analyze(
      request(site, { use_ai: false, dry_run: true }),
    );
    for (const s of out.suggestions) {
      const reported = out.candidates.find((c) => c.target_page_id === s.target_page_id);
      expect(s.relevance_score).toBe(Math.round(reported.score * 100));
      expect(s.retrieval_score).toBe(reported.score);
      expect(s.context).toContain(s.anchor_text);
    }
    // Strongest first, whichever anchor each target ended up with.
    const scores = out.suggestions.map((s) => s.relevance_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('uses each source sentence and anchor at most once', async () => {
    const site = makeSiteFixture();
    // Two targets that can only be anchored in the same sentence.
    site.repo.addPage(makePage('/voice-agents-guide/', { title: 'Voice Agents Handbook', h1: 'Voice Agents' }));
    const out = await buildService(site.repo, null, { config: defaultConfig({ deterministicMinScore: 0 }) }).analyze(
      request(site, { use_ai: false, dry_run: true }),
    );
    const contexts = out.suggestions.map((s) => s.context);
    expect(new Set(contexts).size).toBe(contexts.length);
    const anchors = out.suggestions.map((s) => s.anchor_text.toLowerCase());
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('existing anchor reuse limits still apply', async () => {
    const site = makeSiteFixture();
    for (let i = 0; i < 3; i += 1) {
      const other = site.repo.addPage(makePage(`/other-${i}/`, { title: `Other ${i}` }));
      site.repo.putSuggestion({ source_page_id: other.id, target_page_id: site.voice.id, anchor_text: 'AI voice agents' });
    }
    const out = await buildService(site.repo).analyze(request(site, { use_ai: false, dry_run: true }));
    // The overused anchor is avoided; the next verbatim alternative from the same target is used.
    const voice = out.suggestions.find((s) => s.target_page_id === site.voice.id);
    expect(voice).toBeDefined();
    expect(voice.anchor_text.toLowerCase()).not.toBe('ai voice agents');
    expect(voice.context.includes(voice.anchor_text)).toBe(true);
  });
});

describe('explicit AI fallback (ai_fallback=true)', () => {
  it('falls back when the AI provider is not configured', async () => {
    const site = makeSiteFixture();
    const out = await serviceWithFactory(site.repo, notConfigured).analyze(request(site, { ai_fallback: true }));
    expect(out.generation_mode).toBe(GenerationMode.DETERMINISTIC_FALLBACK);
    expect(out.ai_error).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(out.suggestions).toHaveLength(3);
    expect(out.suggestions.every((s) => s.ai_provider === 'deterministic')).toBe(true);
  });

  it('falls back when the AI provider fails', async () => {
    const site = makeSiteFixture();
    const provider = new FakeAIProvider(new AIProviderError('gemini returned HTTP 500'));
    const out = await buildService(site.repo, provider).analyze(request(site, { ai_fallback: true }));
    expect(out.generation_mode).toBe(GenerationMode.DETERMINISTIC_FALLBACK);
    expect(out.ai_error).toBe('AI_PROVIDER_ERROR');
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1); // no retries
  });

  it('falls back when the AI returns invalid output', async () => {
    const site = makeSiteFixture();
    const provider = new FakeAIProvider({ not_suggestions: true });
    const out = await buildService(site.repo, provider).analyze(request(site, { ai_fallback: true }));
    expect(out.generation_mode).toBe(GenerationMode.DETERMINISTIC_FALLBACK);
    expect(out.ai_error).toBe('AI_INVALID_RESPONSE');
    expect(provider.calls).toHaveLength(1);
  });

  it('does not fall back when the AI works', async () => {
    const site = makeSiteFixture();
    const provider = new FakeAIProvider({ suggestions: [voiceItem(site)] });
    const out = await buildService(site.repo, provider).analyze(request(site, { ai_fallback: true }));
    expect(out.generation_mode).toBe(GenerationMode.AI);
    expect(out.ai_error).toBeNull();
    expect(out.suggestions.map((s) => s.ai_provider)).toEqual(['fake']);
    // AI mode also reports deterministic diagnostics for the retrieved pool.
    expect(out.candidates.length).toBe(out.candidates_retrieved);
    expect(out.candidates.every((c) => typeof c.retrieval_score === 'number')).toBe(true);
  });

  it('never falls back for non-AI errors', async () => {
    const site = makeSiteFixture();
    const boom = new Error('database exploded');
    const service = serviceWithFactory(site.repo, async () => {
      throw boom;
    });
    await expect(service.analyze(request(site, { ai_fallback: true }))).rejects.toBe(boom);
    expect(isAiFailure(new ServiceUnavailableError('db', { code: 'DATABASE_ERROR' }))).toBe(false);
    expect(isAiFailure(new UpstreamError('x'))).toBe(false);
    expect(isAiFailure(new AIProviderError('x'))).toBe(true);
  });

  it('fallback logs never contain the API key', async () => {
    const site = makeSiteFixture();
    const secret = 'AIzaSy-THIS-IS-A-SECRET-KEY-123';
    const lines = [];
    const spies = ['info', 'warn', 'error'].map((level) =>
      vi.spyOn(logger, level).mockImplementation((...args) => lines.push(JSON.stringify(args))),
    );
    try {
      const failingFetch = async () => ({ status: 403, text: async () => '{"error":{"message":"API key not valid"}}' });
      const { GeminiProvider } = await import('../../src/interlink/gemini.js');
      const provider = new GeminiProvider({ apiKey: secret, model: 'm', baseUrl: 'https://example.invalid', timeout: 1, temperature: 0, fetchImpl: failingFetch });
      const factory = async () => new RelevanceAnalyzer(provider, { sourceContentMaxChars: 6000, targetExcerptChars: 300 });
      const out = await serviceWithFactory(site.repo, factory).analyze(request(site, { ai_fallback: true }));
      expect(out.generation_mode).toBe(GenerationMode.DETERMINISTIC_FALLBACK);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('default behaviour is unchanged (ai_fallback defaults to false)', () => {
  it('AI not configured still raises 503 AI_PROVIDER_NOT_CONFIGURED', async () => {
    const site = makeSiteFixture();
    const err = await serviceWithFactory(site.repo, notConfigured).analyze(request(site)).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(err.statusCode).toBe(503);
    expect(site.repo.suggestions.size).toBe(0);
  });

  it('AI failure still raises 502', async () => {
    const site = makeSiteFixture();
    const provider = new FakeAIProvider(new AIProviderError('boom'));
    const err = await buildService(site.repo, provider).analyze(request(site, { ai_fallback: false })).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.statusCode).toBe(502);
    expect(provider.calls).toHaveLength(1);
  });

  it('invalid AI output still raises 502 AI_INVALID_RESPONSE', async () => {
    const site = makeSiteFixture();
    const err = await buildService(site.repo, new FakeAIProvider({ nope: 1 })).analyze(request(site)).catch((e) => e);
    expect(err.code).toBe('AI_INVALID_RESPONSE');
    expect(err.statusCode).toBe(502);
  });

  it('AI mode output keeps the existing fields and adds generation_mode/ai_error/candidates', async () => {
    const site = makeSiteFixture();
    const out = await buildService(site.repo, new FakeAIProvider({ suggestions: [voiceItem(site)] })).analyze(request(site));
    expect(Object.keys(out).sort()).toEqual(
      [
        'ai_error', 'candidates', 'candidates_after_filtering', 'candidates_retrieved', 'dry_run', 'excluded_counts',
        'generation_mode', 'min_relevance_score', 'skipped', 'source_page_id', 'suggestions',
      ].sort(),
    );
    expect(out.min_relevance_score).toBe(70);
  });
});
