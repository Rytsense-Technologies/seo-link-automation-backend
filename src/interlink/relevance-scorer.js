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

/**
 * Signal weights; they must sum to exactly 1.0 (asserted by the tests).
 *
 * The ordering encodes the principle "actual contextual relationship > raw URL similarity":
 * what the source text really says about the target (content_title, phrase_overlap) and how
 * useful the anchor would be (anchor_quality) outweigh slug similarity, which is easy to match
 * by accident — a target whose slug echoes the source topic must not rank highly without a
 * meaningful phrase to link from. `quality` and `region_language` are context-free and gated
 * (see scoreTarget), so they cannot lift an unrelated page on their own.
 */
export const SIGNAL_WEIGHTS = Object.freeze({
  content_title: 0.18,
  phrase_overlap: 0.16,
  anchor_quality: 0.16,
  content_h1: 0.12,
  keyword_overlap: 0.1,
  title_overlap: 0.07,
  slug_similarity: 0.06,
  quality: 0.06,
  h1_overlap: 0.05,
  region_language: 0.04,
});

/** Signals that say nothing about the source/target relationship, so they are gated. */
const CONTEXT_FREE_SIGNALS = ['quality', 'region_language'];

/**
 * anchor_quality sub-weights (sum 1.0): how much of the target's identity the phrase conveys,
 * how specific it is, and how established it is in the source copy. Identity leads, because
 * naming the target is what separates a useful anchor from a merely rare word: "assistants" is
 * an unusual word but only a fragment of "Smart Digital Assistants", while "chatbot development"
 * names its page outright.
 */
export const ANCHOR_IDENTITY_WEIGHT = 0.5;
export const ANCHOR_SPECIFICITY_WEIGHT = 0.3;
export const ANCHOR_SUPPORT_WEIGHT = 0.2;
// Term weight an anchor needs before it counts as fully specific (~one distinctive word plus a
// modifier). Generic words contribute GENERIC_WEIGHT each, so a generic phrase cannot reach it.
export const ANCHOR_EVIDENCE = 1.2;
/**
 * Mentions beyond this add nothing to `support`. A shorter phrase always occurs at least as often
 * as the longer one containing it ("AI chatbot" vs "AI chatbot development"), so an uncapped
 * mention count would quietly favour vaguer anchors; the cap only asks that the phrase is
 * genuinely established in the copy.
 */
export const ANCHOR_SUPPORT_SATURATION = 2;
/**
 * Floor applied to non-generic terms when judging an anchor. Ranking targets uses plain IDF, so a
 * word most pages share carries little weight. Anchor quality asks a different question - does
 * this phrase name the target and avoid boilerplate? - and there the site's core vocabulary is
 * exactly what good anchors are made of ("chatbot" on a chatbot site), so it must not be treated
 * as noise. Generic business words stay damped.
 */
export const ANCHOR_TOPICAL_FLOOR = 0.5;
/**
 * Applied when the anchor appears in neither the target's title nor its URL slug. A page is known
 * by those two; matching only a slogan H1 ("Transform Your Business") does not make "transform" a
 * useful anchor for it.
 */
export const ANCHOR_OFF_TITLE_PENALTY = 0.5;

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
  const isGeneric = (term) => term.split(' ').every((t) => GENERIC_TERMS.has(t));
  const idfNorm = (term) => (idfValues.get(term) ?? maxIdf) / maxIdf;
  const weight = (term) => (isGeneric(term) ? GENERIC_WEIGHT * idfNorm(term) : idfNorm(term));
  // Companion weighting for anchor quality (see ANCHOR_TOPICAL_FLOOR).
  weight.anchor = (term) => (isGeneric(term) ? GENERIC_WEIGHT : Math.max(idfNorm(term), ANCHOR_TOPICAL_FLOOR));
  return weight;
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

