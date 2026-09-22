/** HTML extraction for crawled pages (app/crawler/extract.py), using Cheerio on htmlparser2. */

import { createHash } from 'node:crypto';
import { PY_SPACE_CHARS, pyLower, pySplit, pyStrip } from '../utils/pytext.js';
import { normalizeCrawlUrl } from './urls.js';
import { detectHtmlRedirect, isNextErrorShell } from './html-redirects.js';
import {
  attrValue,
  decodeContents,
  decodeDocument,
  descendants,
  getText,
  isAttached,
  isElement,
  loadHtml,
  removeNode,
} from './dom.js';

// Removed from the stored main content: chrome, scripts and non-content widgets.
const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'form',
  'nav', 'header', 'footer', 'aside', 'dialog', 'button', 'select', 'input', 'textarea',
  'link', 'meta',
]);
const STRIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search', 'dialog', 'alert']);
const S = PY_SPACE_CHARS; // Python `\s`
const STRIP_HINT = new RegExp(
  `(^|[${S}_-])(cookie|consent|gdpr|newsletter|breadcrumb|skip-link|sr-only|modal|popup)([${S}_-]|$)`,
  'iu',
);
const WS_RUN = new RegExp(`[${S}]+`, 'gu');
const ROBOTS_SPLIT = new RegExp(`[${S},]+`, 'u');

/** `_text`: whitespace-collapsed get_text or null. */
function text(node) {
  if (!node) return null;
  const value = pyStrip(getText(node).replace(WS_RUN, ' '));
  return value || null;
}

/** `_attr`: stripped attribute value or null. */
function attr(node, name) {
  if (!node) return null;
  const value = attrValue(node, name);
  return typeof value === 'string' && pyStrip(value) ? pyStrip(value) : null;
}

function meta($, name) {
  const target = pyLower(name);
  const node = $('meta')
    .toArray()
    .find((m) => typeof m.attribs?.name === 'string' && pyLower(m.attribs.name) === target);
  return attr(node, 'content');
}

function hrefs(nodes, baseUrl) {
  const urls = [];
  for (const anchor of nodes) {
    if (anchor.name !== 'a' || anchor.attribs?.href === undefined) continue;
    const href = attr(anchor, 'href');
    if (href === null || ['#', 'mailto:', 'tel:', 'javascript:', 'data:'].some((p) => href.startsWith(p))) continue;
    const rel = pyLower(attr(anchor, 'rel') ?? '');
    if (pySplit(rel).includes('nofollow')) continue;
    const normalised = normalizeCrawlUrl(href, baseUrl);
    if (normalised) urls.push(normalised);
  }
  return [...new Set(urls)];
}

function mainRoot($) {
  for (const selector of ['main', '[role=main]', 'article']) {
    const candidates = $(selector).toArray();
    if (candidates.length) {
      // The largest candidate is the page body (some layouts nest several <article>s).
      let best = candidates[0];
      let bestLen = [...getText(best)].length;
      for (const c of candidates.slice(1)) {
        const len = [...getText(c)].length;
        if (len > bestLen) {
          best = c;
          bestLen = len;
        }
      }
      return best;
    }
  }
  return $('body').get(0) ?? null;
}

function stripChrome(root) {
  for (const node of [...descendants(root)]) {
    if (STRIP_TAGS.has(node.name) && isAttached(node, root)) removeNode(node);
  }
  for (const node of [...descendants(root)]) {
    if (!isAttached(node, root)) continue;
    const role = pyLower(attr(node, 'role') ?? '');
    const hints = `${attr(node, 'id') ?? ''} ${attr(node, 'class') ?? ''}`;
    const hidden = node.attribs?.hidden !== undefined || (attr(node, 'aria-hidden') ?? '') === 'true';
    if (STRIP_ROLES.has(role) || hidden || STRIP_HINT.test(hints)) removeNode(node);
  }
}

/** True when a 2xx HTML page has effectively no usable content (see Python `is_unusable`). */
export function isUnusable({ title, h1, contentText, errorShell = false }) {
  const hasText = Boolean(pyStrip(contentText));
  if (errorShell) return !hasText;
  return !hasText && !pyStrip(title ?? '') && !pyStrip(h1 ?? '');
}

export function extractPage(html, pageUrl, { xRobotsTag = null } = {}) {
  const $ = loadHtml(html);
  const doc = $.root().get(0);
  for (const node of [...allNodes(doc)]) if (node.type === 'comment') removeNode(node);

  const title = text($('title').get(0));
  const canonicalNode = $('link')
    .toArray()
    .find((l) => typeof l.attribs?.rel === 'string' && pyLower(l.attribs.rel).includes('canonical'));
  const canonicalHref = attr(canonicalNode, 'href');
  const canonical = canonicalHref ? normalizeCrawlUrl(canonicalHref, pageUrl) : null;
  const language = attr($('html').get(0), 'lang');
  const robotsDirectives = new Set(
    pyLower([meta($, 'robots'), xRobotsTag].filter(Boolean).join(' ')).split(ROBOTS_SPLIT),
  );
  const keywordsMeta = meta($, 'keywords');
  const allLinks = hrefs([...descendants(doc)], pageUrl);
  const htmlRedirect = detectHtmlRedirect(html, $);
  const errorShell = isNextErrorShell(html);

  const root = mainRoot($);
  const h1 = text($('h1').get(0));
  const rootNode = root ?? doc;
  stripChrome(rootNode);
  const headings = [...descendants(rootNode)]
    .filter((n) => ['h1', 'h2', 'h3'].includes(n.name))
    .map((n) => [n.name, text(n)])
    .filter(([, t]) => t);
  const contentText = text(rootNode) ?? '';
  const contentHtml = root ? pyStrip(decodeContents(root)) : decodeDocument(doc);
  return {
    title,
    h1,
    metaDescription: meta($, 'description'),
    canonicalUrl: canonical,
    language,
    noindex: robotsDirectives.has('noindex') || robotsDirectives.has('none'),
    headings,
    contentHtml,
    contentText,
    contentHash: createHash('sha256').update(contentText, 'utf8').digest('hex'),
    keywords: (keywordsMeta ?? '').split(',').map((k) => pyStrip(k)).filter(Boolean).slice(0, 50),
    links: allLinks,
    contentLinks: hrefs([...descendants(rootNode)], pageUrl),
    htmlRedirect,
    isErrorShell: errorShell,
    isEmpty: isUnusable({ title, h1, contentText, errorShell }),
  };
}

function* allNodes(node) {
  for (const child of node.children ?? []) {
    yield child;
    if (isElement(child) || child.type === 'root') yield* allNodes(child);
  }
}
