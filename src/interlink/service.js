/**
 * Interlink orchestration: analyze -> filter -> retrieve -> AI score -> validate -> store, plus
 * the review (approve/reject) and safe-apply workflow (app/interlink/service.py).
 */

import { randomUUID } from 'node:crypto';
import { extractBlocks, extractText } from '../content/html.js';
import { internalLinksFor } from '../content/store.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, UnprocessableError } from '../utils/errors.js';
import { siteRelative } from '../utils/urls.js';
import { pyCompare, pySliceHead } from '../utils/pytext.js';
import { anchorProblem, containsPhrase, normalizeForMatch } from './anchor-rules.js';
import {
  ExclusionReason,
  filterCandidates,
  filterConfig,
  linkedUrlKeys,
  targetExclusionReason,
} from './candidate-filter.js';
import { LinkApplicationError, applyLink } from './apply.js';
import { SuggestionStatus } from './repository.js';
import { AIProviderError } from './provider.js';
import { buildTermWeights, scoreTarget, sourceProfile } from './relevance-scorer.js';
import {
  DETERMINISTIC_PROVIDER,
  NO_ANCHOR_IN_SOURCE,
  deterministicItem,
  findPlacements,
  rankPlacements,
  splitSentences,
} from './deterministic-suggester.js';
import { logger } from '../utils/logger.js';

export const GenerationMode = Object.freeze({
  AI: 'ai',
  DETERMINISTIC: 'deterministic',
  DETERMINISTIC_FALLBACK: 'deterministic_fallback',
});

/** Errors that `ai_fallback: true` may turn into deterministic suggestions (never DB/validation errors). */
export function isAiFailure(err) {
  return err instanceof AIProviderError || (err instanceof ServiceUnavailableError && err.code === 'AI_PROVIDER_NOT_CONFIGURED');
}

export const SkipReason = Object.freeze({
  ACTIVE_SUGGESTION_EXISTS: 'ACTIVE_SUGGESTION_EXISTS',
  RECENTLY_REJECTED: 'RECENTLY_REJECTED',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  CONTEXT_NOT_IN_SOURCE: 'CONTEXT_NOT_IN_SOURCE',
  CONTEXT_ALREADY_USED: 'CONTEXT_ALREADY_USED',
  DUPLICATE_ANCHOR: 'DUPLICATE_ANCHOR',
  ANCHOR_OVERUSED: 'ANCHOR_OVERUSED',
  MAX_SUGGESTIONS_REACHED: 'MAX_SUGGESTIONS_REACHED',
  NO_ANCHOR_IN_SOURCE,
});

export function interlinkConfig(overrides = {}) {
  return {
    minRelevanceScore: 70,
    candidatePoolSize: 15,
    maxSuggestionsPerPage: 5,
    rejectionCooldownDays: 30,
    maxAnchorReuse: 3,
    targetExcerptChars: 300,
    deterministicMinScore: 0.35,
    filters: filterConfig(),
    ...overrides,
  };
}

export function interlinkConfigFromSettings(s) {
  return interlinkConfig({
    minRelevanceScore: s.interlink_min_relevance_score,
    candidatePoolSize: s.interlink_candidate_pool_size,
    maxSuggestionsPerPage: s.interlink_max_suggestions_per_page,
    rejectionCooldownDays: s.interlink_rejection_cooldown_days,
    maxAnchorReuse: s.interlink_max_anchor_reuse,
    targetExcerptChars: s.interlink_target_excerpt_chars,
    deterministicMinScore: s.interlink_deterministic_min_score,
    filters: filterConfig({
      utilityPageTypes: s.interlink_utility_page_types,
      utilityPathPatterns: s.interlink_utility_path_patterns,
      requireRegionMatch: s.interlink_require_region_match,
    }),
  });
}

const now = () => new Date();

const TRANSITIONS = {
  [SuggestionStatus.APPROVED]: new Set([SuggestionStatus.PENDING, SuggestionStatus.REJECTED]),
  [SuggestionStatus.REJECTED]: new Set([SuggestionStatus.PENDING, SuggestionStatus.APPROVED]),
  [SuggestionStatus.APPLIED]: new Set([SuggestionStatus.APPROVED]),
};

