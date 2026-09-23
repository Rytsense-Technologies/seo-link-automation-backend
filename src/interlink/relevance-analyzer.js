/**
 * AI relevance analysis: asks the configured LLM to judge backend-selected candidates
 * (app/interlink/relevance_analyzer.py). The model only ever sees candidates chosen by the
 * backend, referenced by ID. Any judgement for an unknown ID or with a mismatching URL is
 * discarded, so the AI cannot invent targets.
 */

import { normalizeUrl, siteRelative, urlKey } from '../utils/urls.js';
import { pyLen, pySliceHead, pyStrip } from '../utils/pytext.js';
import { AIProviderError } from './provider.js';
import { logger } from '../utils/logger.js';

export const SYSTEM_PROMPT = `You are an SEO editor who proposes contextual internal links between pages of one website.

Rules:
- Only choose targets from CANDIDATES, identified by their exact "id". Never invent or modify URLs.
- A target is relevant only if a reader of the SOURCE sentence would genuinely benefit from the
  target page. Topical keyword overlap alone is not enough.
- "suggested_context" MUST be one sentence copied VERBATIM from SOURCE.content (same words,
  same order). Do not paraphrase, shorten, or join sentences.
- "anchor_text" MUST be an exact, contiguous substring of "suggested_context" (2-6 words
  preferred) that naturally describes the target page.
- Never use generic anchors ("click here", "read more", "learn more", "here", "this page",
  "this article", "website", "link").
- Do not keyword-stuff; do not reuse an anchor listed in the candidate's "avoid_anchors".
- Use a different sentence for each target. Suggest at most one link per target.
- "reason" must be factual and based only on the provided page information; make no claims
  that are not supported by it.
- relevance_score: 0-100 (90+ = the target is a primary resource for the sentence's topic,
  70-89 = clearly useful, below 70 = weak).

Respond with a JSON object only:
{"suggestions": [{"target_page_id": "<candidate id>", "target_url": "<candidate url>",
"is_relevant": true, "relevance_score": 0, "reason": "...", "anchor_text": "...",
"suggested_context": "..."}]}
Omit candidates that are not relevant. Return {"suggestions": []} if none are relevant.
`;

function truncate(value, limit) {
  if (value === null || value === undefined || pyLen(value) <= limit) return value ?? null;
  const head = pySliceHead(value, limit);
  const i = head.lastIndexOf(' ');
  const cut = i >= 0 ? head.slice(0, i) : head;
  return `${cut}…`;
}

// ------------------------------------------------------------------ AIRelevanceItem (pydantic)

export class AIItemValidationError extends Error {
  constructor(type, field) {
    super(`${field}: ${type}`);
    this.name = 'ValidationError';
    this.type = type;
    this.field = field;
  }
}

const BOOL_TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const BOOL_FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** Python `round()` of a float to int (round half to even). */
function roundHalfEven(x) {
  if (!Number.isFinite(x)) throw new AIItemValidationError('value_error', 'relevance_score');
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function strField(entry, field, { required = true, min = 0, max = Infinity } = {}) {
  if (!(field in entry)) {
    if (required) throw new AIItemValidationError('missing', field);
    return null;
  }
  const value = entry[field];
  if (value === null && !required) return null;
  if (typeof value !== 'string') throw new AIItemValidationError('string_type', field);
  const stripped = pyStrip(value);
  const len = pyLen(stripped);
  if (len < min) throw new AIItemValidationError('string_too_short', field);
  if (len > max) throw new AIItemValidationError('string_too_long', field);
  return stripped;
}

function scoreField(entry) {
  if (!('relevance_score' in entry)) throw new AIItemValidationError('missing', 'relevance_score');
  let value = entry.relevance_score;
  let score;
  if (typeof value === 'boolean') {
    score = value ? 1 : 0;
  } else if (typeof value === 'number') {
    score = Number.isInteger(value) ? value : roundHalfEven(value);
  } else if (typeof value === 'string') {
    value = pyStrip(value);
    if (!/^[+-]?\d+(?:\.0*)?$/.test(value)) throw new AIItemValidationError('int_parsing', 'relevance_score');
    score = Number.parseInt(value, 10);
  } else {
    throw new AIItemValidationError('int_type', 'relevance_score');
  }
  if (score < 0) throw new AIItemValidationError('greater_than_equal', 'relevance_score');
  if (score > 100) throw new AIItemValidationError('less_than_equal', 'relevance_score');
  return score;
}

function boolField(entry) {
  if (!('is_relevant' in entry)) return true;
  const value = entry.is_relevant;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new AIItemValidationError('bool_parsing', 'is_relevant');
  }
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (BOOL_TRUE.has(v)) return true;
    if (BOOL_FALSE.has(v)) return false;
    throw new AIItemValidationError('bool_parsing', 'is_relevant');
  }
  throw new AIItemValidationError('bool_type', 'is_relevant');
}

/** `AIRelevanceItem.model_validate` (extra fields ignored, strings stripped). */
export function validateAiItem(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new AIItemValidationError('model_type', 'item');
  }
  return {
    target_page_id: strField(entry, 'target_page_id', { min: 1 }),
    target_url: strField(entry, 'target_url', { required: false }),
    is_relevant: boolField(entry),
    relevance_score: scoreField(entry),
    reason: strField(entry, 'reason', { min: 1, max: 2000 }),
    anchor_text: strField(entry, 'anchor_text', { min: 1, max: 255 }),
    suggested_context: strField(entry, 'suggested_context', { min: 1, max: 2000 }),
  };
}

