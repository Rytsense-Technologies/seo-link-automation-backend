/**
 * Deterministic hard filters applied before any AI scoring (app/interlink/candidate_filter.py).
 * These decide whether a page may be linked *at all*; the AI only ranks pages that passed them.
 */

import { extractText } from '../content/html.js';
import { normalizeUrl, sameHost, urlKey, urlPath } from '../utils/urls.js';
import { pyLower, pyStrip } from '../utils/pytext.js';

export const ExclusionReason = Object.freeze({
  SOURCE_PAGE: 'SOURCE_PAGE',
  DIFFERENT_SITE: 'DIFFERENT_SITE',
  NOT_FOUND: 'HTTP_404',
  SERVER_ERROR: 'HTTP_5XX',
  BAD_STATUS: 'NON_200_STATUS',
  REDIRECTED: 'REDIRECTED',
  NOINDEX: 'NOINDEX',
  NOT_INDEXABLE: 'NOT_INDEXABLE',
  CANONICAL_MISMATCH: 'CANONICAL_POINTS_ELSEWHERE',
  DUPLICATE_URL: 'DUPLICATE_URL',
  LANGUAGE_MISMATCH: 'LANGUAGE_MISMATCH',
  REGION_MISMATCH: 'REGION_MISMATCH',
  UTILITY_PAGE: 'UTILITY_PAGE',
  ALREADY_LINKED: 'ALREADY_LINKED',
  UNLINKABLE_URL: 'UNLINKABLE_URL',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
});

export function filterConfig({ utilityPageTypes = [], utilityPathPatterns = [], requireRegionMatch = true } = {}) {
  return {
    utilityPageTypes: new Set(utilityPageTypes.map((t) => pyLower(t))),
    // Python `re.compile(p, re.IGNORECASE)`; compiled without the `u` flag so Python-style
    // escapes in configured patterns stay valid.
    utilityPathPatterns: utilityPathPatterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i'))),
    requireRegionMatch,
  };
}

// "en-US" and "en" are the same language for linking purposes.
const normLang = (value) => (value ? pyLower(value.split('-')[0].split('_')[0]) : null);
const normRegion = (value) => (value ? pyLower(value) : null);

export function linkedUrlKeys(urls) {
  return new Set([...urls].map((u) => urlKey(u)));
}

/**
 * Why `target` must not be linked from `source`, or null if it is eligible. `linkedKeys` are
 * url keys the source already links to (defaults to the stored `source.outgoing_links`). Also
 * used at apply time to re-validate the target.
 */
export function targetExclusionReason(source, target, config, linkedKeys = null) {
  if (target.id === source.id || urlKey(target.url) === urlKey(source.url)) return ExclusionReason.SOURCE_PAGE;
  if (target.site_id !== source.site_id || !sameHost(target.url, source.url)) return ExclusionReason.DIFFERENT_SITE;
  const status = target.http_status;
  if (status === 404 || status === 410) return ExclusionReason.NOT_FOUND;
  if (status !== null && status !== undefined && status >= 500) return ExclusionReason.SERVER_ERROR;
  if (target.redirect_url || (status !== null && status !== undefined && status >= 300 && status < 400)) {
    return ExclusionReason.REDIRECTED;
  }
  if (status === null || status === undefined || !(status >= 200 && status < 300)) return ExclusionReason.BAD_STATUS;
  if (target.has_noindex) return ExclusionReason.NOINDEX;
  if (!target.is_indexable) return ExclusionReason.NOT_INDEXABLE;
  if (target.canonical_url) {
    const canonical = normalizeUrl(target.canonical_url, target.url);
    if (canonical === null || urlKey(canonical) !== urlKey(target.url)) return ExclusionReason.CANONICAL_MISMATCH;
  }
  if (normalizeUrl(target.url) === null) return ExclusionReason.UNLINKABLE_URL;
  const srcLang = normLang(source.language);
  const tgtLang = normLang(target.language);
  if (srcLang && tgtLang && srcLang !== tgtLang) return ExclusionReason.LANGUAGE_MISMATCH;
  if (config.requireRegionMatch) {
    const srcRegion = normRegion(source.region);
    const tgtRegion = normRegion(target.region);
    // A target without a region is treated as global and may be linked from any region.
    if (srcRegion && tgtRegion && srcRegion !== tgtRegion) return ExclusionReason.REGION_MISMATCH;
  }
  if (isUtilityPage(target, config)) return ExclusionReason.UTILITY_PAGE;
  if (!hasUsableContent(target)) return ExclusionReason.EMPTY_CONTENT;
  const keys = linkedKeys ?? linkedUrlKeys(source.outgoing_links ?? []);
  if (keys.has(urlKey(target.url))) return ExclusionReason.ALREADY_LINKED;
  return null;
}

/**
 * False for pages with no title, no H1 and no visible body text (e.g. empty 200 shells). The
 * candidate-pool query only loads `content_html` for pages that have neither title nor H1.
 */
export function hasUsableContent(page) {
  if (pyStrip(page.title ?? '') || pyStrip(page.h1 ?? '')) return true;
  return Boolean(page.content_html && pyStrip(extractText(page.content_html)));
}

export function isUtilityPage(page, config) {
  if (page.page_type && config.utilityPageTypes.has(pyLower(page.page_type))) return true;
  const path = urlPath(page.url);
  return config.utilityPathPatterns.some((p) => {
    p.lastIndex = 0;
    return p.test(path);
  });
}

export function filterCandidates(source, pages, config, linkedKeys = null) {
  const result = { accepted: [], excluded: new Map() };
  const seen = new Set();
  const keys = linkedKeys ?? linkedUrlKeys(source.outgoing_links ?? []);
  for (const page of pages) {
    const reason = targetExclusionReason(source, page, config, keys);
    if (reason !== null) {
      if (!result.excluded.has(reason)) result.excluded.set(reason, []);
      result.excluded.get(reason).push(page);
      continue;
    }
    const key = urlKey(page.url);
    if (seen.has(key)) {
      if (!result.excluded.has(ExclusionReason.DUPLICATE_URL)) result.excluded.set(ExclusionReason.DUPLICATE_URL, []);
      result.excluded.get(ExclusionReason.DUPLICATE_URL).push(page);
      continue;
    }
    seen.add(key);
    result.accepted.push(page);
  }
  return result;
}