const skipped = (candidate, reason) => ({
  target_page_id: candidate.page.id,
  target_url: candidate.page.url,
  reason,
});

function newOutcome(run, { minScore, retrieved, mode, aiError = null }) {
  return {
    source_page_id: run.source.id,
    min_relevance_score: minScore,
    candidates_retrieved: retrieved,
    candidates_after_filtering: run.eligible.length,
    excluded_counts: run.excludedCounts,
    dry_run: run.request.dry_run,
    generation_mode: mode,
    ai_error: aiError,
    candidates: [],
    suggestions: [],
    skipped: [],
  };
}

const diagnostic = (scored, retrievalScore) => ({
  target_page_id: scored.page.id,
  target_url: scored.page.url,
  retrieval_score: retrievalScore,
  score: scored.score,
  signals: scored.signals,
});

/** Best available anchor for a target, with its quality (0 when the source has no usable phrase). */
function bestAnchor(page, sentences, profile, weight, options = {}) {
  const placements = rankPlacements(findPlacements(page, sentences, weight, options), page, profile, weight);
  return { placements, anchorQuality: placements.length ? placements[0].anchor_quality : 0 };
}

/** Explainable deterministic signals for the retrieved AI candidate pool (diagnostics only). */
function candidateDiagnostics(run, candidates) {
  if (!candidates.length) return [];
  const profile = sourceProfile(run.source, run.sourceText);
  const weight = buildTermWeights(run.source, run.eligible);
  const sentences = run.linkContexts.flatMap((block) => splitSentences(block));
  return candidates.map((c) => {
    const { anchorQuality } = bestAnchor(c.page, sentences, profile, weight);
    return diagnostic({ page: c.page, ...scoreTarget(profile, c.page, weight, { anchorQuality }) }, c.score);
  });
}

export class InterlinkService {
  /**
   * @param repository PgInterlinkRepository (or the in-memory fake)
   * @param analyzerFactory resolved lazily so review/apply work without an AI provider
   */
  constructor(repository, { config, retriever, analyzerFactory, contentStore }) {
    this.repo = repository;
    this.config = config;
    this.retriever = retriever;
    this.analyzerFactory = analyzerFactory;
    this.contentStore = contentStore;
  }