/** Python `str(value)` for the discard key of an invalid item. */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ------------------------------------------------------------------ analyzer

export class RelevanceAnalyzer {
  constructor(provider, { sourceContentMaxChars, targetExcerptChars }) {
    this.provider = provider;
    this.sourceMax = sourceContentMaxChars;
    this.excerpt = targetExcerptChars;
  }

  get providerName() {
    return this.provider.name;
  }

  get modelName() {
    return this.provider.model;
  }

  buildPrompt({ sourceUrl, sourceTitle, sourceH1, sourceKeywords, sourceContent, candidates, candidateExcerpts, avoidAnchors }) {
    const payload = {
      SOURCE: {
        url: siteRelative(sourceUrl),
        title: sourceTitle ?? null,
        h1: sourceH1 ?? null,
        keywords: [...sourceKeywords].slice(0, 20),
        content: truncate(sourceContent, this.sourceMax),
      },
      CANDIDATES: candidates.map((c) => ({
        id: String(c.page.id),
        url: siteRelative(c.page.url),
        title: c.page.title ?? null,
        h1: c.page.h1 ?? null,
        description: truncate(c.page.meta_description, 300),
        keywords: [...(c.page.keywords ?? [])].slice(0, 10),
        page_type: c.page.page_type ?? null,
        excerpt: truncate(candidateExcerpts.get(String(c.page.id)) ?? null, this.excerpt),
        avoid_anchors: [...(avoidAnchors.get(String(c.page.id)) ?? [])].slice(0, 10),
      })),
    };
    return JSON.stringify(payload);
  }

  async analyze(prompt, candidates) {
    const raw = await this.provider.generateJson({ system: SYSTEM_PROMPT, prompt });
    return parseAiResponse(raw, candidates);
  }
}

/**
 * Tries each analyzer in order and returns the first successful analysis (e.g. Gemini, then Groq
 * when Gemini answers "503 high demand"). Each provider is called at most once per analysis: this
 * is a provider fallback, not a retry. Only AI provider failures (transport, HTTP error status,
 * invalid output) move on to the next provider; anything else propagates immediately, and the
 * last provider's error is raised when they all fail, so the existing 502 behaviour is unchanged.
 *
 * `providerName` / `modelName` report the provider that actually produced the analysis, so every
 * stored suggestion records where it came from.
 */
export class FallbackRelevanceAnalyzer {
  constructor(analyzers) {
    if (!analyzers.length) throw new Error('FallbackRelevanceAnalyzer needs at least one analyzer');
    this.analyzers = analyzers;
    this.active = analyzers[0];
  }

  get providerName() {
    return this.active.providerName;
  }

  get modelName() {
    return this.active.modelName;
  }

  buildPrompt(args) {
    // All analyzers share the same prompt limits, so the payload is built once.
    return this.analyzers[0].buildPrompt(args);
  }

  async analyze(prompt, candidates) {
    for (const [index, analyzer] of this.analyzers.entries()) {
      this.active = analyzer;
      try {
        return await analyzer.analyze(prompt, candidates);
      } catch (err) {
        const last = index === this.analyzers.length - 1;
        if (last || !(err instanceof AIProviderError)) throw err;
        const next = this.analyzers[index + 1];
        logger.warn(`${analyzer.providerName} failed (${err.message}); trying ${next.providerName}`);
      }
    }
    /* c8 ignore next */
    throw new AIProviderError('No AI provider produced an analysis');
  }
}

const absolutise = (url, reference) => normalizeUrl(url, reference) || url;

/** Validate the model output item-by-item against the candidate set. */
export function parseAiResponse(raw, candidates) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.suggestions)) {
    throw new AIProviderError("AI response did not contain a 'suggestions' list", { code: 'AI_INVALID_RESPONSE' });
  }
  const byId = new Map(candidates.map((c) => [String(c.page.id), c]));
  const items = new Map();
  const discarded = new Map();
  raw.suggestions.forEach((entry, index) => {
    let item;
    try {
      item = validateAiItem(entry);
    } catch (err) {
      const isDict = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
      const key = isDict ? pyStr(entry.target_page_id) : `#${index}`;
      discarded.set(key, 'INVALID_AI_ITEM');
      logger.warn(`Discarding invalid AI item ${key}: ${err.message}`);
      return;
    }
    const candidate = byId.get(item.target_page_id);
    if (candidate === undefined) {
      discarded.set(item.target_page_id, 'UNKNOWN_TARGET');
      logger.warn(`AI returned unknown target id ${item.target_page_id}; discarded`);
      return;
    }
    if (item.target_url && urlKey(absolutise(item.target_url, candidate.page.url)) !== urlKey(candidate.page.url)) {
      discarded.set(item.target_page_id, 'TARGET_URL_MISMATCH');
      logger.warn(`AI changed URL for target ${item.target_page_id}; discarded`);
      return;
    }
    if (!item.is_relevant) {
      discarded.set(item.target_page_id, 'NOT_RELEVANT');
      return;
    }
    const previous = items.get(item.target_page_id);
    if (previous === undefined || item.relevance_score > previous.relevance_score) items.set(item.target_page_id, item);
  });
  return { items: [...items.values()], discarded };
}
