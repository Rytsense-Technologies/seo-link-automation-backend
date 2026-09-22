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
  },
  required: ['source_page_id'],
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
    suggestions: { type: 'array', items: { $ref: 'SuggestionRead#' } },
    skipped: { type: 'array', items: { $ref: 'SkippedCandidate#' } },
  },
  required: [
    'source_page_id', 'min_relevance_score', 'candidates_retrieved', 'candidates_after_filtering', 'excluded_counts',
    'dry_run', 'suggestions', 'skipped',
  ],
};

export const SuggestionList = {
  $id: 'SuggestionList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'SuggestionRead#' } },
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
  SuggestionStatus, AnalyzeRequest, SuggestionRead, SuggestionDetail, SkippedCandidate, AnalyzeResponse, SuggestionList,
  RejectRequest,
];