  // ------------------------------------------------------------------ analyze
  async analyze(request) {
    const cfg = this.config;
    const source = await this.repo.getPage(request.source_page_id);
    if (source === null) throw new NotFoundError('Source page not found', { code: 'PAGE_NOT_FOUND' });
    const content = this.contentStore.loadContent(source);
    if (source.http_status !== null && source.http_status !== undefined && !(source.http_status >= 200 && source.http_status < 300)) {
      throw new UnprocessableError('Source page is not a live (2xx) page', {
        code: 'SOURCE_NOT_ANALYZABLE',
        details: { http_status: source.http_status },
      });
    }
    if (!content) throw new UnprocessableError('Source page has no content', { code: 'SOURCE_CONTENT_EMPTY' });
    const linkContexts = extractBlocks(content, { linkContextsOnly: true });
    if (!linkContexts.length) {
      throw new UnprocessableError('Source page has no body copy that can host links', { code: 'NO_LINKABLE_CONTENT' });
    }

    const maxSuggestions = request.max_suggestions || cfg.maxSuggestionsPerPage;
    const linkedKeys = linkedUrlKeys([...(source.outgoing_links ?? []), ...internalLinksFor(source.url, content)]);

    // 1. Hard filters (deterministic, before any AI).
    const filtered = filterCandidates(source, await this.repo.listCandidatePool(source), cfg.filters, linkedKeys);
    const excludedCounts = Object.fromEntries([...filtered.excluded].map(([reason, pages]) => [reason, pages.length]));

    // 2. Duplicate prevention: skip pairs with an active or recently rejected suggestion.
    const active = await this.repo.activeTargetIds(source.id);
    const cooldownStart = new Date(now().getTime() - cfg.rejectionCooldownDays * 86_400_000);
    const recentlyRejected =
      cfg.rejectionCooldownDays > 0 ? await this.repo.rejectedTargetIdsSince(source.id, cooldownStart.toISOString()) : new Set();
    const eligible = [];
    for (const page of filtered.accepted) {
      if (active.has(page.id)) {
        excludedCounts[SkipReason.ACTIVE_SUGGESTION_EXISTS] = (excludedCounts[SkipReason.ACTIVE_SUGGESTION_EXISTS] ?? 0) + 1;
      } else if (recentlyRejected.has(page.id)) {
        excludedCounts[SkipReason.RECENTLY_REJECTED] = (excludedCounts[SkipReason.RECENTLY_REJECTED] ?? 0) + 1;
      } else {
        eligible.push(page);
      }
    }

    const sourceText = linkContexts.join('\n');
    const run = { request, source, content, linkContexts, sourceText, eligible, excludedCounts, maxSuggestions };
    // use_ai=false: deterministic only; the AI provider is never resolved or called.
    if (request.use_ai === false) return this.analyzeDeterministic(run, GenerationMode.DETERMINISTIC, null);

    // 3. Candidate retrieval.
    const minScore = Math.max(cfg.minRelevanceScore, request.min_relevance_score || 0);
    const candidates = this.retriever.retrieve(source, sourceText, eligible, cfg.candidatePoolSize);
    const outcome = newOutcome(run, { minScore, retrieved: candidates.length, mode: GenerationMode.AI });
    outcome.candidates = candidateDiagnostics(run, candidates);
    if (!candidates.length) {
      logger.info(`Interlink analysis for ${source.url}: no candidates`);
      return outcome;
    }

    // 4. AI relevance analysis over the compact candidate pool only.
    let analyzer;
    let analysis;
    let existingAnchors;
    try {
      analyzer = await this.analyzerFactory();
      const targetIds = candidates.map((c) => c.page.id);
      const contents = await this.repo.loadContents(targetIds);
      const excerpts = new Map([...contents].map(([pid, html]) => [String(pid), pySliceHead(extractText(html), cfg.targetExcerptChars)]));
      existingAnchors = await this.repo.anchorsByTarget(targetIds);
      const prompt = analyzer.buildPrompt({
        sourceUrl: source.url,
        sourceTitle: source.title,
        sourceH1: source.h1,
        sourceKeywords: source.keywords ?? [],
        sourceContent: sourceText,
        candidates,
        candidateExcerpts: excerpts,
        avoidAnchors: new Map([...existingAnchors].map(([k, v]) => [String(k), v])),
      });
      analysis = await analyzer.analyze(prompt, candidates);
    } catch (err) {
      // Without an explicit ai_fallback the existing 502/503 behaviour is preserved.
      if (!request.ai_fallback || !isAiFailure(err)) throw err;
      logger.warn(`AI suggestions unavailable for ${source.url} (${err.code}); using deterministic fallback`);
      return this.analyzeDeterministic(run, GenerationMode.DETERMINISTIC_FALLBACK, err.code);
    }
    const byId = new Map(candidates.map((c) => [String(c.page.id), c]));
    for (const [targetId, reason] of analysis.discarded) {
      const cand = byId.get(targetId);
      if (cand !== undefined) outcome.skipped.push(skipped(cand, reason));
    }

    // 5. Validate, threshold, and store.
    const state = this.storeState(run, minScore, existingAnchors);
    const ordered = [...analysis.items].sort((a, b) => b.relevance_score - a.relevance_score);
    for (const item of ordered) {
      const cand = byId.get(item.target_page_id);
      let problem = this.validateItem(item, cand, state.validation(cand));
      if (problem === null && outcome.suggestions.length >= maxSuggestions) problem = SkipReason.MAX_SUGGESTIONS_REACHED;
      if (problem !== null) {
        outcome.skipped.push(skipped(cand, problem));
        continue;
      }
      await this.storeSuggestion(outcome, state, item, cand, {
        provider: analyzer.providerName,
        model: analyzer.modelName,
        retrievalScore: cand.score,
      });
    }

    if (!request.dry_run) await this.repo.commit();
    logger.info(
      `Interlink analysis for ${source.url}: ${candidates.length} candidates, ${outcome.suggestions.length} ` +
        `suggestions, ${outcome.skipped.length} skipped (dry_run=${request.dry_run})`,
    );
    return outcome;
  }

