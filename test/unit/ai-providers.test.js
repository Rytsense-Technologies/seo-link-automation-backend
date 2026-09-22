// Port of tests/unit/test_ai_providers.py — providers exercised against a fake fetch; no network.
import { describe, expect, it } from 'vitest';
import { AIProviderError, buildAiProvider } from '../../src/interlink/provider.js';
import { GeminiProvider } from '../../src/interlink/gemini.js';
import { GroqProvider } from '../../src/interlink/groq.js';
import { ServiceUnavailableError } from '../../src/utils/errors.js';
import { cleanSettings } from '../helpers/fakes.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AI providers', () => {
  it('Gemini request and parse', async () => {
    const seen = {};
    const fetchImpl = async (url, init) => {
      seen.url = url;
      seen.key = init.headers['x-goog-api-key'];
      seen.body = JSON.parse(init.body);
      return json(200, { candidates: [{ content: { parts: [{ text: '{"suggestions": []}' }] } }] });
    };
    const provider = new GeminiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://gemini.test/v1beta', timeout: 5, temperature: 0.1, fetchImpl });
    expect(await provider.generateJson({ system: 'sys', prompt: 'p' })).toEqual({ suggestions: [] });
    expect(seen.url).toBe('https://gemini.test/v1beta/models/m:generateContent');
    expect(seen.key).toBe('k');
    expect(seen.body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('Groq (OpenAI-compatible) request and errors', async () => {
    const ok = async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer k');
      expect(JSON.parse(init.body).response_format).toEqual({ type: 'json_object' });
      return json(200, { choices: [{ message: { content: '{"a": 1}' } }] });
    };
    const kwargs = { apiKey: 'k', model: 'm', baseUrl: 'https://groq.test', timeout: 5.0, temperature: 0.1 };
    expect(await new GroqProvider({ ...kwargs, fetchImpl: ok }).generateJson({ system: 's', prompt: 'p' })).toEqual({ a: 1 });

    const failing = new GroqProvider({ ...kwargs, fetchImpl: async () => new Response('rate limited', { status: 429 }) });
    const err = await failing.generateJson({ system: 's', prompt: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.statusCode).toBe(502);
    expect(err.details).toEqual({ provider_status: 429 });

    const offline = new GroqProvider({
      ...kwargs,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(offline.generateJson({ system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AIProviderError);
  });

  it('factory requires configuration', async () => {
    const err = await buildAiProvider(cleanSettings({ ai_provider: 'none' })).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    await expect(buildAiProvider(cleanSettings({ ai_provider: 'gemini', ai_api_key: null }))).rejects.toBeInstanceOf(ServiceUnavailableError);
    const provider = await buildAiProvider(cleanSettings({ ai_provider: 'groq', ai_api_key: 'x' }));
    expect(provider.name).toBe('groq');
    expect(provider.model).toBe(GroqProvider.DEFAULT_MODEL);
  });
});
