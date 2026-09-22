/**
 * Faithful port of the parts of CPython 3.14 `urllib.parse` used by the reference backend.
 *
 * WHATWG `URL` is deliberately NOT used for normalisation: it percent-encodes paths/queries and
 * resolves URLs differently from Python's `urljoin`/`urlsplit`, which would make Node store
 * different URL strings (and therefore duplicate `pages` rows) for URLs Python already stored.
 */

import { pyLower } from './pytext.js';

const C0_CONTROL_OR_SPACE = /^[\u0000-\u001f ]+/;
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
const USES_RELATIVE = new Set([
  '', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms',
  'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss',
]);
const USES_NETLOC = new Set([
  '', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https',
  'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp',
  'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services',
]);

export class URLValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Python `str.partition`. */
function partition(value, sep) {
  const i = value.indexOf(sep);
  return i < 0 ? [value, '', ''] : [value.slice(0, i), sep, value.slice(i + sep.length)];
}

/** Python `str.rpartition`. */
function rpartition(value, sep) {
  const i = value.lastIndexOf(sep);
  return i < 0 ? ['', '', value] : [value.slice(0, i), sep, value.slice(i + sep.length)];
}

function splitNetloc(url, start) {
  let delim = url.length;
  for (const c of '/?#') {
    const w = url.indexOf(c, start);
    if (w >= 0) delim = Math.min(delim, w);
  }
  return [url.slice(start, delim), url.slice(delim)];
}

function checkBracketedNetloc(netloc) {
  const hostAndPort = rpartition(netloc, '@')[2];
  const [before, open, bracketed] = partition(hostAndPort, '[');
  let hostname;
  if (open) {
    if (before) throw new URLValueError('Invalid IPv6 URL');
    const [h, , port] = partition(bracketed, ']');
    hostname = h;
    if (port && !port.startsWith(':')) throw new URLValueError('Invalid IPv6 URL');
  } else {
    hostname = partition(hostAndPort, ':')[0];
  }
  if (hostname.startsWith('v')) {
    if (!/^v[a-fA-F0-9]+\..+$/s.test(hostname)) throw new URLValueError('IPvFuture address is invalid');
  } else if (!isValidIPv6(hostname.split('%')[0]) || hostname.includes('%') && !/%./.test(hostname)) {
    throw new URLValueError(`'${hostname}' does not appear to be an IPv4 or IPv6 address`);
  }
}

function isValidIPv6(value) {
  // IPv4 inside brackets is rejected by Python ("An IPv4 address cannot be in brackets").
  return parseIPv6(value) !== null;
}

/** Internal `_urlsplit`: components are `null` when absent (like Python's None). */
function rawSplit(input, defaultScheme = null) {
  let url = input.replace(C0_CONTROL_OR_SPACE, '').replace(/[\t\r\n]/g, '');
  let scheme = defaultScheme;
  if (scheme !== null) {
    scheme = scheme.replace(/^[\u0000-\u001f ]+|[\u0000-\u001f ]+$/g, '').replace(/[\t\r\n]/g, '');
  }
  let netloc = null;
  let query = null;
  let fragment = null;
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url[0]) && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    [netloc, url] = splitNetloc(url, 2);
    const open = netloc.includes('[');
    const close = netloc.includes(']');
    if ((open && !close) || (close && !open)) throw new URLValueError('Invalid IPv6 URL');
    if (open && close) checkBracketedNetloc(netloc);
  }
  if (url.includes('#')) {
    const idx = url.indexOf('#');
    fragment = url.slice(idx + 1);
    url = url.slice(0, idx);
  }
  if (url.includes('?')) {
    const idx = url.indexOf('?');
    query = url.slice(idx + 1);
    url = url.slice(0, idx);
  }
  return { scheme, netloc, path: url, query, fragment };
}

function rawUnsplit(scheme, netloc, url, query, fragment) {
  let out = url;
  if (netloc !== null) {
    if (out && out[0] !== '/') out = `/${out}`;
    out = `//${netloc}${out}`;
  } else if (out.startsWith('//')) {
    out = `//${out}`;
  }
  if (scheme) out = `${scheme}:${out}`;
  if (query !== null) out = `${out}?${query}`;
  if (fragment !== null) out = `${out}#${fragment}`;
  return out;
}

