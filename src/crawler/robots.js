/**
 * robots.txt handling per RFC 9309 (app/crawler/robots.py).
 *
 * Rules:
 * - The group whose user-agent matches our product token is used (merged if repeated);
 *   otherwise the `*` group; otherwise everything is allowed.
 * - The most specific (longest) matching rule wins; `Allow` wins ties.
 * - robots.txt fetch: 2xx -> parse, 4xx -> allow all, 5xx / network failure -> disallow all.
 * - `*` and `$` wildcards are supported (plain prefix matching would silently crawl paths a
 *   site has disallowed).
 */

import { unquote, urlsplit } from '../utils/pyurl.js';
import { pyLen, pyLower, pyStrip, splitlines } from '../utils/pytext.js';

export class RobotsRules {
  constructor({ rules = [], crawlDelay = null, sitemaps = [], allowAll = false, disallowAll = false, sourceStatus = null } = {}) {
    this.rules = rules; // [allow: boolean, pattern: string]
    this.crawlDelay = crawlDelay;
    this.sitemaps = sitemaps;
    this.allowAll = allowAll;
    this.disallowAll = disallowAll;
    this.sourceStatus = sourceStatus;
  }

  static allowingAll(status = null) {
    return new RobotsRules({ allowAll: true, sourceStatus: status });
  }

  static disallowingAll(status = null) {
    return new RobotsRules({ disallowAll: true, sourceStatus: status });
  }

  canFetch(url) {
    const parts = urlsplit(url);
    const path = parts.path || '/';
    if (path === '/robots.txt') return true;
    if (this.disallowAll) return false;
    if (this.allowAll || !this.rules.length) return true;
    const target = normalisePath(path + (parts.query ? `?${parts.query}` : ''));
    let best = null; // [specificity, allow]
    for (const [allow, pattern] of this.rules) {
      if (matches(pattern, target)) {
        const specificity = pyLen(pattern);
        if (best === null || specificity > best[0] || (specificity === best[0] && allow)) best = [specificity, allow];
      }
    }
    return best === null ? true : best[1];
  }
}

// Compare in decoded form so /a%2Db and /a-b are treated alike.
function normalisePath(value) {
  return unquote(value);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split('*').map((piece) => escapeRegExp(normalisePath(piece))).join('.*');
  // Python `re.match`: anchored at the start; `.` does not match newlines.
  return new RegExp(`^(?:${regex})${anchored ? '$' : ''}`, 'u').test(path);
}

export function productToken(userAgent) {
  return pyLower(pyStrip(userAgent.split('/', 1)[0]));
}

/** Python `float()` for robots values ("2", "2.5", "1e3", "inf", "nan", "1_0"). */
function pyFloat(value) {
  const v = pyStrip(value);
  if (/^[+-]?(inf|infinity)$/i.test(v)) return v.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(v)) return Number.NaN;
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(v)) return null;
  return Number(v.replaceAll('_', ''));
}

/** Python `max()` over floats (NaN comparisons are always false, first wins on ties). */
function pyMax(values) {
  let best = values[0];
  for (const v of values.slice(1)) if (v > best) best = v;
  return best;
}

export function parseRobots(text, userAgent) {
  const token = productToken(userAgent);
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of splitlines(text)) {
    const line = pyStrip(rawLine.split('#', 1)[0]);
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const key = pyLower(pyStrip(line.slice(0, idx)));
    const value = pyStrip(line.slice(idx + 1));
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(pyLower(value));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue; // rules before any user-agent line are ignored
    if (key === 'allow' || key === 'disallow') {
      if (value) current.rules.push([key === 'allow', value]); // empty Disallow allows everything
    } else if (key === 'crawl-delay') {
      const delay = pyFloat(value);
      if (delay !== null) current.crawlDelay = delay;
    }
  }
  const specific = groups.filter((g) => g.agents.includes(token));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const delays = chosen.map((g) => g.crawlDelay).filter((d) => d !== null);
  return new RobotsRules({
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: delays.length ? pyMax(delays) : null,
    sitemaps: [...new Set(sitemaps)],
    allowAll: !chosen.length,
    sourceStatus: 200,
  });
}
