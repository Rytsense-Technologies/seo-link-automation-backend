// Provider error bodies must stay readable (and safe) in logs; codes/messages are unchanged.
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../../src/interlink/gemini.js';
import { AIProviderError, summariseErrorBody } from '../../src/interlink/provider.js';
import { logger } from '../../src/utils/logger.js';

const provider = (fetchImpl) =>
  new GeminiProvider({ apiKey: 'AIza-SECRET-KEY-VALUE', model: 'm', baseUrl: 'https://example.invalid', timeout: 5, temperature: 0, fetchImpl });

describe('summariseErrorBody', () => {
  it('keeps readable bodies (collapsed and truncated)', () => {
    expect(summariseErrorBody('{"error":{"message":"API key not valid"}}')).toBe('{"error":{"message":"API key not valid"}}');
    expect(summariseErrorBody('line one\n\n  line two\t')).toBe('line one line two');
    expect(summariseErrorBody('x'.repeat(600))).toBe(`${'x'.repeat(500)}…`);
    expect(summariseErrorBody('')).toBe('<empty body>');
    expect(summariseErrorBody(undefined)).toBe('<empty body>');
  });

  it('replaces binary bodies with a short placeholder', () => {
    // What a gzip body looks like after being read as text.
    const binary = gzipSync(Buffer.from('{"error":"overloaded"}')).toString('utf8');
    const summary = summariseErrorBody(binary);
    expect(summary).toMatch(/^<non-text body, \d+ bytes>$/);
    expect(summary).not.toMatch(/[�\u0000-\u001F]/);
  });

  it('strips stray control characters from otherwise readable text', () => {
    const body = `{"error":{"message":"Bad\u0000 request for this model","status":"INVALID_ARGUMENT"}}`;
    expect(summariseErrorBody(body)).toBe('{"error":{"message":"Bad request for this model","status":"INVALID_ARGUMENT"}}');
    // A short string that is mostly control characters counts as binary, not text.
    expect(summariseErrorBody('bad\u0000req\u0007')).toMatch(/^<non-text body/);
  });
});

describe('provider error logging', () => {
  it('logs a placeholder instead of raw bytes, and still raises the same error', async () => {
    const lines = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((...args) => lines.push(String(args[0])));
    try {
      const body = gzipSync(Buffer.from('{"error":{"message":"The model is overloaded."}}')).toString('utf8');
      const err = await provider(async () => ({ status: 503, text: async () => body }))
        .generateJson({ system: 's', prompt: 'p' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AIProviderError);
      expect(err.message).toBe('gemini returned HTTP 503');
      expect(err.statusCode).toBe(502);
      expect(err.details).toEqual({ provider_status: 503 });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^gemini returned HTTP 503: <non-text body, \d+ bytes>$/);
    expect(lines[0]).not.toContain('AIza-SECRET-KEY-VALUE');
  });

  it('still logs readable provider errors verbatim', async () => {
    const lines = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((...args) => lines.push(String(args[0])));
    try {
      await provider(async () => ({ status: 400, text: async () => '{"error":{"message":"API key not valid"}}' }))
        .generateJson({ system: 's', prompt: 'p' })
        .catch(() => {});
    } finally {
      spy.mockRestore();
    }
    expect(lines[0]).toBe('gemini returned HTTP 400: {"error":{"message":"API key not valid"}}');
  });
});
