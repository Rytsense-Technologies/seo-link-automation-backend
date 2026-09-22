/**
 * Position-preserving HTML tokenizer (app/content/html.py).
 *
 * We deliberately avoid DOM round-tripping (parse -> serialise) so applying a link never
 * reformats the rest of the document: every text node keeps its exact raw offsets in the
 * original string, and edits are splices at those offsets.
 */

import { decodeHTML } from 'entities';
import { normalizeUrl } from '../utils/urls.js';
import { PY_SPACE_CHARS, collapseWhitespace } from '../utils/pytext.js';

// Elements whose content is raw text (no nested tags).
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noscript']);
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
export const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details',
  'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
// Text inside these elements must never receive an inserted link.
export const UNLINKABLE_ELEMENTS = new Set([
  'a', 'button', 'code', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'iframe', 'kbd', 'label', 'math', 'nav', 'noscript', 'option', 'pre',
  'samp', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title', 'xmp',
]);
export const INLINE_UNLINKABLE_ELEMENTS = new Set(['a', 'code', 'kbd', 'samp', 'button', 'label']);
// Text inside these elements is not visible page copy.
export const INVISIBLE_ELEMENTS = new Set([
  'head', 'script', 'style', 'template', 'noscript', 'title', 'svg', 'math', 'iframe', 'xmp',
]);

