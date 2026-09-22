/** Crawler URL normalisation and site scope (app/crawler/urls.py). */

import { parseQsl, urlencode, urlsplit, urlunsplit } from '../utils/pyurl.js';
import { normalizeUrl } from '../utils/urls.js';
import { pyCompare, pyLower } from '../utils/pytext.js';

// Query parameters that never identify a different page.
export const TRACKING_PARAMS = new Set([
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid',
  'twclid', 'ttclid', 'li_fat_id', 'igshid', 'mc_cid', 'mc_eid', '_ga', '_gl',
  '_hsenc', '_hsmi', 'hsctatracking', 'mkt_tok', 'vero_id', 'srsltid', 'ref_src',
]);
export const TRACKING_PREFIXES = ['utm_', 'pk_', 'matomo_', 'hsa_'];

// Non-HTML resources that are never crawled as pages.
export const ASSET_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff',
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'txt', 'rss', 'atom',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'zip', 'gz', 'rar',
  '7z', 'tar', 'mp3', 'mp4', 'm4a', 'wav', 'avi', 'mov', 'webm', 'ogg', 'exe',
  'dmg', 'apk',
]);

export const MAX_URL_LENGTH = 2048;
export const MAX_PATH_SEGMENTS = 15;
export const MAX_QUERY_PARAMS = 5;
const REPEATED_SEGMENT = /(\/[^/]+)\1{2,}/; // /a/a/a -> crawler trap

function isTracking(name) {
  const lowered = pyLower(name);
  return TRACKING_PARAMS.has(lowered) || TRACKING_PREFIXES.some((p) => lowered.startsWith(p));
}

/** Python tuple ordering for (key, value) pairs. */
function comparePairs(a, b) {
  return pyCompare(a[0], b[0]) || pyCompare(a[1], b[1]);
}

/**
 * Absolute http(s) URL without fragment, default port or tracking parameters. Remaining query
 * parameters are kept (they may select different content) but sorted so parameter order does not
 * create duplicates. Trailing-slash variants are unified by `urlKey` when de-duplicating.
 */
export function normalizeCrawlUrl(url, base = null) {
  const normalised = normalizeUrl(url, base);
  if (normalised === null) return null;
  const parts = urlsplit(normalised);
  const query = parseQsl(parts.query, true).filter(([k]) => !isTracking(k));
  query.sort(comparePairs);
  const path = parts.path.replace(/\/{2,}/g, '/') || '/';
  return urlunsplit([parts.scheme, parts.netloc, path, urlencode(query), '']);
}

export function isAsset(url) {
  const path = pyLower(urlsplit(url).path);
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.') && ASSET_EXTENSIONS.has(last.slice(last.lastIndexOf('.') + 1));
}

export function looksLikeTrap(url) {
  const parts = urlsplit(url);
  if ([...url].length > MAX_URL_LENGTH) return true;
  if (parts.path.split('/').filter(Boolean).length > MAX_PATH_SEGMENTS) return true;
  if (parts.query && parseQsl(parts.query, true).length > MAX_QUERY_PARAMS) return true;
  return REPEATED_SEGMENT.test(parts.path);
}

/** Hosts that belong to a site. `www.` is only included when explicitly allowed. */
export class SiteScope {
  constructor(hosts, scheme) {
    this.hosts = hosts;
    this.scheme = scheme;
  }

  static forSite(baseUrl, { includeWwwVariant = false, extraHosts = [] } = {}) {
    const parts = urlsplit(baseUrl);
    const host = pyLower(parts.hostname || '');
    const hosts = new Set([host, ...extraHosts.map((h) => pyLower(h))]);
    if (includeWwwVariant) hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
    return new SiteScope(hosts, parts.scheme.toLowerCase());
  }

  contains(url) {
    const parts = urlsplit(url);
    return (parts.scheme === 'http' || parts.scheme === 'https') && this.hosts.has(pyLower(parts.hostname || ''));
  }
}