/** How often the anchor phrase itself occurs in the source body copy. */
export function sourceMentions(profile, anchor) {
  const tokens = tokenize(anchor);
  if (!tokens.length) return 0;
  if (tokens.length === 1) return profile.contentTokens.get(tokens[0]) ?? 0;
  if (tokens.length <= 3) return profile.contentPhrases.get(tokens.join(' ')) ?? 0;
  // Longer anchors: they occur at most as often as their rarest 3-word window.
  let fewest = Infinity;
  for (let i = 0; i + 3 <= tokens.length; i += 1) {
    fewest = Math.min(fewest, profile.contentPhrases.get(tokens.slice(i, i + 3).join(' ')) ?? 0);
  }
  return fewest === Infinity ? 0 : fewest;
}

/**
 * How useful an anchor is for an internal link, 0-1. Deliberately not a word count: a single
 * word can be strong when it is specific and names the target ("chatbots"), while a phrase full
 * of generic business words stays weak ("software development services"). Three parts:
 *
 * - specificity: the anchor's own term weight (IDF-based, generic vocabulary damped to ~5%), so
 *   "booking" or "software" alone scores low while "AI appointment booking" reaches full credit.
 * - identity:    how much of the target's title/H1/keywords the anchor actually conveys, which is
 *   what separates "assistants" from "smart digital assistants" for the same page.
 * - support:     how established the phrase already is in the source copy (a single passing
 *   mention is weaker evidence than a recurring one).
 */
export function anchorQualitySignal(anchor, target, profile, weight = flatWeight) {
  const anchorTokens = tokenSet(anchor);
  if (!anchorTokens.size) return 0;
  const w = weight.anchor ?? weight;
  const specificity = Math.min(1, weightSum(anchorTokens, w) / ANCHOR_EVIDENCE);
  // How much of the target's identity the anchor carries, judged against its best-matching field:
  // naming the H1 in full ("chatbot development") is as good as naming the title in full, and
  // better than covering a fragment of a long title ("assistants").
  const fields = [tokenSet(target.title), tokenSet(target.h1), ...(target.keywords ?? []).map((k) => tokenSet(k))].filter((f) => f.size);
  let identityCoverage = fields.length ? Math.max(...fields.map((field) => coverage(field, anchorTokens, w))) : specificity;
  const named = new Set([...tokenSet(target.title), ...tokenSet(slugText(target))]);
  if (named.size && ![...anchorTokens].some((t) => named.has(t))) identityCoverage *= ANCHOR_OFF_TITLE_PENALTY;
  const support = mentionCredit(Math.min(sourceMentions(profile, anchor), ANCHOR_SUPPORT_SATURATION));
  return round4(
    ANCHOR_SPECIFICITY_WEIGHT * specificity + ANCHOR_IDENTITY_WEIGHT * identityCoverage + ANCHOR_SUPPORT_WEIGHT * support,
  );
}

/**
 * Score one target. `weight` comes from buildTermWeights (defaults to the generic-damped flat
 * weight). `anchorQuality` is 0 while no anchor has been chosen yet (the shortlist pass, and AI
 * mode when the source has no usable phrase for the target).
 * @returns {{ score: number, signals: Record<string, number> }}
 */
export function scoreTarget(profile, target, weight = flatWeight, { anchorQuality = 0 } = {}) {
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
    anchor_quality: anchorQuality,
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
    .filter(([name]) => !CONTEXT_FREE_SIGNALS.includes(name))
    .reduce((sum, [name, w]) => sum + w * signals[name], 0);
  const topicalMax = 1 - CONTEXT_FREE_SIGNALS.reduce((sum, name) => sum + SIGNAL_WEIGHTS[name], 0);
  const gate = Math.min(1, topical / (0.25 * topicalMax));
  const contextFree = CONTEXT_FREE_SIGNALS.reduce((sum, name) => sum + SIGNAL_WEIGHTS[name] * signals[name], 0);
  const score = topical + gate * contextFree;
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
    .filter(([name, v]) => v > 0 && !CONTEXT_FREE_SIGNALS.includes(name))
    .sort((a, b) => b[1] - a[1] || pyCompare(a[0], b[0]))
    .slice(0, n);
}
