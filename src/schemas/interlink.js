/** Schemas for the interlink endpoints (app/interlink/schemas.py). */

import { nullableDateTime, uuid, uuidOut } from './common.js';

export const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED'];

export const SuggestionStatus = {
  $id: 'SuggestionStatus',
  type: 'string',
  enum: SUGGESTION_STATUSES,
  description: 'PENDING, APPROVED, REJECTED, APPLIED',
};

export const AnalyzeRequest = {
  $id: 'AnalyzeRequest',
  type: 'object',
  properties: {
    source_page_id: uuid,
    max_suggestions: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 50,
      default: null,
      description: 'Defaults to INTERLINK_MAX_SUGGESTIONS_PER_PAGE',
    },
    min_relevance_score: {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 100,
      default: null,
      description: 'Override INTERLINK_MIN_RELEVANCE_SCORE; cannot go below the configured value',
    },
    dry_run: { type: 'boolean', default: false, description: 'Return suggestions without storing them' },
    use_ai: {
      type: 'boolean',
      default: true,
      description:
        'false = deterministic suggestions only (explainable lexical scoring; anchors are phrases that already ' +
        'appear in the source). The AI provider is not called. min_relevance_score then defaults to ' +
        'INTERLINK_DETERMINISTIC_MIN_SCORE x 100.',
    },
    ai_fallback: {
      type: 'boolean',
      default: false,
      description:
        'true = if the AI provider is not configured, fails or returns invalid output, return deterministic ' +
        'suggestions (generation_mode "deterministic_fallback") instead of 503/502. Default false keeps 502/503.',
    },
  },
  required: ['source_page_id'],
  examples: [
    { source_page_id: '3f2c8a4e-1b6d-4c1e-9a53-0d7f6b2e8c11', max_suggestions: 5, min_relevance_score: 60, use_ai: true, ai_fallback: true },
    { source_page_id: '3f2c8a4e-1b6d-4c1e-9a53-0d7f6b2e8c11', use_ai: false, dry_run: true },
  ],
};

export const GENERATION_MODES = ['ai', 'deterministic', 'deterministic_fallback'];

export const ScoreSignals = {
  $id: 'ScoreSignals',
  type: 'object',
  description:
    'Deterministic relevance signals, each 0-1. Terms are weighted by site-level IDF and generic business ' +
    'words (software, development, company, service, ...) are damped, so shared boilerplate scores ~0.',
  properties: {
    anchor_quality: {
      type: 'number',
      description:
        'How useful the selected anchor is (0 when the source offers no usable phrase): phrase specificity, ' +
        'how much of the target title/H1/keywords it conveys, and how established it is in the source copy. ' +
        'Not a word count - a specific single word can beat a generic multi-word phrase.',
    },
    title_overlap: { type: 'number', description: 'Source title vs target title (weighted Jaccard)' },
    h1_overlap: { type: 'number', description: 'Source H1 vs target H1 (weighted Jaccard)' },
    content_title: { type: 'number', description: 'Share of the target title found in the source text' },
    content_h1: { type: 'number', description: 'Share of the target H1 found in the source text' },
    keyword_overlap: { type: 'number', description: 'Share of the target keywords found in the source text' },
    phrase_overlap: { type: 'number', description: 'Share of target 2-3 word phrases found in the source body copy' },
    slug_similarity: { type: 'number', description: 'Share of target URL slug words found in the source text' },
    region_language: { type: 'number', description: '1 = same language/region, lower when unknown or different' },
    quality: { type: 'number', description: 'Target has title, H1, meta description, keywords' },
  },
  required: [
    'anchor_quality', 'title_overlap', 'h1_overlap', 'content_title', 'content_h1', 'keyword_overlap', 'phrase_overlap',
    'slug_similarity', 'region_language', 'quality',
  ],
};

export const CandidateScore = {
  $id: 'CandidateScore',
  type: 'object',
  properties: {
    target_page_id: uuidOut,
    target_url: { type: 'string' },
    retrieval_score: { type: ['number', 'null'], description: 'TF-IDF retrieval score (AI mode); null in deterministic modes' },
    score: { type: 'number', minimum: 0, maximum: 1, description: 'Deterministic relevance score 0-1' },
    signals: { $ref: 'ScoreSignals#' },
  },
  required: ['target_page_id', 'target_url', 'retrieval_score', 'score', 'signals'],
  examples: [
    {
      target_page_id: '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e',
      target_url: 'https://rytsensetech.com/ai-voice-agent/',
      retrieval_score: null,
      score: 0.71,
      signals: {
        anchor_quality: 0.86,
        title_overlap: 0.12, h1_overlap: 0.1, content_title: 0.92, content_h1: 0.81, keyword_overlap: 0.64,
        phrase_overlap: 0.5, slug_similarity: 0.88, region_language: 1, quality: 1,
      },
    },
  ],
};