  /**
   * Deterministic suggestions: rank every eligible target with the explainable scorer, keep the
   * strongest `candidatePoolSize`, and propose a link only where a phrase naming the target
   * already appears in a source sentence. Same validation, thresholds and storage as the AI path.
   */
  async analyzeDeterministic(run, mode, aiError) {
    const cfg = this.config;
    const { request, source, sourceText, eligible } = run;
    const minScore = Math.max(Math.round(cfg.deterministicMinScore * 100), request.min_relevance_score || 0);
    const profile = sourceProfile(source, sourceText);
    const weight = buildTermWeights(source, eligible);
    const sentences = run.linkContexts.flatMap((block) => splitSentences(block));
    // Two passes: shortlist on topical signals alone (cheap over every eligible page), then
    // re-score the shortlist with the anchor the source can actually offer, so a target with a
    // strong contextual phrase outranks one that merely looks similar.
    const shortlist = eligible
      .map((page) => ({ page, ...scoreTarget(profile, page, weight) }))
      .sort((a, b) => b.score - a.score || pyCompare(a.page.url, b.page.url))
      .slice(0, cfg.candidatePoolSize);
    const ranked = shortlist
      .map(({ page }) => {
        const { placements, anchorQuality } = bestAnchor(page, sentences, profile, weight);
        return { page, placements, ...scoreTarget(profile, page, weight, { anchorQuality }) };
      })
      .sort((a, b) => b.score - a.score || pyCompare(a.page.url, b.page.url));
    const outcome = newOutcome(run, { minScore, retrieved: ranked.length, mode, aiError });
    outcome.candidates = ranked.map((r) => diagnostic(r, null));
    const diagnostics = new Map(outcome.candidates.map((d) => [d.target_page_id, d]));

    const existingAnchors = ranked.length ? await this.repo.anchorsByTarget(ranked.map((r) => r.page.id)) : new Map();
    const state = this.storeState(run, minScore, existingAnchors);
    for (const scored of ranked) {
      const cand = { page: scored.page, score: scored.score };
      if (Math.round(scored.score * 100) < minScore) {
        outcome.skipped.push(skipped(cand, SkipReason.BELOW_THRESHOLD));
        continue;
      }
      if (outcome.suggestions.length >= run.maxSuggestions) {
        outcome.skipped.push(skipped(cand, SkipReason.MAX_SUGGESTIONS_REACHED));
        continue;
      }
      // Anchors were ranked in the scoring pass; drop the ones this run has already used.
      const placements = scored.placements.filter(
        (p) => !state.usedContexts.has(normalizeForMatch(p.context)) && !state.usedAnchors.has(normalizeForMatch(p.anchor)),
      );
      let problem = NO_ANCHOR_IN_SOURCE;
      let item = null;
      let chosen = null;
      for (const placement of placements) {
        // Score the anchor that would actually be stored: when the best anchor's sentence is
        // already taken, the suggestion must carry the weaker anchor's score, not the best one's.
        const withAnchor = scoreTarget(profile, scored.page, weight, { anchorQuality: placement.anchor_quality });
        const candidateItem = deterministicItem(scored.page, placement, withAnchor);
        problem = this.validateItem(candidateItem, cand, state.validation(cand));
        if (problem === null) {
          item = candidateItem;
          chosen = withAnchor;
          break;
        }
      }
      if (item === null) {
        outcome.skipped.push(skipped(cand, problem));
        continue;
      }
      // Report the chosen anchor's score/signals, so diagnostics match the stored suggestion.
      const reported = diagnostics.get(scored.page.id);
      if (reported) Object.assign(reported, { score: chosen.score, signals: chosen.signals });
      await this.storeSuggestion(outcome, state, item, cand, {
        provider: DETERMINISTIC_PROVIDER,
        model: null,
        retrievalScore: chosen.score,
      });
    }

    // Targets are processed in pool order, but a fallback anchor can score lower than the best one
    // it could not use, so present the suggestions strongest-first (URL breaks ties).
    outcome.suggestions.sort((a, b) => b.relevance_score - a.relevance_score || pyCompare(a.target_page_id, b.target_page_id));

    if (!request.dry_run) await this.repo.commit();
    logger.info(
      `Interlink ${mode} analysis for ${source.url}: ${ranked.length} candidates, ${outcome.suggestions.length} ` +
        `suggestions, ${outcome.skipped.length} skipped (dry_run=${request.dry_run})`,
    );
    return outcome;
  }

