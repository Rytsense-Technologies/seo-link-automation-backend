/**
 * Safe, context-scoped insertion of a single internal link into HTML content
 * (app/interlink/link_applier.py).
 *
 * Guarantees:
 * - Only the first occurrence of the anchor *inside the approved context sentence* is linked;
 *   no global keyword replacement.
 * - Never links text inside <a>, headings, nav/header/footer, code/pre, script/style, form
 *   controls, SVG, etc. (UNLINKABLE_ELEMENTS), so nested links are impossible.
 * - The anchor must lie within a single text node (never spans existing tags).
 * - The rest of the document is byte-for-byte unchanged (offset splice, no re-serialisation).
 */

import { htmlEscape, htmlUnescape, parseHtml } from '../content/html.js';
import { UnprocessableError } from '../utils/errors.js';
import { normalizeUrl, urlKey } from '../utils/urls.js';
import { casefoldChar, isSpace, pyStrip } from '../utils/pytext.js';
import { QUOTE_MAP, normalizeForMatch, wholeWordRegExp } from './anchor-rules.js';

export class LinkApplicationError extends UnprocessableError {
  static code = 'LINK_APPLICATION_FAILED';
}

export function containsLinkTo(content, pageUrl, targetUrl) {
  const target = urlKey(targetUrl);
  for (const anchor of parseHtml(content).anchors) {
    const href = normalizeUrl(anchor.href, pageUrl);
    if (href !== null && urlKey(href) === target) return true;
  }
  return false;
}

/**
 * Normalised text of a block (as `normalizeForMatch` would produce) + a char map.
 * mapping[i] = [node index, UTF-16 start of the source code point, its UTF-16 length].
 */
function normalisedBlock(nodes) {
  let chars = '';
  const mapping = [];
  let prevSpace = true;
  nodes.forEach((node, ni) => {
    const text = node.text;
    for (let ci = 0; ci < text.length; ) {
      const cp = text.codePointAt(ci);
      const ch = String.fromCodePoint(cp);
      const width = ch.length;
      if (isSpace(ch)) {
        if (!prevSpace) {
          chars += ' ';
          mapping.push([ni, ci, width]);
          prevSpace = true;
        }
      } else {
        const folded = casefoldChar(QUOTE_MAP.get(ch) ?? ch);
        for (let k = 0; k < folded.length; k += 1) {
          chars += folded[k];
          mapping.push([ni, ci, width]);
        }
        prevSpace = false;
      }
      ci += width;
    }
  });
  return [chars, mapping];
}

export function applyLink(content, { pageUrl, targetUrl, href, anchorText, context }) {
  if (!content || !pyStrip(content)) {
    throw new LinkApplicationError('Source page has no content', { code: 'SOURCE_CONTENT_EMPTY' });
  }
  if (containsLinkTo(content, pageUrl, targetUrl)) {
    throw new LinkApplicationError('Source page already links to the target', { code: 'ALREADY_LINKED' });
  }
  const normContext = normalizeForMatch(context);
  const normAnchor = normalizeForMatch(anchorText);
  if (!normContext || !normAnchor) {
    throw new LinkApplicationError('Anchor text and context are required', { code: 'INVALID_INPUT' });
  }

  const blocks = new Map();
  for (const node of parseHtml(content).textNodes) {
    if (!node.inLinkContext) continue;
    if (!blocks.has(node.blockId)) blocks.set(node.blockId, []);
    blocks.get(node.blockId).push(node);
  }

  let contextFound = false;
  let anchorBlocked = false;
  for (const nodes of blocks.values()) {
    const [text, mapping] = normalisedBlock(nodes);
    let start = text.indexOf(normContext);
    while (start >= 0) {
      contextFound = true;
      const end = start + normContext.length;
      // Python `finditer(text, start, end)`: the lookbehind may see text before `start`, while
      // the lookahead is cut off at `end` (as if the string were `end` characters long).
      const upToEnd = text.slice(0, end);
      const anchorRe = wholeWordRegExp(normAnchor, 'gu');
      anchorRe.lastIndex = start;
      for (let match = anchorRe.exec(upToEnd); match !== null; match = anchorRe.exec(upToEnd)) {
        if (match[0].length === 0) anchorRe.lastIndex += 1;
        const mStart = match.index;
        const mEnd = mStart + match[0].length;
        const [firstNode, firstChar] = mapping[mStart];
        const [lastNode, lastChar, lastWidth] = mapping[mEnd - 1];
        const node = nodes[firstNode];
        if (firstNode !== lastNode || !node.linkable) {
          anchorBlocked = true;
          continue;
        }
        const rawStart = node.rawOffset(firstChar);
        const rawEnd = node.rawOffset(lastChar + lastWidth);
        const openTag = `<a href="${htmlEscape(href)}">`;
        const newContent = content.slice(0, rawStart) + openTag + content.slice(rawStart, rawEnd) + '</a>' + content.slice(rawEnd);
        return {
          content: newContent,
          rawStart,
          rawEnd: rawEnd + openTag.length + '</a>'.length,
          anchorText: htmlUnescape(content.slice(rawStart, rawEnd)),
        };
      }
      start = text.indexOf(normContext, start + 1);
    }
  }

  if (!contextFound) {
    throw new LinkApplicationError('The suggested context no longer exists in linkable source content', {
      code: 'CONTEXT_NOT_FOUND',
    });
  }
  if (anchorBlocked) {
    throw new LinkApplicationError('The anchor text only occurs inside an existing link or unsafe element', {
      code: 'ANCHOR_IN_UNSAFE_ELEMENT',
    });
  }
  throw new LinkApplicationError('The anchor text was not found within the suggested context', {
    code: 'ANCHOR_NOT_FOUND',
  });
}