const suggestionReadProperties = {
  id: { type: ['string', 'null'], format: 'uuid', description: 'Null for dry-run results' },
  site_id: uuidOut,
  source_page_id: uuidOut,
  target_page_id: uuidOut,
  anchor_text: { type: 'string' },
  context: { type: 'string' },
  relevance_score: { type: 'integer', minimum: 0, maximum: 100 },
  reason: { type: 'string' },
  status: { $ref: 'SuggestionStatus#' },
  created_at: nullableDateTime,
  updated_at: nullableDateTime,
  applied_at: nullableDateTime,
};

export const SuggestionRead = {
  $id: 'SuggestionRead',
  type: 'object',
  properties: suggestionReadProperties,
  required: Object.keys(suggestionReadProperties),
};

const suggestionListItemProperties = {
  ...suggestionReadProperties,
  target_url: {
    type: 'string',
    description: 'URL of the target page, from the join the listing already performs (no extra request needed)',
    examples: ['https://rytsensetech.com/blog/enterprise-ai-chatbot-development-cost/'],
  },
};

/** A listed suggestion: the read model plus the target page URL. */
export const SuggestionListItem = {
  $id: 'SuggestionListItem',
  type: 'object',
  properties: suggestionListItemProperties,
  required: Object.keys(suggestionListItemProperties),
};

const detailProperties = {
  ...suggestionReadProperties,
  retrieval_score: { type: ['number', 'null'] },
  ai_provider: { type: ['string', 'null'] },
  ai_model: { type: ['string', 'null'] },
  rejection_reason: { type: ['string', 'null'] },
  reviewed_at: nullableDateTime,
  source_page: { $ref: 'PageSummary#' },
  target_page: { $ref: 'PageSummary#' },
  target_url: { type: 'string', description: 'Target page URL the link points to' },
};

export const SuggestionDetail = {
  $id: 'SuggestionDetail',
  type: 'object',
  properties: detailProperties,
  required: Object.keys(detailProperties),
};

export const SkippedCandidate = {
  $id: 'SkippedCandidate',
  type: 'object',
  properties: {
    target_page_id: uuidOut,
    target_url: { type: 'string' },
    reason: { type: 'string', examples: ['BELOW_THRESHOLD', 'ACTIVE_SUGGESTION_EXISTS', 'NOINDEX'] },
  },
  required: ['target_page_id', 'target_url', 'reason'],
};

export const AnalyzeResponse = {
  $id: 'AnalyzeResponse',
  type: 'object',
  properties: {
    source_page_id: uuidOut,
    min_relevance_score: { type: 'integer' },
    candidates_retrieved: { type: 'integer' },
    candidates_after_filtering: { type: 'integer' },
    excluded_counts: {
      type: 'object',
      additionalProperties: { type: 'integer' },
      description: 'Pages removed before AI scoring, by reason (e.g. NOINDEX, REDIRECTED)',
    },
    dry_run: { type: 'boolean' },
    generation_mode: {
      type: 'string',
      enum: GENERATION_MODES,
      description: 'ai | deterministic (use_ai=false) | deterministic_fallback (ai_fallback=true and the AI failed)',
    },
    ai_error: {
      type: ['string', 'null'],
      description: 'Why the AI was not used in deterministic_fallback mode, else null',
      examples: ['AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_ERROR', 'AI_INVALID_RESPONSE'],
    },
    candidates: {
      type: 'array',
      items: { $ref: 'CandidateScore#' },
      description: 'Candidate pool with explainable deterministic scores (why each target ranked where it did)',
    },
    suggestions: { type: 'array', items: { $ref: 'SuggestionRead#' } },
    skipped: { type: 'array', items: { $ref: 'SkippedCandidate#' } },
  },
  required: [
    'source_page_id', 'min_relevance_score', 'candidates_retrieved', 'candidates_after_filtering', 'excluded_counts',
    'dry_run', 'generation_mode', 'ai_error', 'candidates', 'suggestions', 'skipped',
  ],
};

export const SuggestionList = {
  $id: 'SuggestionList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'SuggestionListItem#' } },
    total: { type: 'integer' },
    page: { type: 'integer' },
    page_size: { type: 'integer' },
  },
  required: ['items', 'total', 'page', 'page_size'],
};

export const RejectRequest = {
  $id: 'RejectRequest',
  type: ['object', 'null'],
  properties: { reason: { type: ['string', 'null'], maxLength: 2000, default: null } },
};

export const interlinkSchemas = [
  SuggestionStatus, AnalyzeRequest, SuggestionRead, SuggestionListItem, SuggestionDetail, SkippedCandidate, ScoreSignals,
  CandidateScore, AnalyzeResponse, SuggestionList, RejectRequest,
];
