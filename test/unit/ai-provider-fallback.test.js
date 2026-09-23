// Secondary AI provider (AI_FALLBACK_PROVIDER), e.g. Gemini -> Groq when Gemini is overloaded.
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { GroqProvider } from '../../src/interlink/groq.js';
import { GeminiProvider } from '../../src/interlink/gemini.js';
import { AIProviderError, buildAiProvider, buildFallbackAiProvider } from '../../src/interlink/provider.js';
import { FallbackRelevanceAnalyzer, RelevanceAnalyzer } from '../../src/interlink/relevance-analyzer.js';
import { InterlinkService } from '../../src/interlink/service.js';
import { LexicalCandidateRetriever } from '../../src/interlink/candidate-retriever.js';
import { DatabaseError, ServiceUnavailableError } from '../../src/utils/errors.js';
import { logger } from '../../src/utils/logger.js';
import { FakeAIProvider, FakeContentStore, cleanSettings, defaultConfig, makeSiteFixture, voiceItem } from '../helpers/fakes.js';

const LIMITS = { sourceContentMaxChars: 6000, targetExcerptChars: 300 };
const analyzer = (provider) => new RelevanceAnalyzer(provider, LIMITS);
const overloaded = () => new AIProviderError('gemini returned HTTP 503', { details: { provider_status: 503 } });

describe('settings', () => {
  it('are disabled by default and build no secondary provider', async () => {
    const settings = cleanSettings();
    expect(settings.ai_fallback_provider).toBe('none');
    expect(settings.ai_fallback_api_key).toBeNull();
    expect(await buildFallbackAiProvider(settings)).toBeNull();
  });

  it('build the configured secondary provider', async () => {
    const provider = await buildFallbackAiProvider(
      cleanSettings({ ai_fallback_provider: 'groq', ai_fallback_api_key: 'gsk_test', ai_fallback_model: 'llama-3.1-8b-instant' }),
    );
    expect(provider).toBeInstanceOf(GroqProvider);
    expect(provider.name).toBe('groq');
    expect(provider.model).toBe('llama-3.1-8b-instant');
    expect(provider.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('defaults the model and base URL, and stays disabled without a key', async () => {
    const provider = await buildFallbackAiProvider(cleanSettings({ ai_fallback_provider: 'groq', ai_fallback_api_key: 'gsk_test' }));
    expect(provider.model).toBe(GroqProvider.DEFAULT_MODEL);
    expect(await buildFallbackAiProvider(cleanSettings({ ai_fallback_provider: 'groq' }))).toBeNull();
    // The primary provider still fails loudly when it is not configured.
    await expect(buildAiProvider(cleanSettings())).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});

describe('FallbackRelevanceAnalyzer', () => {
  const site = () => makeSiteFixture();

  it('uses the primary provider when it works, and never calls the secondary', async () => {
    const s = site();
    const primary = new FakeAIProvider({ suggestions: [voiceItem(s)] });
    const secondary = new FakeAIProvider({ suggestions: [] });
    const chain = new FallbackRelevanceAnalyzer([analyzer(primary), analyzer(secondary)]);
    const result = await chain.analyze('prompt', []);
    expect(result.items).toEqual([]); // no candidates passed, so every item is discarded
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(0);
    expect(chain.providerName).toBe('fake');
  });

  it('falls back to the secondary provider once when the primary fails', async () => {
    const s = site();
    const primary = new FakeAIProvider(overloaded());
    const secondary = new FakeAIProvider({ suggestions: [voiceItem(s)] });
    const candidates = [{ page: s.voice, score: 0.5 }];
    const chain = new FallbackRelevanceAnalyzer([analyzer(primary), analyzer(secondary)]);
    const result = await chain.analyze('prompt', candidates);
    expect(result.items).toHaveLength(1);
    expect(primary.calls).toHaveLength(1); // one attempt each: a fallback, not a retry
    expect(secondary.calls).toHaveLength(1);
    expect(secondary.calls[0].prompt).toBe('prompt'); // same payload, built once
  });

  it('reports the provider that actually answered', async () => {
    const s = site();
    const chain = new FallbackRelevanceAnalyzer([
      analyzer(new GeminiProvider({ apiKey: 'k', model: 'gemini-3.6-flash', baseUrl: 'https://x.invalid', timeout: 1, temperature: 0, fetchImpl: async () => ({ status: 503, text: async () => 'overloaded' }) })),
      analyzer(new GroqProvider({ apiKey: 'k', model: 'llama-3.3-70b-versatile', baseUrl: 'https://y.invalid', timeout: 1, temperature: 0, fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [voiceItem(s)] }) } }] }) }) })),
    ]);
    expect(chain.providerName).toBe('gemini');
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await chain.analyze('prompt', [{ page: s.voice, score: 0.5 }]);
    } finally {
      spy.mockRestore();
    }
    expect(chain.providerName).toBe('groq');
    expect(chain.modelName).toBe('llama-3.3-70b-versatile');
  });

  it('raises the last provider error when every provider fails (502 preserved)', async () => {
    const primary = new FakeAIProvider(overloaded());
    const secondary = new FakeAIProvider(new AIProviderError('groq returned HTTP 429', { details: { provider_status: 429 } }));
    const chain = new FallbackRelevanceAnalyzer([analyzer(primary), analyzer(secondary)]);
    const err = await chain.analyze('prompt', []).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('groq returned HTTP 429');
    expect(secondary.calls).toHaveLength(1);
  });

  it('never falls back for non-AI errors', async () => {
    const boom = new DatabaseError(new Error('connection lost'));
    const primary = new FakeAIProvider(boom);
    const secondary = new FakeAIProvider({ suggestions: [] });
    const chain = new FallbackRelevanceAnalyzer([analyzer(primary), analyzer(secondary)]);
    await expect(chain.analyze('prompt', [])).rejects.toBe(boom);
    expect(secondary.calls).toHaveLength(0);
  });

  it('a single-analyzer chain behaves like the analyzer itself', async () => {
    const primary = new FakeAIProvider(overloaded());
    const chain = new FallbackRelevanceAnalyzer([analyzer(primary)]);
    await expect(chain.analyze('prompt', [])).rejects.toBeInstanceOf(AIProviderError);
    expect(() => new FallbackRelevanceAnalyzer([])).toThrow();
  });
});

describe('analyze through the API', () => {
  it('stores suggestions from the secondary provider when the primary is overloaded', async () => {
    const site = makeSiteFixture();
    const primary = new FakeAIProvider(overloaded());
    const secondary = new FakeAIProvider({ suggestions: [voiceItem(site)] });
    const service = new InterlinkService(site.repo, {
      config: defaultConfig(),
      retriever: new LexicalCandidateRetriever(),
      analyzerFactory: async () => new FallbackRelevanceAnalyzer([analyzer(primary), analyzer(secondary)]),
      contentStore: new FakeContentStore(),
    });
    const app = await buildApp({
      settings: cleanSettings(),
      deps: { interlinkService: async () => ({ service, close: async () => {} }) },
    });
    try {
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      let body;
      try {
        const res = await app.inject({ method: 'POST', url: '/api/interlink/analyze', payload: { source_page_id: site.source.id } });
        expect(res.statusCode, res.body).toBe(200);
        body = res.json();
      } finally {
        spy.mockRestore();
      }
      // Still a normal AI analysis: only the provider changed.
      expect(body.generation_mode).toBe('ai');
      expect(body.ai_error).toBeNull();
      expect(body.suggestions).toHaveLength(1);
      expect([...site.repo.suggestions.values()][0].ai_provider).toBe('fake');
      expect(primary.calls).toHaveLength(1);
      expect(secondary.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
