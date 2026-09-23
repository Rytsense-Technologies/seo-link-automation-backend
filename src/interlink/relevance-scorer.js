/**
 * Deterministic, explainable relevance scoring between a source page and an eligible target.
 *
 * Every signal is in [0, 1]. Terms are weighted by site-level IDF (terms most pages share carry
 * little weight) and generic business vocabulary ("software", "development", "company", ...) is
 * damped further, so two pages never look related just because they share boilerplate words.
 * Pure functions only: the same input always gives the same score.
 */

import { urlPath } from '../utils/urls.js';
import { pyCompare } from '../utils/pytext.js';
import { idf, tokenize } from './text-features.js';

// Stemmed forms (see text-features `stem`): common business words that describe almost every page.
const GENERIC_TERMS_TEXT = `
development develop developer software solution company service technology tech business custom
digital enterprise agency provider expert professional product system platform application app
online team client customer work process industry leading trusted affordable cost price
quality support offer help learn get build create make need way year
`;
export const GENERIC_TERMS = new Set(GENERIC_TERMS_TEXT.split(/\s+/).filter(Boolean));
export const GENERIC_WEIGHT = 0.05;

// A match must add up to this much term weight before it counts as full evidence, so a target
// whose title is only generic words cannot reach full coverage by matching those words.
export const MIN_EVIDENCE = 1.0;

export const SIGNAL_WEIGHTS = Object.freeze({
  content_title: 0.22,
  phrase_overlap: 0.18,
  content_h1: 0.14,
  keyword_overlap: 0.12,
  slug_similarity: 0.1,
  title_overlap: 0.08,
  h1_overlap: 0.06,
  quality: 0.06,
  region_language: 0.04,
});

const round4 = (x) => Number(x.toFixed(4));

const slugText = (page) => urlPath(page.url).replace(/[/_-]+/g, ' ');

/** Unique tokens of a text (stopwords removed, light stemming). */
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/** Adjacent-token phrases (2-3 tokens) of a text. */
export function phraseSet(text) {
  return new Set(phraseCounts(text).keys());
}

function phraseCounts(text) {
  const tokens = tokenize(text);
  const out = new Map();
  for (let n = 2; n <= 3; n += 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const p = tokens.slice(i, i + n).join(' ');
      out.set(p, (out.get(p) ?? 0) + 1);
    }
  }
  return out;
}

