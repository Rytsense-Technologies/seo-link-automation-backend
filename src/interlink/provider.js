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
      logger.warn(`${this.name} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
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

export async function buildAiProvider(settings, { fetchImpl } = {}) {
  const ProviderClass = (await loadProviderClasses())[settings.ai_provider];
  if (!ProviderClass || settings.ai_api_key === null || settings.ai_api_key === undefined) {
    throw new ServiceUnavailableError('No AI provider is configured (set AI_PROVIDER and AI_API_KEY)', {
      code: 'AI_PROVIDER_NOT_CONFIGURED',
    });
  }
  return new ProviderClass({
    apiKey: settings.ai_api_key,
    model: settings.ai_model || ProviderClass.DEFAULT_MODEL,
    baseUrl: settings.ai_base_url || ProviderClass.DEFAULT_BASE_URL,
    timeout: settings.ai_timeout_seconds,
    temperature: settings.ai_temperature,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

let cachedProvider = null;

/** Shared provider (like the lru_cached factory); failures are not cached. */
export async function getAiProvider(settings) {
  if (cachedProvider === null) cachedProvider = await buildAiProvider(settings);
  return cachedProvider;
}

export function resetAiProviderCache() {
  cachedProvider = null;
}
