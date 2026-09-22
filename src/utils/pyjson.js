/**
 * `json.loads(body_bytes)` as CPython does it (Starlette's `request.json()`), so request bodies are
 * accepted/rejected exactly like the Python reference and invalid JSON reports Python's
 * `JSONDecodeError` message and position (FastAPI puts them in `loc: ["body", pos]` / `ctx.error`).
 *
 * `JSON.parse` is the fast path. Python additionally accepts `NaN`, `Infinity` and `-Infinity` (and
 * decodes UTF-8-sig/16/32 bodies); on any `JSON.parse` failure the port of CPython's C scanner (Modules/_json.c) decides.
 * Positions are in code points, like Python string indices.
 */

export class PyJSONDecodeError extends Error {
  constructor(msg, text, pos) {
    super(msg);
    this.name = 'JSONDecodeError';
    this.msg = msg;
    // UTF-16 index -> code point index.
    this.pos = [...text.slice(0, pos)].length;
  }
}

class StopIteration {
  constructor(idx) {
    this.idx = idx;
  }
}

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

class Scanner {
  constructor(text) {
    this.s = text;
  }

  error(msg, pos) {
    return new PyJSONDecodeError(msg, this.s, pos);
  }

  skipWs(idx) {
    while (idx < this.s.length && isWs(this.s[idx])) idx += 1;
    return idx;
  }

  /** scanstring_unicode: `end` is the index after the opening quote. Returns [value, end]. */
  scanString(end) {
    const s = this.s;
    const begin = end - 1;
    let out = '';
    for (;;) {
      let next = end;
      while (next < s.length) {
        const c = s[next];
        if (c === '"' || c === '\\') break;
        if (c.charCodeAt(0) <= 0x1f) throw this.error('Invalid control character at', next);
        next += 1;
      }
      if (next >= s.length) throw this.error('Unterminated string starting at', begin);
      out += s.slice(end, next);
      if (s[next] === '"') return [out, next + 1];
      next += 1; // skip the backslash
      if (next === s.length) throw this.error('Unterminated string starting at', begin);
      const c = s[next];
      if (c !== 'u') {
        end = next + 1;
        if (!(c in ESCAPES)) throw this.error('Invalid \\escape', end - 2);
        out += ESCAPES[c];
        continue;
      }
      next += 1;
      end = next + 4;
      if (end >= s.length) throw this.error('Invalid \\uXXXX escape', next - 1);
      const hex = s.slice(next, end);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error('Invalid \\uXXXX escape', end - 5);
      let code = parseInt(hex, 16);
      next = end;
      if (code >= 0xd800 && code <= 0xdbff && end + 6 < s.length && s[next] === '\\' && s[next + 1] === 'u') {
        end += 6;
        const hex2 = s.slice(next + 2, end);
        if (!/^[0-9a-fA-F]{4}$/.test(hex2)) throw this.error('Invalid \\uXXXX escape', end - 5);
        const low = parseInt(hex2, 16);
        if (low >= 0xdc00 && low <= 0xdfff) code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        else end -= 6;
      }
      out += String.fromCodePoint(code);
    }
  }

  scanOnce(idx) {
    const s = this.s;
    if (idx >= s.length) throw new StopIteration(idx);
    const c = s[idx];
    if (c === '"') return this.scanString(idx + 1);
    if (c === '{') return this.parseObject(idx + 1);
    if (c === '[') return this.parseArray(idx + 1);
    if (c === 'n' && s.startsWith('null', idx)) return [null, idx + 4];
    if (c === 't' && s.startsWith('true', idx)) return [true, idx + 4];
    if (c === 'f' && s.startsWith('false', idx)) return [false, idx + 5];
    if (c === 'N' && s.startsWith('NaN', idx)) return [NaN, idx + 3];
    if (c === 'I' && s.startsWith('Infinity', idx)) return [Infinity, idx + 8];
    if (c === '-' && s.startsWith('-Infinity', idx)) return [-Infinity, idx + 9];
    NUMBER.lastIndex = idx;
    const m = NUMBER.exec(s);
    if (m) return [Number(m[0]), idx + m[0].length];
    throw new StopIteration(idx);
  }