function tokenCounts(text) {
  const out = new Map();
  for (const t of tokenize(text)) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

// What the source is about is stated in its title/H1/keywords: those words count as recurring.
const PROMINENT_MENTIONS = 3;

const pageFields = (page) => [page.title, page.h1, (page.keywords ?? []).join(' ; '), slugText(page)];

/**
 * Site-level term weights from the eligible pages (+ the source). Returns a weight function
 * mapping a term to (0, 1]: normalised IDF, times GENERIC_WEIGHT for generic vocabulary.
 */
export function buildTermWeights(source, pages) {
  const docs = [source, ...pages].map((p) => new Map([...tokenSet(pageFields(p).join(' '))].map((t) => [t, 1])));
  const idfValues = idf(docs);
  const maxIdf = idfValues.size ? Math.max(...idfValues.values()) : 1.0;
  return (term) => {
    const generic = term.split(' ').every((t) => GENERIC_TERMS.has(t));
    const idfNorm = (idfValues.get(term) ?? maxIdf) / maxIdf;
    return generic ? GENERIC_WEIGHT * idfNorm : idfNorm;
  };
}

const flatWeight = (term) => (term.split(' ').every((t) => GENERIC_TERMS.has(t)) ? GENERIC_WEIGHT : 1.0);

function weightSum(terms, weight) {
  let total = 0;
  for (const t of [...terms].sort()) total += weight(t);
  return total;
}

/**
 * Credit for a term found `count` times in the source: one passing mention in a long page is weak
 * evidence (~0.39), a recurring topic is strong (5 mentions ~0.92).
 */
export function mentionCredit(count) {
  return count > 0 ? 1 - Math.exp(-count / 2) : 0;
}

/**
 * Weighted share of `needles` found in `haystack`, requiring MIN_EVIDENCE for full credit.
 * `haystack` is a Set (presence = full credit) or a Map of term -> mention count.
 */
export function coverage(needles, haystack, weight = flatWeight) {
  if (!needles.size) return 0;
  const credit = (t) => (haystack instanceof Map ? mentionCredit(haystack.get(t) ?? 0) : haystack.has(t) ? 1 : 0);
  let matched = 0;
  for (const t of [...needles].sort()) matched += weight(t) * credit(t);
  if (matched === 0) return 0;
  return Math.min(1, matched / Math.max(weightSum(needles, weight), MIN_EVIDENCE));
}

/** Weighted Jaccard similarity, also requiring MIN_EVIDENCE of shared weight for full credit. */
export function overlap(a, b, weight = flatWeight) {
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((t) => b.has(t));
  if (!shared.length) return 0;
  const union = new Set([...a, ...b]);
  const jaccard = weightSum(shared, weight) / weightSum(union, weight);
  return Math.min(1, jaccard * Math.min(1, weightSum(shared, weight) / MIN_EVIDENCE));
}

const normLang = (v) => (v ? v.split(/[-_]/)[0].toLowerCase() : null);

/** 1 when language and region agree, 0.5 when either side is unknown (mismatches are filtered earlier). */
export function regionLanguageSignal(source, target) {
  const langs = [normLang(source.language), normLang(target.language)];
  const regions = [source.region?.toLowerCase() ?? null, target.region?.toLowerCase() ?? null];
  let value = 1;
  if (langs.includes(null)) value -= 0.25;
  else if (langs[0] !== langs[1]) value -= 0.5;
  if (regions[0] && regions[1] && regions[0] !== regions[1]) value -= 0.5;
  return Math.max(0, value);
}

/** How well-described the target is (only indexable 200 pages reach scoring at all). */
export function qualitySignal(target) {
  let value = 0;
  if (target.title?.trim()) value += 0.35;
  if (target.h1?.trim()) value += 0.3;
  if (target.meta_description?.trim()) value += 0.2;
  if ((target.keywords ?? []).length) value += 0.15;
  return round4(value);
}

/**
 * Precomputed source features; `sourceText` is the linkable body copy of the source page.
 * `contentTokens` / `contentPhrases` map each term to its number of mentions.
 * @returns {{ titleTokens, h1Tokens, contentTokens, contentPhrases, page }}
 */
export function sourceProfile(source, sourceText) {
  const contentTokens = tokenCounts(sourceText);
  for (const t of tokenSet([source.title, source.h1, (source.keywords ?? []).join(' ; ')].join(' \n '))) {
    contentTokens.set(t, Math.max(contentTokens.get(t) ?? 0, PROMINENT_MENTIONS));
  }
  return {
    page: source,
    titleTokens: tokenSet(source.title),
    h1Tokens: tokenSet(source.h1),
    contentTokens,
    contentPhrases: phraseCounts(sourceText),
  };
}

/**
 * Score one target. `weight` comes from buildTermWeights (defaults to the generic-damped flat weight).
 * @returns {{ score: number, signals: Record<string, number> }}
 */
export function scoreTarget(profile, target, weight = flatWeight) {
  const titleTokens = tokenSet(target.title);
  const h1Tokens = tokenSet(target.h1);
  const keywordTokens = tokenSet((target.keywords ?? []).join(' ; '));
  const slugTokens = tokenSet(slugText(target));
  const targetPhrases = new Set([
    ...phraseSet(target.title),
    ...phraseSet(target.h1),
    ...(target.keywords ?? []).flatMap((k) => [...phraseSet(k)]),
  ]);
  const signals = {
    title_overlap: overlap(profile.titleTokens, titleTokens, weight),
    h1_overlap: overlap(profile.h1Tokens, h1Tokens, weight),
    content_title: coverage(titleTokens, profile.contentTokens, weight),
    content_h1: coverage(h1Tokens, profile.contentTokens, weight),
    keyword_overlap: coverage(keywordTokens, profile.contentTokens, weight),
    phrase_overlap: coverage(targetPhrases, profile.contentPhrases, weight),
    slug_similarity: coverage(slugTokens, profile.contentTokens, weight),
    region_language: regionLanguageSignal(profile.page, target),
    quality: qualitySignal(target),
  };
  // Context-free signals (quality, region/language) only count once the target shares real
  // vocabulary with the source; otherwise every well-described page would get a free floor.
  const topical = Object.entries(SIGNAL_WEIGHTS)
    .filter(([name]) => name !== 'quality' && name !== 'region_language')
    .reduce((sum, [name, w]) => sum + w * signals[name], 0);
  const topicalMax = 1 - SIGNAL_WEIGHTS.quality - SIGNAL_WEIGHTS.region_language;
  const gate = Math.min(1, topical / (0.25 * topicalMax));
  const score = topical + gate * (SIGNAL_WEIGHTS.quality * signals.quality + SIGNAL_WEIGHTS.region_language * signals.region_language);
  for (const k of Object.keys(signals)) signals[k] = round4(signals[k]);
  return { score: round4(Math.min(1, score)), signals };
}

/** Score and rank all targets (score desc, then URL), deterministic for equal scores. */
export function rankTargets(source, sourceText, targets) {
  const profile = sourceProfile(source, sourceText);
  const weight = buildTermWeights(source, targets);
  const scored = targets.map((page) => ({ page, ...scoreTarget(profile, page, weight) }));
  scored.sort((a, b) => b.score - a.score || pyCompare(a.page.url, b.page.url));
  return scored;
}

/** The strongest signals, for human-readable reasons. */
export function topSignals(signals, n = 3) {
  return Object.entries(signals)
    .filter(([name, v]) => v > 0 && name !== 'quality' && name !== 'region_language')
    .sort((a, b) => b[1] - a[1] || pyCompare(a[0], b[0]))
    .slice(0, n);
}
