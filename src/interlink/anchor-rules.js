/** Anchor-text and context validation applied to every AI suggestion before it is stored (app/interlink/anchor_rules.py). */

import { PY_WORD_CHARS, casefold, collapseWhitespace, pyLen } from '../utils/pytext.js';
import { tokenize } from './text-features.js';

export const GENERIC_ANCHORS = new Set([
  'click here', 'click', 'here', 'read more', 'learn more', 'more', 'this', 'this page',
  'this article', 'this post', 'this link', 'link', 'website', 'page', 'article',
  'find out more', 'see more', 'details', 'more info', 'more information', 'go',
  'continue', 'check it out', 'view', 'visit', 'our website',
]);

export const MAX_ANCHOR_WORDS = 8;
export const MAX_ANCHOR_CHARS = 100;
const W = PY_WORD_CHARS; // Python [^\W_]
const WORD_RE = new RegExp(`[${W}]+`, 'gu');

// Single-char -> single-char so normalised offsets can be mapped back to the source text.
export const QUOTE_MAP = new Map([
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
]);

export function translateQuotes(value) {
  return value.replace(/[‘’“”]/g, (ch) => QUOTE_MAP.get(ch));
}

/** Case/whitespace/quote-insensitive form used to compare AI text with page text. */
export function normalizeForMatch(value) {
  return casefold(collapseWhitespace(translateQuotes(value)));
}

/** JS regex source for a literal (Python `re.escape` for use under the `u` flag). */
export function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Python `str.strip(chars)`. */
function stripChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Rejection code if the anchor is unusable, else null. */
export function anchorProblem(anchor, context) {
  const words = casefold(anchor).match(WORD_RE) ?? [];
  if (!words.length) return 'ANCHOR_EMPTY';
  if (GENERIC_ANCHORS.has(stripChars(normalizeForMatch(anchor), ' .,:;!?"\''))) return 'ANCHOR_GENERIC';
  if (!tokenize(anchor).length) {
    // Only stopwords/numbers ("while a", "of the"): says nothing about the destination.
    return 'ANCHOR_NOT_DESCRIPTIVE';
  }
  if (words.length > MAX_ANCHOR_WORDS || pyLen(anchor) > MAX_ANCHOR_CHARS) return 'ANCHOR_TOO_LONG';
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  if (words.length >= 3 && Math.max(...counts.values()) > 1) return 'ANCHOR_KEYWORD_STUFFING';
  if (!containsPhrase(context, anchor)) return 'ANCHOR_NOT_IN_CONTEXT';
  return null;
}

/** `(?<![^\W_])literal(?![^\W_])` */
export function wholeWordRegExp(literal, flags = 'u') {
  return new RegExp(`(?<![${W}])${escapeRegExp(literal)}(?![${W}])`, flags);
}

/** Whole-word, normalised containment. */
export function containsPhrase(haystack, needle) {
  const h = normalizeForMatch(haystack);
  const n = normalizeForMatch(needle);
  if (!n) return false;
  return wholeWordRegExp(n).test(h);
}
