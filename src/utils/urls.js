/** URL normalisation helpers shared by the page inventory and interlink modules (app/core/urls.py). */

import { urljoin, urlsplit, urlunsplit } from './pyurl.js';
import { pyLower, pyStrip } from './pytext.js';

const DEFAULT_PORTS = { http: 80, https: 443 };

/**
 * Absolute, canonical-form URL or null when it is not an http(s) URL.
 * Lowercases scheme/host, drops default ports and fragments, keeps the query string.
 * Throws URLValueError for malformed netlocs exactly where Python raises ValueError.
 */
export function normalizeUrl(url, base = null) {
  let raw = pyStrip(url ?? '');
  if (!raw) return null;
  if (base) raw = urljoin(base, raw);
  const parts = urlsplit(raw);
  const scheme = parts.scheme.toLowerCase();
  if (!(scheme in DEFAULT_PORTS) || !parts.hostname) return null;
  const host = pyLower(parts.hostname);
  let port;
  try {
    port = parts.port;
  } catch {
    return null;
  }
  const netloc = port === null || port === DEFAULT_PORTS[scheme] ? host : `${host}:${port}`;
  const path = parts.path || '/';
  return urlunsplit([scheme, netloc, path, parts.query, '']);
}

/** Comparison key treating `/a` and `/a/` (and http/https, www.) as the same page. */
export function urlKey(url) {
  const parts = urlsplit(url);
  const path = parts.path.replace(/\/+$/, '') || '/';
  const netloc = parts.netloc.startsWith('www.') ? parts.netloc.slice(4) : parts.netloc;
  const query = parts.query ? `?${parts.query}` : '';
  return `${netloc}${path}${query}`;
}

export function sameHost(url, other) {
  const strip = (h) => (h.startsWith('www.') ? h.slice(4) : h);
  const a = strip(urlsplit(url).hostname || '');
  const b = strip(urlsplit(other).hostname || '');
  return Boolean(a) && a === b;
}

/** Path + query, used as the href for internal links. */
export function siteRelative(url) {
  const parts = urlsplit(url);
  return urlunsplit(['', '', parts.path || '/', parts.query, '']);
}

export function urlPath(url) {
  return urlsplit(url).path || '/';
}

