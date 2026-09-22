// Port of tests/unit/test_service_analyze.py
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, UnprocessableError } from '../../src/utils/errors.js';
import { AIProviderError } from '../../src/interlink/provider.js';
import { SuggestionStatus } from '../../src/interlink/repository.js';
import { FakeAIProvider, aiItem, buildService, crmItem, defaultConfig, makePage, makeSiteFixture, voiceItem } from '../helpers/fakes.js';

const request = (sourcePageId, overrides = {}) => ({
  source_page_id: sourcePageId,
  max_suggestions: null,
  min_relevance_score: null,
  dry_run: false,
  ...overrides,
});

describe('interlink analyze', () => {
  let site;
  beforeEach(() => {
    site = makeSiteFixture();
  });

  const analyze = (provider, { config = null, ...overrides } = {}) =>
    buildService(site.repo, provider, { config }).analyze(request(site.source.id, overrides));
  const promptIds = (provider) => new Set(JSON.parse(provider.calls[0].prompt).CANDIDATES.map((c) => c.id));

  it('creates pending suggestions', async () => {
    const provider = new FakeAIProvider({ suggestions: [voiceItem(site), crmItem(site)] });
    const outcome = await analyze(provider);
    expect(outcome.suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id, site.crm.id]);
    const [first] = outcome.suggestions;
    expect(first.status).toBe(SuggestionStatus.PENDING);
    expect(first.anchor_text).toBe('AI voice agents');
    expect(first.relevance_score).toBe(94);
    expect(first.ai_provider).toBe('fake');
    expect(first.retrieval_score).not.toBeNull();
    expect(site.repo.suggestions.size).toBe(2);
    expect(site.repo.commits).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('only sends hard-filtered candidates to the AI', async () => {
    const provider = new FakeAIProvider({ suggestions: [] });
    const outcome = await analyze(provider);
    const ids = promptIds(provider);
    expect(ids.has(String(site.source.id))).toBe(false);
    for (const excluded of [site.notFound, site.serverError, site.redirected, site.noindex, site.spanish, site.utility, site.canonicalised, site.chatbots]) {
      expect(ids.has(String(excluded.id))).toBe(false);
    }
    expect(ids.has(String(site.voice.id))).toBe(true);
    expect(outcome.excluded_counts.NOINDEX).toBe(1);
    expect(outcome.excluded_counts.ALREADY_LINKED).toBe(1);
    expect(outcome.excluded_counts.REDIRECTED).toBe(1);
  });

  it('bounds the candidate pool size', async () => {
    for (let i = 0; i < 40; i += 1) site.repo.addPage(makePage(`/voice-${i}/`, { title: `AI voice agents for support ${i}` }));
    const provider = new FakeAIProvider({ suggestions: [] });
    const outcome = await analyze(provider, { config: defaultConfig({ candidatePoolSize: 12 }) });
    expect(outcome.candidates_retrieved).toBe(12);
    expect(promptIds(provider).size).toBe(12);
  });

  it('applies the relevance threshold', async () => {
    const provider = new FakeAIProvider({ suggestions: [voiceItem(site, { relevance_score: 69 }), crmItem(site, { relevance_score: 70 })] });
    const outcome = await analyze(provider);
    expect(outcome.suggestions.map((s) => s.target_page_id)).toEqual([site.crm.id]);
    expect(outcome.skipped.map((s) => [s.target_page_id, s.reason])).toEqual([[site.voice.id, 'BELOW_THRESHOLD']]);
  });

  it('threshold is configurable and a request cannot lower it', async () => {
    let outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site, { relevance_score: 85 })] }), {
      config: defaultConfig({ minRelevanceScore: 90 }),
    });
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.min_relevance_score).toBe(90);
    outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site, { relevance_score: 85 })] }), {
      config: defaultConfig({ minRelevanceScore: 90 }),
      min_relevance_score: 10,
    });
    expect(outcome.min_relevance_score).toBe(90);
    expect(outcome.suggestions).toEqual([]);
  });

  it.each([SuggestionStatus.PENDING, SuggestionStatus.APPROVED, SuggestionStatus.APPLIED])(
    'prevents duplicates of an active (%s) suggestion',
    async (status) => {
      site.repo.putSuggestion({ source_page_id: site.source.id, target_page_id: site.voice.id, status });
      const provider = new FakeAIProvider({ suggestions: [voiceItem(site)] });
      const outcome = await analyze(provider);
      expect(outcome.suggestions).toEqual([]);
      expect(promptIds(provider).has(String(site.voice.id))).toBe(false);
      expect(outcome.excluded_counts.ACTIVE_SUGGESTION_EXISTS).toBe(1);
      expect(site.repo.suggestions.size).toBe(1);
    },
  );

  it('running analysis twice does not duplicate', async () => {
    await analyze(new FakeAIProvider({ suggestions: [voiceItem(site)] }));
    const second = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site)] }));
    expect(second.suggestions).toEqual([]);
    expect(site.repo.suggestions.size).toBe(1);
  });

  it('reports a concurrent duplicate insert as a skip', async () => {
    const service = buildService(site.repo, new FakeAIProvider({ suggestions: [voiceItem(site)] }));
    site.repo.addSuggestion = async () => false;
    const outcome = await service.analyze(request(site.source.id));
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.skipped[0].reason).toBe('ACTIVE_SUGGESTION_EXISTS');
  });

  it('regenerates a rejected suggestion only after the cooldown', async () => {
    const rejected = site.repo.putSuggestion({ source_page_id: site.source.id, target_page_id: site.voice.id, status: SuggestionStatus.REJECTED });
    let outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site)] }));
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.excluded_counts.RECENTLY_REJECTED).toBe(1);
    rejected.updated_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site)] }));
    expect(outcome.suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id]);
  });

  it('validates AI suggestions against the source content', async () => {
    const provider = new FakeAIProvider({
      suggestions: [
        // Paraphrased context that does not exist in the page.
        voiceItem(site, { suggested_context: 'Voice agents are great for support.' }),
        // Non-descriptive and generic anchors.
        crmItem(site, { anchor_text: 'while a' }),
        aiItem(site.dental, {
          anchor_text: 'click here',
          suggested_context: 'Accurate dental insurance verification reduces claim denials for dental practices.',
        }),
      ],
    });
    const outcome = await analyze(provider);
    expect(outcome.suggestions).toEqual([]);
    const reasons = Object.fromEntries(outcome.skipped.map((s) => [s.target_page_id, s.reason]));
    expect(reasons[site.voice.id]).toBe('CONTEXT_NOT_IN_SOURCE');
    expect(reasons[site.crm.id]).toBe('ANCHOR_NOT_DESCRIPTIVE');
    expect(reasons[site.dental.id]).toBe('ANCHOR_GENERIC');
  });

  it('rejects a context that only exists in navigation', async () => {
    const outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site, { suggested_context: 'Home AI voice agents' })] }));
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.skipped[0].reason).toBe('CONTEXT_NOT_IN_SOURCE');
  });

  it('rejects an anchor inside an existing link', async () => {
    const outcome = await analyze(new FakeAIProvider({ suggestions: [crmItem(site, { anchor_text: 'chatbot platform' })] }));
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.skipped[0].reason).toBe('ANCHOR_IN_UNSAFE_ELEMENT');
  });

  it('does not reuse the same anchor or context within a batch', async () => {
    const sameContext = voiceItem(site).suggested_context;
    const provider = new FakeAIProvider({
      suggestions: [voiceItem(site), aiItem(site.crm, { anchor_text: 'customer support', suggested_context: sameContext })],
    });
    const outcome = await analyze(provider);
    expect(outcome.suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id]);
    expect(outcome.skipped[0].reason).toBe('CONTEXT_ALREADY_USED');
  });

  it('rejects an overused anchor for the target', async () => {
    for (let i = 0; i < 3; i += 1) {
      const other = site.repo.addPage(makePage(`/other-${i}/`, { title: 'x' }));
      site.repo.putSuggestion({ source_page_id: other.id, target_page_id: site.voice.id, anchor_text: 'AI voice agents' });
    }
    const provider = new FakeAIProvider({ suggestions: [voiceItem(site)] });
    const outcome = await analyze(provider);
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.skipped[0].reason).toBe('ANCHOR_OVERUSED');
    const voice = JSON.parse(provider.calls[0].prompt).CANDIDATES.find((c) => c.id === String(site.voice.id));
    expect(voice.avoid_anchors).toEqual(['AI voice agents', 'AI voice agents', 'AI voice agents']);
  });

  it('max suggestions and dry run', async () => {
    const outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site), crmItem(site)] }), { max_suggestions: 1, dry_run: true });
    expect(outcome.suggestions.map((s) => s.target_page_id)).toEqual([site.voice.id]);
    expect(outcome.skipped[0].reason).toBe('MAX_SUGGESTIONS_REACHED');
    expect(site.repo.suggestions.size).toBe(0);
    expect(site.repo.commits).toBe(0);
  });

  it('never stores invented targets', async () => {
    const outcome = await analyze(new FakeAIProvider({ suggestions: [voiceItem(site, { target_page_id: String(site.unrelated.id) })] }));
    expect(outcome.suggestions).toEqual([]);
    expect(site.repo.suggestions.size).toBe(0);
  });

  it('skips the AI call when there are no candidates', async () => {
    site.repo.pages = new Map([[site.source.id, site.source]]);
    const outcome = await analyze(null);
    expect(outcome.candidates_retrieved).toBe(0);
    expect(outcome.suggestions).toEqual([]);
  });

  it('error cases', async () => {
    const service = buildService(site.repo, new FakeAIProvider({ suggestions: [] }));
    await expect(service.analyze(request(randomUUID()))).rejects.toBeInstanceOf(NotFoundError);

    site.source.http_status = 404;
    let err = await service.analyze(request(site.source.id)).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(err.code).toBe('SOURCE_NOT_ANALYZABLE');

    site.source.http_status = 200;
    site.source.content_html = '<nav>only navigation</nav>';
    err = await service.analyze(request(site.source.id)).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(err.code).toBe('NO_LINKABLE_CONTENT');
  });

  it('AI provider failure propagates without storing', async () => {
    await expect(analyze(new FakeAIProvider(new AIProviderError('boom')))).rejects.toBeInstanceOf(AIProviderError);
    expect(site.repo.suggestions.size).toBe(0);
    expect(site.repo.commits).toBe(0);
  });

  it('never sends empty pages to the AI', async () => {
    const empty = site.repo.addPage(makePage('/ai-readiness-assessment/', { title: null, h1: null, content_html: '' }));
    const htmlRedirect = site.repo.addPage(
      makePage('/old-assessment/', { title: null, redirect_url: 'https://www.example.com/us/ai-readiness-assessment/', is_indexable: false }),
    );
    const provider = new FakeAIProvider({ suggestions: [aiItem(empty, { anchor_text: 'AI voice agents' })] });
    const outcome = await analyze(provider);
    const ids = promptIds(provider);
    expect(ids.has(String(empty.id))).toBe(false);
    expect(ids.has(String(htmlRedirect.id))).toBe(false);
    expect(outcome.excluded_counts.EMPTY_CONTENT).toBe(1);
    expect(outcome.suggestions.every((s) => s.target_page_id !== empty.id)).toBe(true);
  });
});
