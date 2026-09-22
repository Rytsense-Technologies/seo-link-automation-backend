/**
 * Detection of redirects that live inside an HTTP 200 HTML document (app/crawler/html_redirects.py).
 *
 * - Next.js static export: `redirect()` cannot send a real 3xx, so the exported HTML is an error
 *   shell (`<html id="__next_error__">`) whose RSC/flight payload carries a digest such as
 *   `NEXT_REDIRECT;replace;/us/page/;307;` and the browser redirects with JavaScript.
 * - `<meta http-equiv="refresh" content="0;url=/target/">`.
 *
 * This module only *reports* the raw target. It never follows anything: callers must pass the
 * target through `normalizeCrawlUrl`, the site scope, robots and SSRF validation before use.
 */

import { PY_SPACE_CHARS, pyLower, pyStrip } from '../utils/pytext.js';
import { attrValue, loadHtml } from './dom.js';

export const NEXT_REDIRECT = 'next_redirect';
export const META_REFRESH = 'meta_refresh';

const S = PY_SPACE_CHARS;
// `digest":"NEXT_REDIRECT;<type>;<url>;<status|permanent>;` as it appears in the flight data,
// where quotes are usually JSON-escaped (\"). Requiring the `digest` key avoids matching the
// words NEXT_REDIRECT in ordinary article text.
const NEXT_REDIRECT_RE = new RegExp(
  `digest\\\\{0,3}["'][${S}]*:[${S}]*\\\\{0,3}["']` +
    `NEXT_REDIRECT;(?<mode>push|replace);(?<target>[^;"'<>${S}]{1,2048}?);` +
    '(?<code>\\d{3}|true|false)\\b',
  'u',
);
const META_REFRESH_CONTENT_RE = new RegExp(
  `^[${S}]*(?<delay>\\d+(?:\\.\\d*)?)?[${S}]*[;,]?[${S}]*(?:url[${S}]*=[${S}]*)?(?<q>['"]?)(?<target>.*?)\\k<q>[${S}]*$`,
  'isu',
);
const UNSAFE_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'];

export class HtmlRedirect {
  constructor({ target, type, statusCode = null, mode = null, delaySeconds = null }) {
    this.target = target; // raw target as written in the page (relative or absolute)
    this.type = type; // NEXT_REDIRECT | META_REFRESH
    this.statusCode = statusCode;
    this.mode = mode; // Next.js: push | replace
    this.delaySeconds = delaySeconds; // meta refresh delay
  }

  get detected() {
    return true;
  }

  get hasUnsafeScheme() {
    const t = pyLower(pyStrip(this.target));
    return UNSAFE_SCHEMES.some((s) => t.startsWith(s));
  }
}

/** Undo JSON string escaping used in the flight payload (\/ , & ...). */
function unescape(value) {
  try {
    const decoded = JSON.parse(`"${value}"`);
    return typeof decoded === 'string' ? decoded : value;
  } catch {
    return value.replaceAll('\\/', '/');
  }
}

export function detectNextRedirect(html) {
  if (!html.includes('NEXT_REDIRECT')) return null;
  const match = NEXT_REDIRECT_RE.exec(html);
  if (match === null) return null;
  const { code, mode } = match.groups;
  let status;
  if (code === 'true') status = 308; // Next.js 13: `permanent` flag instead of a status code
  else if (code === 'false') status = 307;
  else status = Number.parseInt(code, 10);
  const target = pyStrip(unescape(match.groups.target));
  if (!target) return null;
  return new HtmlRedirect({ target, type: NEXT_REDIRECT, statusCode: status, mode });
}

/** @param $ a Cheerio document from `loadHtml` */
export function detectMetaRefresh($) {
  for (const meta of $('meta').toArray()) {
    const equiv = attrValue(meta, 'http-equiv');
    if (typeof equiv !== 'string' || pyLower(pyStrip(equiv)) !== 'refresh') continue;
    if ($(meta).parents('noscript').length) continue; // only applies when JavaScript is disabled
    const content = attrValue(meta, 'content');
    if (typeof content !== 'string') continue;
    const match = META_REFRESH_CONTENT_RE.exec(content);
    if (match === null) continue;
    const target = pyStrip(match.groups.target);
    if (!target) continue; // plain refresh of the same page, not a redirect
    const delay = match.groups.delay ? Number.parseFloat(match.groups.delay) : 0.0;
    return new HtmlRedirect({ target, type: META_REFRESH, delaySeconds: delay });
  }
  return null;
}

/** First HTML-level redirect instruction found, or null. */
export function detectHtmlRedirect(html, $ = null) {
  const found = detectNextRedirect(html);
  if (found !== null) return found;
  return detectMetaRefresh($ ?? loadHtml(html));
}

export function isNextErrorShell(html) {
  return new RegExp(`<html\\b[^>]*\\bid[${S}]*=[${S}]*["']?__next_error__`, 'iu').test(html.slice(0, 2000));
}
