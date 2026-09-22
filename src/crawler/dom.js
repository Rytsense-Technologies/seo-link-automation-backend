/**
 * BeautifulSoup(`html.parser`)-compatible DOM helpers on top of Cheerio/htmlparser2.
 *
 * - Parsing uses htmlparser2 (like `html.parser` it does not restructure the document the way
 *   HTML5 tree builders do), with `recognizeSelfClosing` to match `handle_startendtag`.
 * - `getText` reproduces `Tag.get_text(" ", strip=True)` (comments, <script>, <style> and
 *   <template> strings are excluded).
 * - `decodeContents` reproduces `Tag.decode_contents()` with BeautifulSoup's default "minimal"
 *   formatter (sorted attributes, whitespace-joined multi-valued attributes, `<br/>` voids,
 *   `& < >` escaping) so stored `content_html` matches the Python reference byte-for-byte on
 *   well-formed pages.
 */

import * as cheerio from 'cheerio';
import { parseDocument } from 'htmlparser2';
import { pySplit, pyStrip } from '../utils/pytext.js';

export function loadHtml(html) {
  const dom = parseDocument(html, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
  });
  return cheerio.load(dom, null, false);
}

const NON_TEXT_PARENTS = new Set(['script', 'style', 'template']);
const RAW_OUTPUT_PARENTS = new Set(['script', 'style', 'template']);
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem',
  'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'command', 'frame', 'image',
  'isindex', 'nextid', 'spacer',
]);
// BeautifulSoup's cdata_list_attributes for HTML (whitespace-separated multi-valued attributes).
const MULTI_VALUED = {
  '*': new Set(['class', 'accesskey', 'dropzone']),
  a: new Set(['rel', 'rev']),
  link: new Set(['rel', 'rev']),
  td: new Set(['headers']),
  th: new Set(['headers']),
  form: new Set(['accept-charset']),
  object: new Set(['archive']),
  area: new Set(['rel']),
  icon: new Set(['sizes']),
  iframe: new Set(['sandbox']),
  output: new Set(['for']),
};

export function isElement(node) {
  return node && (node.type === 'tag' || node.type === 'script' || node.type === 'style');
}

/** All strings of a subtree in document order (`Tag._all_strings`). */
function* strings(node) {
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      if (!NON_TEXT_PARENTS.has(child.parent?.name)) yield child.data;
    } else if (child.type === 'cdata') {
      yield* strings(child);
    } else if (isElement(child)) {
      yield* strings(child);
    }
  }
}

/** `Tag.get_text(" ", strip=True)`. */
export function getText(node) {
  const parts = [];
  for (const s of strings(node)) {
    const stripped = pyStrip(s);
    if (stripped) parts.push(stripped);
  }
  return parts.join(' ');
}

/** Attribute value as BeautifulSoup exposes it (multi-valued attributes normalised). */
export function attrValue(node, name) {
  const raw = node?.attribs?.[name];
  if (raw === undefined) return undefined;
  if (MULTI_VALUED['*'].has(name) || MULTI_VALUED[node.name]?.has(name)) return pySplit(raw).join(' ');
  return raw;
}

const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function quotedAttr(value) {
  let v = escapeXml(value);
  let quote = '"';
  if (v.includes('"')) {
    if (v.includes("'")) v = v.replaceAll('"', '&quot;');
    else quote = "'";
  }
  return `${quote}${v}${quote}`;
}

function serialize(node) {
  if (node.type === 'text') {
    return RAW_OUTPUT_PARENTS.has(node.parent?.name) ? node.data : escapeXml(node.data);
  }
  if (node.type === 'comment') return `<!--${node.data}-->`;
  if (node.type === 'cdata') return `<![CDATA[${(node.children ?? []).map((c) => c.data).join('')}]]>`;
  if (node.type === 'directive') return `<${node.data}>`;
  if (!isElement(node)) return '';
  const names = Object.keys(node.attribs ?? {}).sort();
  const attrs = names.map((n) => ` ${n}=${quotedAttr(attrValue(node, n))}`).join('');
  const children = node.children ?? [];
  if (VOID.has(node.name) && children.length === 0) return `<${node.name}${attrs}/>`;
  return `<${node.name}${attrs}>${children.map(serialize).join('')}</${node.name}>`;
}

/** `Tag.decode_contents()` (minimal formatter). */
export function decodeContents(node) {
  return (node.children ?? []).map(serialize).join('');
}

/** `str(soup)` for a whole document. */
export function decodeDocument(root) {
  return (root.children ?? []).map(serialize).join('');
}

/** Element descendants in document order (`find_all(True)`). */
export function* descendants(node) {
  for (const child of node.children ?? []) {
    if (isElement(child)) {
      yield child;
      yield* descendants(child);
    }
  }
}

/** Remove a node from the tree (`decompose`). */
export function removeNode(node) {
  const parent = node.parent;
  if (!parent) return;
  const i = parent.children.indexOf(node);
  if (i >= 0) parent.children.splice(i, 1);
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  node.parent = null;
  node.prev = null;
  node.next = null;
}

/** True when `node` is still attached below `root` (not inside a removed subtree). */
export function isAttached(node, root) {
  for (let n = node; n; n = n.parent) if (n === root) return true;
  return false;
}