/** A `SplitResult` with Python's `hostname`, `port`, `username`, `password` properties. */
export class SplitResult {
  constructor(scheme, netloc, path, query, fragment) {
    this.scheme = scheme;
    this.netloc = netloc;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  get _hostinfo() {
    const hostinfo = rpartition(this.netloc, '@')[2];
    const [, open, bracketed] = partition(hostinfo, '[');
    let hostname;
    let port;
    if (open) {
      const [h, , rest] = partition(bracketed, ']');
      hostname = h;
      port = partition(rest, ':')[2];
    } else {
      [hostname, , port] = partition(hostinfo, ':');
    }
    return [hostname, port || null];
  }

  get _userinfo() {
    const [userinfo, haveInfo] = rpartition(this.netloc, '@');
    if (!haveInfo) return [null, null];
    const [username, havePassword, password] = partition(userinfo, ':');
    return [username, havePassword ? password : null];
  }

  get username() {
    return this._userinfo[0];
  }

  get password() {
    return this._userinfo[1];
  }

  get hostname() {
    const hostname = this._hostinfo[0];
    if (!hostname) return null;
    const [host, percent, zone] = partition(hostname, '%');
    return pyLower(host) + percent + zone;
  }

  /** Throws URLValueError for a non-numeric / out-of-range port (like Python). */
  get port() {
    const raw = this._hostinfo[1];
    if (raw === null) return null;
    if (!/^[0-9]+$/.test(raw)) {
      throw new URLValueError(`Port could not be cast to integer value as '${raw}'`);
    }
    const port = Number.parseInt(raw, 10);
    if (!(port >= 0 && port <= 65535)) throw new URLValueError('Port out of range 0-65535');
    return port;
  }
}

export function urlsplit(url, scheme = '') {
  const r = rawSplit(url, scheme);
  return new SplitResult(r.scheme || '', r.netloc || '', r.path, r.query || '', r.fragment || '');
}

export function urlunsplit([scheme, netloc, url, query, fragment]) {
  let net = netloc;
  if (!net) {
    net = scheme && USES_NETLOC.has(scheme) && (!url || url[0] === '/') ? '' : null;
  }
  return rawUnsplit(scheme || null, net, url, query || null, fragment || null);
}

export function urljoin(base, url) {
  if (!base) return url;
  if (!url) return base;
  const b = rawSplit(base, null);
  const u = rawSplit(url, null);
  let { scheme, netloc, path, query, fragment } = u;
  if (scheme === null) scheme = b.scheme;
  if (scheme !== b.scheme || (scheme && !USES_RELATIVE.has(scheme))) return url;
  if (!scheme || USES_NETLOC.has(scheme)) {
    if (netloc) return rawUnsplit(scheme, netloc, path, query, fragment);
    netloc = b.netloc;
  }
  if (!path) {
    path = b.path;
    if (query === null) {
      query = b.query;
      if (fragment === null) fragment = b.fragment;
    }
    return rawUnsplit(scheme, netloc, path, query, fragment);
  }
  const baseParts = b.path.split('/');
  if (baseParts[baseParts.length - 1] !== '') baseParts.pop();
  let segments;
  if (path[0] === '/') {
    segments = path.split('/');
  } else {
    segments = [...baseParts, ...path.split('/')];
    if (segments.length > 2) {
      segments = [segments[0], ...segments.slice(1, -1).filter(Boolean), segments[segments.length - 1]];
    }
  }
  const resolved = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop();
    } else if (seg !== '.') {
      resolved.push(seg);
    }
  }
  const last = segments[segments.length - 1];
  if (last === '.' || last === '..') resolved.push('');
  return rawUnsplit(scheme, netloc, resolved.join('/') || '/', query, fragment);
}

// ------------------------------------------------------------------ quoting

const ALWAYS_SAFE = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~'.split('').map((c) => c.charCodeAt(0)),
);
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

function unquoteToBytes(ascii) {
  const bits = ascii.split('%');
  if (bits.length === 1) return utf8Encoder.encode(ascii);
  const out = [...utf8Encoder.encode(bits[0])];
  for (const item of bits.slice(1)) {
    const hex = item.slice(0, 2);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      out.push(...utf8Encoder.encode(item.slice(2)));
    } else {
      out.push(0x25, ...utf8Encoder.encode(item));
    }
  }
  return Uint8Array.from(out);
}

/** Python `unquote` (UTF-8, errors='replace'); non-ASCII runs are passed through untouched. */
export function unquote(value) {
  if (!value.includes('%')) return value;
  return value.replace(/[\u0000-\u007f]+/g, (run) => utf8Decoder.decode(unquoteToBytes(run)));
}

export function unquotePlus(value) {
  return unquote(value.replaceAll('+', ' '));
}

/** Python `quote_plus(value, safe='')`: RFC 3986 unreserved kept, space -> '+'. */
export function quotePlus(value) {
  if (!value) return value;
  let out = '';
  for (const byte of utf8Encoder.encode(value)) {
    if (byte === 0x20) out += '+';
    else if (ALWAYS_SAFE.has(byte)) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Python `parse_qsl(qs, keep_blank_values=keepBlank)`. */
export function parseQsl(qs, keepBlank = false) {
  if (!qs) return [];
  const pairs = [];
  for (const nameValue of qs.split('&')) {
    if (!nameValue) continue;
    const [name, , value] = partition(nameValue, '=');
    if (value || keepBlank) pairs.push([unquotePlus(name), unquotePlus(value)]);
  }
  return pairs;
}

/** Python `urlencode(list_of_pairs)` with `quote_plus`. */
export function urlencode(pairs) {
  return pairs.map(([k, v]) => `${quotePlus(String(k))}=${quotePlus(String(v))}`).join('&');
}

// ------------------------------------------------------------------ IP parsing (Python ipaddress)

/** Strict dotted-quad IPv4 (Python rejects leading zeros) -> BigInt, or null. */
export function parseIPv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p) || (p.length > 1 && p[0] === '0')) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    n = (n << 8n) | BigInt(octet);
  }
  return n;
}

/** IPv6 (optionally with embedded IPv4 tail, no zone) -> BigInt, or null. */
export function parseIPv6(value) {
  if (!value || !value.includes(':')) return null;
  let text = value;
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    const tail = [Number((v4 >> 16n) & 0xffffn).toString(16), Number(v4 & 0xffffn).toString(16)];
    text = `${text.slice(0, lastColon + 1)}${tail.join(':')}`;
  }
  const doubleColons = text.split('::').length - 1;
  if (doubleColons > 1) return null;
  let groups;
  if (doubleColons === 1) {
    const [head, rest] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = rest ? rest.split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = text.split(':');
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}