const S = PY_SPACE_CHARS; // Python `\s` for str patterns
const TAG_RE = new RegExp(
  '<!--.*?-->' + // comment
    '|<!\\[CDATA\\[.*?\\]\\]>' +
    '|<![^>]*>' + // doctype
    '|<\\?.*?\\?>' + // processing instruction
    `|</?[a-zA-Z][a-zA-Z0-9:-]*(?:[${S}]+[^${S}"'>/=]+(?:[${S}]*=[${S}]*(?:"[^"]*"|'[^']*'|[^${S}"'=<>\`]+))?)*[${S}]*/?>`,
  'gsu',
);
const TAG_NAME_RE = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/;
const HREF_RE = new RegExp(`[${S}]href[${S}]*=[${S}]*(?:"([^"]*)"|'([^']*)'|([^${S}"'=<>\`]+))`, 'iu');
const ENTITY_RE = /&(?:#[0-9]+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g;

/** Python `html.unescape`. */
export function htmlUnescape(value) {
  return value.includes('&') ? decodeHTML(value) : value;
}

/** Python `html.escape(value, quote=True)`. */
export function htmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function decodeWithOffsets(raw) {
  let text = '';
  const offsets = [];
  let pos = 0;
  ENTITY_RE.lastIndex = 0;
  for (let m = ENTITY_RE.exec(raw); m !== null; m = ENTITY_RE.exec(raw)) {
    for (let i = pos; i < m.index; i += 1) {
      text += raw[i];
      offsets.push(i);
    }
    const decoded = htmlUnescape(m[0]);
    for (let i = 0; i < decoded.length; i += 1) {
      text += decoded[i];
      offsets.push(m.index);
    }
    pos = m.index + m[0].length;
  }
  for (let i = pos; i < raw.length; i += 1) {
    text += raw[i];
    offsets.push(i);
  }
  offsets.push(raw.length);
  // Offsets for decoded chars that belong to one entity all point at the entity start; the end
  // offset of a span is computed from the *next* char, so spans never split an entity.
  return [text, offsets];
}

export class TextNode {
  constructor(rawStart, rawEnd, raw, ancestors, blockId) {
    this.rawStart = rawStart;
    this.rawEnd = rawEnd;
    this.raw = raw;
    this.ancestors = ancestors;
    this.blockId = blockId;
    [this.text, this._offsets] = decodeWithOffsets(raw);
  }

  get linkable() {
    return !this.ancestors.some((a) => UNLINKABLE_ELEMENTS.has(a));
  }

  get visible() {
    return !this.ancestors.some((a) => INVISIBLE_ELEMENTS.has(a));
  }

  /**
   * Text belonging to body copy that may host a link somewhere in its sentence. Existing inline
   * links/code are part of the sentence text, but headings, navigation, headers/footers etc. are
   * not link contexts at all.
   */
  get inLinkContext() {
    return (
      this.visible &&
      this.ancestors.filter((a) => UNLINKABLE_ELEMENTS.has(a)).every((a) => INLINE_UNLINKABLE_ELEMENTS.has(a))
    );
  }

  rawOffset(decodedIndex) {
    return this.rawStart + this._offsets[decodedIndex];
  }
}

export function parseHtml(source) {
  const textNodes = [];
  const anchors = [];
  const stack = []; // [tagName, blockId]
  let blockCounter = 0;
  let pos = 0;
  const n = source.length;

  const currentBlock = () => (stack.length ? stack[stack.length - 1][1] : 0);
  const addText = (start, end) => {
    if (end > start) {
      textNodes.push(new TextNode(start, end, source.slice(start, end), stack.map(([name]) => name), currentBlock()));
    }
  };
  const popTo = (predicate, stopAt = null) => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (predicate(stack[i][0])) {
        stack.splice(i);
        return;
      }
      if (stopAt && stopAt(stack[i][0])) return;
    }
  };

  while (pos < n) {
    TAG_RE.lastIndex = pos;
    const m = TAG_RE.exec(source);
    if (m === null) {
      addText(pos, n);
      break;
    }
    addText(pos, m.index);
    const token = m[0];
    pos = m.index + token.length;
    const nameMatch = TAG_NAME_RE.exec(token);
    if (nameMatch === null) continue; // comment / doctype / PI
    const name = nameMatch[1].toLowerCase();
    if (token.startsWith('</')) {
      // Pop to the matching open element, tolerating mis-nested markup.
      popTo((tag) => tag === name);
      continue;
    }
    const selfClosing = token.endsWith('/>');
    if (name === 'a') {
      const href = HREF_RE.exec(token);
      if (href) {
        const value = href[1] ?? href[2] ?? href[3];
        anchors.push({ href: htmlUnescape(value), rawStart: m.index });
      }
      // An <a> opening while another is open implicitly closes it (HTML parsing rules).
      popTo((tag) => tag === 'a');
    }
    if (name === 'p') {
      // <p> implicitly closes an open <p>.
      popTo((tag) => tag === 'p', (tag) => BLOCK_ELEMENTS.has(tag));
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    let block;
    if (BLOCK_ELEMENTS.has(name)) {
      blockCounter += 1;
      block = blockCounter;
    } else {
      block = currentBlock();
    }
    stack.push([name, block]);
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeRe = new RegExp(`</${name}[${S}]*>`, 'giu');
      closeRe.lastIndex = pos;
      const close = closeRe.exec(source);
      const end = close ? close.index : n;
      addText(pos, end);
      stack.pop();
      pos = close ? close.index + close[0].length : n;
    }
  }
  return { source, textNodes, anchors };
}

/** Absolute, normalised hrefs of all <a> elements. */
export function extractLinks(source, baseUrl) {
  const links = [];
  for (const anchor of parseHtml(source).anchors) {
    const normalised = normalizeUrl(anchor.href, baseUrl);
    if (normalised) links.push(normalised);
  }
  return links;
}

/** Visible text grouped per block element, whitespace-collapsed. */
export function extractBlocks(source, { linkContextsOnly = false } = {}) {
  const blocks = new Map();
  for (const node of parseHtml(source).textNodes) {
    if (!node.visible || (linkContextsOnly && !node.inLinkContext)) continue;
    if (!blocks.has(node.blockId)) blocks.set(node.blockId, []);
    blocks.get(node.blockId).push(node.text);
  }
  const result = [];
  for (const parts of blocks.values()) {
    const text = collapseWhitespace(parts.join(''));
    if (text) result.push(text);
  }
  return result;
}

export function extractText(source) {
  return extractBlocks(source).join('\n');
}

export { collapseWhitespace };