  parseObject(idx) {
    const s = this.s;
    const obj = {};
    idx = this.skipWs(idx);
    if (idx >= s.length || s[idx] !== '}') {
      for (;;) {
        if (idx >= s.length || s[idx] !== '"') throw this.error('Expecting property name enclosed in double quotes', idx);
        const [key, afterKey] = this.scanString(idx + 1);
        idx = this.skipWs(afterKey);
        if (idx >= s.length || s[idx] !== ':') throw this.error("Expecting ':' delimiter", idx);
        idx = this.skipWs(idx + 1);
        const [value, afterValue] = this.scanOnce(idx);
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
        idx = this.skipWs(afterValue);
        if (idx < s.length && s[idx] === '}') break;
        if (idx >= s.length || s[idx] !== ',') throw this.error("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (idx < s.length && s[idx] === '}') throw this.error('Illegal trailing comma before end of object', comma);
      }
    }
    return [obj, idx + 1];
  }

  parseArray(idx) {
    const s = this.s;
    const arr = [];
    idx = this.skipWs(idx);
    if (idx >= s.length || s[idx] !== ']') {
      for (;;) {
        const [value, afterValue] = this.scanOnce(idx);
        arr.push(value);
        idx = this.skipWs(afterValue);
        if (idx < s.length && s[idx] === ']') break;
        if (idx >= s.length || s[idx] !== ',') throw this.error("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (idx < s.length && s[idx] === ']') throw this.error('Illegal trailing comma before end of array', comma);
      }
    }
    return [arr, idx + 1];
  }

  /** json.JSONDecoder.decode */
  decode() {
    let value;
    let end;
    try {
      [value, end] = this.scanOnce(this.skipWs(0));
    } catch (err) {
      if (err instanceof StopIteration) throw this.error('Expecting value', err.idx);
      throw err;
    }
    end = this.skipWs(end);
    if (end !== this.s.length) throw this.error('Extra data', end);
    return value;
  }
}

/** Parse a JSON document (a Python str) like `json.loads`; throws PyJSONDecodeError. */
export function pyJsonLoads(text) {
  try {
    return JSON.parse(text);
  } catch {
    return new Scanner(text).decode();
  }
}

/** Raised when the body bytes cannot be decoded (FastAPI answers 400). */
export class BodyDecodeError extends Error {}

/** `json.detect_encoding`. */
export function detectEncoding(b) {
  const starts = (...bytes) => bytes.every((x, i) => b[i] === x);
  if (starts(0x00, 0x00, 0xfe, 0xff) || starts(0xff, 0xfe, 0x00, 0x00)) return 'utf-32';
  if (starts(0xfe, 0xff) || starts(0xff, 0xfe)) return 'utf-16';
  if (starts(0xef, 0xbb, 0xbf)) return 'utf-8-sig';
  if (b.length >= 4) {
    if (!b[0]) return b[1] ? 'utf-16-be' : 'utf-32-be';
    if (!b[1]) return b[2] || b[3] ? 'utf-16-le' : 'utf-32-le';
  } else if (b.length === 2) {
    if (!b[0]) return 'utf-16-be';
    if (!b[1]) return 'utf-16-le';
  }
  return 'utf-8';
}

function decodeUtf32(b, littleEndian) {
  if (b.length % 4) throw new BodyDecodeError('truncated data');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let out = '';
  for (let i = 0; i < b.length; i += 4) {
    const cp = view.getUint32(i, littleEndian);
    if (cp > 0x10ffff) throw new BodyDecodeError('code point not in range(0x110000)');
    out += String.fromCodePoint(cp);
  }
  return out;
}

const decoder = (label) => new TextDecoder(label, { fatal: true, ignoreBOM: true });

/** `bytes.decode(json.detect_encoding(b), 'surrogatepass')` (BOMs of the utf-16/32/8-sig codecs removed). */
export function decodeJsonBytes(b) {
  try {
    switch (detectEncoding(b)) {
      case 'utf-32':
        return decodeUtf32(b.subarray(4), b[0] === 0xff);
      case 'utf-32-be':
        return decodeUtf32(b, false);
      case 'utf-32-le':
        return decodeUtf32(b, true);
      case 'utf-16':
        return decoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(b.subarray(2));
      case 'utf-16-be':
        return decoder('utf-16be').decode(b);
      case 'utf-16-le':
        return decoder('utf-16le').decode(b);
      case 'utf-8-sig':
        return decoder('utf-8').decode(b.subarray(3));
      default:
        return decoder('utf-8').decode(b);
    }
  } catch (err) {
    if (err instanceof BodyDecodeError) throw err;
    throw new BodyDecodeError(err.message);
  }
}

/** `json.loads(body_bytes)` (Starlette `request.json()`). */
export function pyJsonLoadsBytes(b) {
  return pyJsonLoads(decodeJsonBytes(b));
}
