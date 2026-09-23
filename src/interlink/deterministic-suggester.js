/**
 * Deterministic anchor/context generation: used when AI is disabled (`use_ai: false`) or, when
 * explicitly allowed (`ai_fallback: true`), when the AI provider is unavailable or fails.
 *
 * An anchor is only proposed when a phrase naming the target (from its title, H1 or keywords)
 * already appears, as whole words, in a linkable sentence of the source page. The sentence is
 * copied verbatim and the anchor is the exact source text, so every suggestion could later be
 * applied without rewriting any copy. Nothing is invented; no page is modified.
 */

import { PY_WORD_CHARS, pyCompare } from '../utils/pytext.js';
import { escapeRegExp, normalizeForMatch } from './anchor-rules.js';
import { tokenize } from './text-features.js';
import { GENERIC_TERMS, anchorQualitySignal, topSignals } from './relevance-scorer.js';

export const DETERMINISTIC_PROVIDER = 'deterministic';
export const NO_ANCHOR_IN_SOURCE = 'NO_ANCHOR_IN_SOURCE';

export const MAX_ANCHOR_WORDS = 6;
export const MIN_SENTENCE_WORDS = 5;
export const MAX_SENTENCE_CHARS = 400;
// A phrase must carry this much site-specific term weight to name the target (brand names and
// generic vocabulary that appear on every page do not).
export const MIN_ANCHOR_WEIGHT = 0.6;
// ...and contain at least one clearly specific word (normalised IDF weight).
export const MIN_SPECIFIC_TOKEN_WEIGHT = 0.45;

const W = PY_WORD_CHARS;
const WORD_SPAN_RE = new RegExp(`[${W}]+(?:['’-][${W}]+)*`, 'gu');
// Title separators such as "AI Chatbots | Brand" or "Pricing - Brand".
const SEGMENT_SPLIT_RE = /\s+[|–—:·•-]\s+|\s*\|\s*/u;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=["“'‘(]?[\p{Lu}\p{N}])/u;

/** Split a block of body copy into sentences. */
export function splitSentences(block) {
  return block
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length <= MAX_SENTENCE_CHARS && (s.match(WORD_SPAN_RE) ?? []).length >= MIN_SENTENCE_WORDS);
}

/** Candidate anchor phrases naming the target, most specific first. */
export function anchorPhrases(target, weight) {
  const fields = [
    ['title', target.title],
    ['h1', target.h1],
    ...(target.keywords ?? []).map((k) => ['keyword', k]),
  ];
  const seen = new Map();
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const segment of text.split(SEGMENT_SPLIT_RE)) {
      const spans = [...segment.matchAll(WORD_SPAN_RE)].map((m) => [m.index, m.index + m[0].length]);
      for (let i = 0; i < spans.length; i += 1) {
        for (let n = Math.min(MAX_ANCHOR_WORDS, spans.length - i); n >= 1; n -= 1) {
          const phrase = segment.slice(spans[i][0], spans[i + n - 1][1]);
          const key = normalizeForMatch(phrase);
          if (seen.has(key)) continue;
          const info = phraseInfo(phrase, n, weight);
          if (info !== null) seen.set(key, { phrase, field, words: n, ...info });
        }
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) => b.words - a.words || b.weight - a.weight || pyCompare(normalizeForMatch(a.phrase), normalizeForMatch(b.phrase)),
  );
}

function phraseInfo(phrase, words, weight) {
  const edges = phrase.match(WORD_SPAN_RE);
  // No dangling stopwords ("of AI agents", "voice agents for").
  if (!tokenize(edges[0]).length || !tokenize(edges[edges.length - 1]).length) return null;
  const tokens = tokenize(phrase);
  const specific = tokens.filter((t) => !GENERIC_TERMS.has(t));
  if (!specific.length) return null;
  const total = tokens.reduce((sum, t) => sum + weight(t), 0);
  const best = Math.max(...specific.map((t) => weight(t)));
  if (total < MIN_ANCHOR_WEIGHT || best < MIN_SPECIFIC_TOKEN_WEIGHT) return null;
  // Single words must be clearly specific (e.g. "chatbots", not "AI" or "services").
  if (words === 1 && (best < 0.75 || tokens[0].length < 4)) return null;
  return { weight: total };
}

function phraseRegExp(phrase) {
  const body = phrase.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![${W}])${body}(?![${W}])`, 'iu');
}

/**
 * Where the target could be linked from: [{ anchor, context, field }], best first. `anchor` is
 * the exact text as written in the source sentence (`context`).
 */
export function findPlacements(target, sentences, weight, { usedContexts = new Set(), usedAnchors = new Set(), limit = 5 } = {}) {
  const placements = [];
  const offered = new Set();
  for (const candidate of anchorPhrases(target, weight)) {
    const re = phraseRegExp(candidate.phrase);
    const matches = [];
    for (const sentence of sentences) {
      if (usedContexts.has(normalizeForMatch(sentence))) continue;
      const match = sentence.match(re);
      if (match && !usedAnchors.has(normalizeForMatch(match[0]))) matches.push({ anchor: match[0], context: sentence });
    }
    if (!matches.length) continue;
    // One placement per phrase, preferring a sentence not offered yet (more distinct alternatives).
    const pick = matches.find((m) => !offered.has(m.context)) ?? matches[0];
    offered.add(pick.context);
    placements.push({ ...pick, field: candidate.field });
    if (placements.length >= limit) break;
  }
  return placements;
}

/**
 * Placements ordered by how good the anchor is (see anchorQualitySignal), best first. Ties keep
 * the discovery order, so the choice is deterministic. Each entry carries its `anchor_quality`,
 * which also feeds the target's relevance score.
 */
export function rankPlacements(placements, target, profile, weight) {
  return placements
    .map((placement, index) => ({ ...placement, index, anchor_quality: anchorQualitySignal(placement.anchor, target, profile, weight) }))
    .sort((a, b) => b.anchor_quality - a.anchor_quality || a.index - b.index);
}

const FIELD_LABEL = { title: 'title', h1: 'H1', keyword: 'keywords' };

/** Short factual reason built from the matched field and the strongest signals. */
export function deterministicReason(placement, signals) {
  const top = topSignals(signals)
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(', ');
  return (
    `The source sentence already mentions "${placement.anchor}", which matches the target page's ` +
    `${FIELD_LABEL[placement.field]}. Strongest deterministic signals: ${top || 'none'}.`
  );
}

/** A suggestion item in the same shape the AI layer produces (validated by the service). */
export function deterministicItem(target, placement, scored) {
  return {
    target_page_id: String(target.id),
    target_url: target.url,
    is_relevant: true,
    relevance_score: Math.round(scored.score * 100),
    reason: deterministicReason(placement, scored.signals),
    anchor_text: placement.anchor,
    suggested_context: placement.context,
  };
}
