/** Provider-agnostic interface for LLM calls that must return a JSON object (app/ai/base.py + factory.py). */

import { ServiceUnavailableError, UpstreamError } from '../utils/errors.js';
import { pyStrip } from '../utils/pytext.js';
import { logger } from '../utils/logger.js';

export class AIProviderError extends UpstreamError {
  static code = 'AI_PROVIDER_ERROR';
}

/** Base class: subclasses implement `generateJson({ system, prompt })`. */
export class AIProvider {
  static providerName = 'base';

  constructor(model) {
    this.model = model;
  }

  get name() {
    return this.constructor.providerName;
  }

  // eslint-disable-next-line no-unused-vars
  async generateJson({ system, prompt }) {
    throw new Error('not implemented');
  }
}

/** Parse a JSON object from model output, tolerating ```json fences. */
export function parseJsonObject(text) {
  let cleaned = pyStrip(text);
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^`+|`+$/g, '');
    if (cleaned.startsWith('json')) cleaned = cleaned.slice(4);
    cleaned = pyStrip(cleaned);
  }
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new AIProviderError('AI provider returned invalid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIProviderError('AI provider returned JSON that is not an object');
  }
  return value;
}

/**
 * One-line, log-safe summary of an error response body. Providers occasionally answer with a
 * body that is not readable text (e.g. a gzip-encoded error page that arrives undecoded), which
 * would otherwise put raw bytes and control characters into the log. Only used for logging: the
 * error code, message and HTTP status are unaffected.
 */
export function summariseErrorBody(text, limit = 500) {
  if (!text) return '<empty body>';
  // U+FFFD appears where bytes were not valid UTF-8; C0 controls never occur in a text body.
  const unreadable = (text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  if (unreadable > text.length / 20) return `<non-text body, ${text.length} bytes>`;
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

/** Shared HTTP plumbing (never logs the request: it carries credentials). */
export class HTTPProvider extends AIProvider {
  constructor({ apiKey, model, baseUrl, timeout, temperature, fetchImpl = globalThis.fetch }) {
    super(model);
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.temperature = temperature;
    this.timeoutMs = Math.round(timeout * 1000);
    this.fetchImpl = fetchImpl;
  }

  async post(url, { headers, body }) {
    let response;
    let text;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      logger.warn(`${this.name} request failed: ${err?.message ?? err}`);
      throw new AIProviderError(`${this.name} request failed`);
    }
    if (response.status >= 400) {
      logger.warn(`${this.name} returned HTTP ${response.status}: ${summariseErrorBody(text)}`);
      throw new AIProviderError(`${this.name} returned HTTP ${response.status}`, {
        details: { provider_status: response.status },
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AIProviderError(`${this.name} returned a non-JSON response`);
    }
  }
}

let providerClasses = null;

async function loadProviderClasses() {
  if (providerClasses === null) {
    const [{ GeminiProvider }, { OpenAICompatibleProvider }, { GroqProvider }] = await Promise.all([
      import('./gemini.js'),
      import('./openai.js'),
      import('./groq.js'),
    ]);
    providerClasses = { gemini: GeminiProvider, groq: GroqProvider, openai: OpenAICompatibleProvider };
  }
  return providerClasses;
}

async function buildProvider(settings, { name, apiKey, model, baseUrl, fetchImpl }) {
  const ProviderClass = (await loadProviderClasses())[name];
  if (!ProviderClass || apiKey === null || apiKey === undefined) return null;
  return new ProviderClass({
    apiKey,
    model: model || ProviderClass.DEFAULT_MODEL,
    baseUrl: baseUrl || ProviderClass.DEFAULT_BASE_URL,
    timeout: settings.ai_timeout_seconds,
    temperature: settings.ai_temperature,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export async function buildAiProvider(settings, { fetchImpl } = {}) {
  const provider = await buildProvider(settings, {
    name: settings.ai_provider,
    apiKey: settings.ai_api_key,
    model: settings.ai_model,
    baseUrl: settings.ai_base_url,
    fetchImpl,
  });
  if (provider === null) {
    throw new ServiceUnavailableError('No AI provider is configured (set AI_PROVIDER and AI_API_KEY)', {
      code: 'AI_PROVIDER_NOT_CONFIGURED',
    });
  }
  return provider;
}

/**
 * The optional secondary provider (AI_FALLBACK_PROVIDER/_API_KEY), or null when it is not
 * configured. It is tried once after the primary provider fails; see FallbackRelevanceAnalyzer.
 */
export async function buildFallbackAiProvider(settings, { fetchImpl } = {}) {
  return buildProvider(settings, {
    name: settings.ai_fallback_provider,
    apiKey: settings.ai_fallback_api_key,
    model: settings.ai_fallback_model,
    baseUrl: settings.ai_fallback_base_url,
    fetchImpl,
  });
}

let cachedProvider = null;
let cachedFallbackProvider = null;

/** Shared provider (like the lru_cached factory); failures are not cached. */
export async function getAiProvider(settings) {
  if (cachedProvider === null) cachedProvider = await buildAiProvider(settings);
  return cachedProvider;
}

/** Shared secondary provider, or null when none is configured. */
export async function getFallbackAiProvider(settings) {
  if (cachedFallbackProvider === null) cachedFallbackProvider = await buildFallbackAiProvider(settings);
  return cachedFallbackProvider;
}

export function resetAiProviderCache() {
  cachedProvider = null;
  cachedFallbackProvider = null;
}