  /** Per-run bookkeeping shared by the AI and deterministic paths (one anchor/sentence per link). */
  storeState(run, minScore, existingAnchors) {
    const usedContexts = new Set();
    const usedAnchors = new Set();
    return {
      run,
      usedContexts,
      usedAnchors,
      validation: (cand) => ({
        content: run.content,
        sourceUrl: run.source.url,
        linkContexts: run.linkContexts,
        minScore,
        usedContexts,
        usedAnchors,
        existingAnchors: existingAnchors.get(cand.page.id) ?? [],
      }),
    };
  }

  /** Insert one validated item as PENDING (unless dry_run) and record it in the outcome. */
  async storeSuggestion(outcome, state, item, cand, { provider, model, retrievalScore }) {
    const { source, request } = state.run;
    const suggestion = {
      id: randomUUID(),
      site_id: source.site_id,
      source_page_id: source.id,
      target_page_id: cand.page.id,
      anchor_text: item.anchor_text,
      context: item.suggested_context,
      relevance_score: item.relevance_score,
      reason: item.reason,
      status: SuggestionStatus.PENDING,
      retrieval_score: retrievalScore,
      ai_provider: provider,
      ai_model: model,
      rejection_reason: null,
      reviewed_at: null,
      applied_at: null,
      created_at: null,
      updated_at: null,
    };
    if (!request.dry_run && !(await this.repo.addSuggestion(suggestion))) {
      outcome.skipped.push(skipped(cand, SkipReason.ACTIVE_SUGGESTION_EXISTS));
      return;
    }
    state.usedContexts.add(normalizeForMatch(item.suggested_context));
    state.usedAnchors.add(normalizeForMatch(item.anchor_text));
    outcome.suggestions.push(suggestion);
  }

  validateItem(item, cand, { content, sourceUrl, linkContexts, minScore, usedContexts, usedAnchors, existingAnchors }) {
    if (item.relevance_score < minScore) return SkipReason.BELOW_THRESHOLD;
    if (!linkContexts.some((block) => containsPhrase(block, item.suggested_context))) return SkipReason.CONTEXT_NOT_IN_SOURCE;
    const problem = anchorProblem(item.anchor_text, item.suggested_context);
    if (problem !== null) return problem;
    const anchorKey = normalizeForMatch(item.anchor_text);
    if (usedContexts.has(normalizeForMatch(item.suggested_context))) return SkipReason.CONTEXT_ALREADY_USED;
    if (usedAnchors.has(anchorKey)) return SkipReason.DUPLICATE_ANCHOR;
    const reuse = existingAnchors.filter((a) => normalizeForMatch(a) === anchorKey).length;
    if (reuse >= this.config.maxAnchorReuse) return SkipReason.ANCHOR_OVERUSED;
    // Only store suggestions that can actually be applied to the current content.
    try {
      applyLink(content, {
        pageUrl: sourceUrl,
        targetUrl: cand.page.url,
        href: siteRelative(cand.page.url),
        anchorText: item.anchor_text,
        context: item.suggested_context,
      });
    } catch (err) {
      if (err instanceof LinkApplicationError) return err.code;
      throw err;
    }
    return null;
  }

