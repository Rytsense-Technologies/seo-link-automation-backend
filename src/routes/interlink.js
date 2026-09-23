/** /api/interlink routes (app/interlink/router.py). */

import { ERROR_RESPONSES, errorResponses, normaliseUuid, uuid } from '../schemas/common.js';

const AI_ERRORS = errorResponses({
  502: 'AI provider failed or returned invalid output',
  503: 'AI provider not configured / database error',
});

const idParams = { type: 'object', properties: { suggestion_id: uuid }, required: ['suggestion_id'] };

export function toRead(s) {
  return {
    id: s.id,
    site_id: s.site_id,
    source_page_id: s.source_page_id,
    target_page_id: s.target_page_id,
    anchor_text: s.anchor_text,
    context: s.context,
    relevance_score: s.relevance_score,
    reason: s.reason,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    applied_at: s.applied_at,
  };
}

export function toDetail(s) {
  const summary = (p) => ({ id: p.id, url: p.url, title: p.title ?? null, h1: p.h1 ?? null });
  return {
    ...toRead(s),
    retrieval_score: s.retrieval_score,
    ai_provider: s.ai_provider,
    ai_model: s.ai_model,
    rejection_reason: s.rejection_reason,
    reviewed_at: s.reviewed_at,
    source_page: summary(s.source_page),
    target_page: summary(s.target_page),
    target_url: s.target_page.url,
  };
}

/** Run a handler with a per-request interlink service (one DB session, always closed). */
async function withService(app, fn) {
  const { service, close } = await app.deps.interlinkService();
  try {
    return await fn(service);
  } finally {
    await close();
  }
}

export default async function interlinkRoutes(app) {
  app.post(
    '/interlink/analyze',
    {
      schema: {
        tags: ['interlink'],
        summary: 'Generate internal-link suggestions for a source page',
        description: `Runs hard filters, lexical candidate retrieval (pool of
\`INTERLINK_CANDIDATE_POOL_SIZE\`), AI relevance scoring, anchor/context validation and the
\`INTERLINK_MIN_RELEVANCE_SCORE\` threshold. New suggestions are stored as \`PENDING\`
unless \`dry_run\` is true. Pairs that already have a PENDING/APPROVED/APPLIED suggestion,
or were rejected within \`INTERLINK_REJECTION_COOLDOWN_DAYS\`, are not regenerated.

**Generation modes** (\`generation_mode\` in the response):
- \`ai\` (default): the AI judges only the retrieved candidate pool. AI unavailable -> 503,
  AI failure / invalid output -> 502.
- \`deterministic\` (\`use_ai: false\`): no AI call. Targets are ranked by explainable signals
  (see \`candidates[].signals\`), and a link is proposed only where a phrase from the target's
  title/H1/keywords already appears in a source sentence (skip reason \`NO_ANCHOR_IN_SOURCE\`
  otherwise). Threshold: \`INTERLINK_DETERMINISTIC_MIN_SCORE\` x 100 (or a higher
  \`min_relevance_score\`).
- \`deterministic_fallback\` (\`ai_fallback: true\`): as \`deterministic\`, used only when the AI
  is not configured, fails, or returns invalid output; \`ai_error\` gives the reason. No retries.

Suggestions are always stored as PENDING for human review; no page content is changed here.`,
        body: { $ref: 'AnalyzeRequest#' },
        response: { 200: { $ref: 'AnalyzeResponse#' }, ...ERROR_RESPONSES, ...AI_ERRORS },
      },
    },
    async (request) =>
      withService(app, async (service) => {
        const body = { ...request.body, source_page_id: normaliseUuid(request.body.source_page_id) };
        const outcome = await service.analyze(body);
        return { ...outcome, suggestions: outcome.suggestions.map(toRead) };
      }),
  );

  app.get(
    '/interlink/suggestions',
    {
      schema: {
        tags: ['interlink'],
        summary: 'List suggestions',
        querystring: {
          type: 'object',
          properties: {
            status: { anyOf: [{ $ref: 'SuggestionStatus#' }, { type: 'null' }], description: 'PENDING, APPROVED, REJECTED, APPLIED' },
            site_id: { ...uuid, type: ['string', 'null'] },
            source_page_id: { ...uuid, type: ['string', 'null'] },
            target_page_id: { ...uuid, type: ['string', 'null'] },
            min_relevance_score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: { 200: { $ref: 'SuggestionList#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      withService(app, async (service) => {
        const q = request.query;
        const filters = {
          status: q.status ?? null,
          site_id: q.site_id ? normaliseUuid(q.site_id) : null,
          source_page_id: q.source_page_id ? normaliseUuid(q.source_page_id) : null,
          target_page_id: q.target_page_id ? normaliseUuid(q.target_page_id) : null,
          min_relevance_score: q.min_relevance_score ?? null,
        };
        const [items, total] = await service.listSuggestions(filters, { page: q.page, pageSize: q.page_size });
        return { items: items.map(toRead), total, page: q.page, page_size: q.page_size };
      }),
  );

  app.get(
    '/interlink/suggestions/:suggestion_id',
    {
      schema: {
        tags: ['interlink'],
        summary: 'Suggestion detail',
        params: idParams,
        response: { 200: { $ref: 'SuggestionDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      withService(app, async (service) => toDetail(await service.getSuggestion(normaliseUuid(request.params.suggestion_id)))),
  );

  app.post(
    '/interlink/suggestions/:suggestion_id/approve',
    {
      schema: {
        tags: ['interlink'],
        summary: 'Approve a suggestion (PENDING/REJECTED -> APPROVED)',
        params: idParams,
        response: { 200: { $ref: 'SuggestionDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      withService(app, async (service) => toDetail(await service.approve(normaliseUuid(request.params.suggestion_id)))),
  );

  app.post(
    '/interlink/suggestions/:suggestion_id/reject',
    {
      // FastAPI: `RejectRequest | None = Body(default=None)`.
      config: { body: 'none' },
      schema: {
        tags: ['interlink'],
        summary: 'Reject a suggestion (PENDING/APPROVED -> REJECTED)',
        params: idParams,
        body: { $ref: 'RejectRequest#' },
        response: { 200: { $ref: 'SuggestionDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      withService(app, async (service) =>
        toDetail(await service.reject(normaliseUuid(request.params.suggestion_id), request.body?.reason ?? null)),
      ),
  );

  app.post(
    '/interlink/suggestions/:suggestion_id/apply',
    {
      schema: {
        tags: ['interlink'],
        summary: 'Apply an APPROVED suggestion to the source page content',
        description: `Re-validates the source and target pages, verifies the source does not already link to
the target and that the approved context sentence still exists, then inserts exactly one
\`<a>\` around the anchor inside that sentence. Text inside existing links, headings,
navigation, code, script/style and other unsafe elements is never linked.

Errors: \`409 SUGGESTION_NOT_APPROVED | ALREADY_LINKED | TARGET_NOT_LINKABLE |
CONTENT_VERSION_CONFLICT\`, \`422 CONTEXT_NOT_FOUND | ANCHOR_NOT_FOUND |
ANCHOR_IN_UNSAFE_ELEMENT\`.`,
        params: idParams,
        response: { 200: { $ref: 'SuggestionDetail#' }, ...ERROR_RESPONSES },
      },
    },
    async (request) =>
      withService(app, async (service) => toDetail(await service.apply(normaliseUuid(request.params.suggestion_id)))),
  );
}
