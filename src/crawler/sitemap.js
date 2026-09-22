/** Sitemap parsing: <urlset>, <sitemapindex>, gzip and plain-text sitemaps (app/crawler/sitemap.py). */

import zlib from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { pyLower, pyStrip, splitlines } from '../utils/pytext.js';

export class SitemapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SitemapError';
  }
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  processEntities: false,
  cdataPropName: '#cdata',
  commentPropName: '#comment',
  ignorePiTags: true,
});

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the XML predefined + numeric entities in one pass (like ElementTree). */
function decodeXmlText(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, ref) => {
    if (ref[0] !== '#') return XML_ENTITIES[ref];
    const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return String.fromCodePoint(cp);
  });
}

function gunzip(data, limit) {
  try {
    return zlib.gunzipSync(data, { maxOutputLength: limit });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw new SitemapError(`Decompressed sitemap exceeds ${limit} bytes`);
    }
    throw new SitemapError('Invalid gzip sitemap');
  }
}

/** Bytes `lstrip()` (ASCII whitespace). */
function lstripBytes(buf) {
  let i = 0;
  while (i < buf.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(buf[i])) i += 1;
  return buf.subarray(i);
}

const BOM = String.fromCharCode(0xfeff);

function decodeXmlBytes(buf) {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const decl = new RegExp(`^${BOM}?<\\?xml[^>]*encoding\\s*=\\s*["']([A-Za-z0-9._-]+)["']`).exec(text);
  if (decl && !/^utf-?8$/i.test(decl[1])) {
    try {
      text = new TextDecoder(decl[1], { fatal: false }).decode(buf);
    } catch {
      /* unknown encoding: keep utf-8 */
    }
  }
  return text.startsWith(BOM) ? text.slice(1) : text;
}

const tagOf = (node) => Object.keys(node).find((k) => k !== ':@');

/** ElementTree `element.text`: text before the first child element (comments skipped). */
function elementText(children) {
  let text = null;
  for (const child of children) {
    const tag = tagOf(child);
    if (tag === '#text') text = (text ?? '') + decodeXmlText(String(child['#text']));
    else if (tag === '#cdata') text = (text ?? '') + child['#cdata'].map((c) => String(c['#text'] ?? '')).join('');
    else if (tag === '#comment') continue;
    else break;
  }
  return text;
}

export function parseSitemap(body, { maxBytes }) {
  let data = Buffer.from(body);
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzip(data, maxBytes);
  const stripped = lstripBytes(data);
  if (stripped[0] !== 0x3c /* '<' */) {
    // Plain-text sitemap: one URL per line.
    const lines = splitlines(new TextDecoder('utf-8', { fatal: false }).decode(stripped));
    return { pageUrls: lines.map((u) => pyStrip(u)).filter((u) => u.startsWith('http')), childSitemaps: [] };
  }
  const head = stripped.subarray(0, 2000).toString('latin1').toUpperCase();
  if (head.includes('<!DOCTYPE') || stripped.toString('latin1').toUpperCase().includes('<!ENTITY')) {
    throw new SitemapError('Sitemaps with DTDs/entities are not accepted');
  }
  const xml = decodeXmlBytes(stripped);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new SitemapError(`Invalid sitemap XML: ${valid.err.msg} (line ${valid.err.line}, column ${valid.err.col})`);
  }
  const roots = parser.parse(xml).filter((n) => {
    const tag = tagOf(n);
    return tag && !tag.startsWith('#') && !tag.startsWith('?');
  });
  if (roots.length !== 1) throw new SitemapError('Invalid sitemap XML: expected exactly one root element');
  const rootTag = tagOf(roots[0]);
  const kind = pyLower(rootTag);
  const container = { sitemapindex: 'sitemap', urlset: 'url' }[kind];
  if (container === undefined) throw new SitemapError(`Unexpected sitemap root element <${kind}>`);
  const result = { pageUrls: [], childSitemaps: [] };
  for (const entry of roots[0][rootTag]) {
    const entryTag = tagOf(entry);
    if (!entryTag || entryTag.startsWith('#') || pyLower(entryTag) !== container) continue;
    for (const child of entry[entryTag]) {
      const childTag = tagOf(child);
      if (!childTag || childTag.startsWith('#') || pyLower(childTag) !== 'loc') continue;
      const text = elementText(child[childTag]);
      if (text && pyStrip(text)) {
        (kind === 'sitemapindex' ? result.childSitemaps : result.pageUrls).push(pyStrip(text));
      }
    }
  }
  return result;
}