  // ------------------------------------------------------------------ queries
  async listSuggestions(filters, { page, pageSize }) {
    return this.repo.listSuggestions(filters, { offset: (page - 1) * pageSize, limit: pageSize });
  }

  async getSuggestion(suggestionId, { forUpdate = false } = {}) {
    const suggestion = await this.repo.getSuggestion(suggestionId, { forUpdate });
    if (suggestion === null) throw new NotFoundError('Suggestion not found', { code: 'SUGGESTION_NOT_FOUND' });
    return suggestion;
  }

  // ------------------------------------------------------------------ review
  async approve(suggestionId) {
    const suggestion = await this.getSuggestion(suggestionId, { forUpdate: true });
    await this.transition(suggestion, SuggestionStatus.APPROVED);
    suggestion.rejection_reason = null;
    suggestion.reviewed_at = now().toISOString();
    await this.repo.saveSuggestion(suggestion);
    await this.repo.commit();
    return suggestion;
  }

  async reject(suggestionId, reason) {
    const suggestion = await this.getSuggestion(suggestionId, { forUpdate: true });
    await this.transition(suggestion, SuggestionStatus.REJECTED);
    suggestion.rejection_reason = reason;
    suggestion.reviewed_at = now().toISOString();
    await this.repo.saveSuggestion(suggestion);
    await this.repo.commit();
    return suggestion;
  }

  async transition(suggestion, next) {
    if (!TRANSITIONS[next].has(suggestion.status)) {
      await this.repo.rollback();
      throw new ConflictError(`Cannot change suggestion from ${suggestion.status} to ${next}`, {
        code: 'INVALID_STATUS_TRANSITION',
        details: { current_status: suggestion.status, requested_status: next },
      });
    }
    suggestion.status = next;
  }

  // ------------------------------------------------------------------ apply
  async apply(suggestionId) {
    const suggestion = await this.getSuggestion(suggestionId, { forUpdate: true });
    let source;
    let target;
    let applied;
    try {
      if (suggestion.status !== SuggestionStatus.APPROVED) {
        throw new ConflictError('Only APPROVED suggestions can be applied', {
          code: 'SUGGESTION_NOT_APPROVED',
          details: { current_status: suggestion.status },
        });
      }
      source = await this.repo.getPage(suggestion.source_page_id, { forUpdate: true });
      if (source === null) throw new ConflictError('Source page no longer exists', { code: 'SOURCE_PAGE_MISSING' });
      target = await this.repo.getPage(suggestion.target_page_id);
      if (target === null) throw new ConflictError('Target page no longer exists', { code: 'TARGET_PAGE_MISSING' });
      const content = this.contentStore.loadContent(source);
      if (!content) throw new LinkApplicationError('Source page has no content', { code: 'SOURCE_CONTENT_EMPTY' });
      const linked = linkedUrlKeys(internalLinksFor(source.url, content));
      const reason = targetExclusionReason(source, target, this.config.filters, linked);
      if (reason === ExclusionReason.ALREADY_LINKED) {
        throw new ConflictError('Source page already links to the target', { code: 'ALREADY_LINKED' });
      }
      if (reason !== null) {
        throw new ConflictError('Target page is no longer a valid link target', {
          code: 'TARGET_NOT_LINKABLE',
          details: { reason },
        });
      }
      applied = applyLink(content, {
        pageUrl: source.url,
        targetUrl: target.url,
        href: siteRelative(target.url),
        anchorText: suggestion.anchor_text,
        context: suggestion.context,
      });
      await this.contentStore.saveContent(source, applied.content, { expectedVersion: source.content_version });
      suggestion.status = SuggestionStatus.APPLIED;
      suggestion.applied_at = now().toISOString();
      await this.repo.saveSuggestion(suggestion);
      await this.repo.commit();
    } catch (err) {
      await this.repo.rollback();
      throw err;
    }
    logger.info(`Applied internal link ${suggestion.id}: ${source.url} -> ${target.url} (${JSON.stringify(applied.anchorText)})`);
    return suggestion;
  }
}
