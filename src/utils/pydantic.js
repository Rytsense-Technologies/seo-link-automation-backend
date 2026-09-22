/**
 * Request validation with Pydantic v2 (lax mode) semantics, as FastAPI applies it.
 *
 * Ajv's type coercion is not Pydantic's: Ajv turns 5 into "5", wraps scalars into arrays and turns
 * null into ""/0/false, while Pydantic rejects those and instead accepts e.g. "1_000" for an int,
 * "yes"/"off" for a bool, braced/URN UUIDs and unix timestamps for datetimes. This module
 * re-implements the Pydantic rules for the field types this API uses, with Pydantic's error
 * `type` / `msg` / `ctx` wording (verified against pydantic-core 2.x by test/fixtures/pydantic-lax.json).
 *
 * Validators return `{ ok: true, value }` or `{ ok: false, errors: [{ type, loc, msg, input, ctx? }] }`
 * with `loc` relative to the validated value.
 */

const I64_MAX = 2 ** 63 - 1; // i64::MAX (rounded to the nearest double)
const fail = (type, msg, input, ctx) => ({ ok: false, errors: [{ type, loc: [], msg, input, ...(ctx ? { ctx } : {}) }] });
const ok = (value) => ({ ok: true, value });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const utf8Length = (s) => Buffer.byteLength(s, 'utf8');

// Rust `str::trim` (Unicode White_Space).
const RUST_WS = '[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]';
const RUST_TRIM = new RegExp(`^${RUST_WS}+|${RUST_WS}+$`, 'g');

// ---------------------------------------------------------------------------------------------
// int

const INT_PARSING = 'Input should be a valid integer, unable to parse string as an integer';

/** Rust `i64::from_str` / `BigInt::from_str`: optional sign, ASCII digits only. */
function parseRustInt(s) {
  return /^[+-]?[0-9]+$/.test(s) ? Number(s) : null;
}

function stripUnderscores(s) {
  if (s.startsWith('_') || s.endsWith('_') || s.includes('__')) return null;
  return s.replaceAll('_', '');
}

function parseIntStr(s) {
  const direct = parseRustInt(s);
  if (direct !== null) return direct;
  const stripped = stripUnderscores(s);
  return stripped === null ? null : parseRustInt(stripped);
}

/** pydantic-core `str_as_int`. */
function strAsInt(raw) {
  const s = raw.replace(RUST_TRIM, '');
  if (utf8Length(s) > 4300) return fail('int_parsing_size', 'Unable to parse input string as an integer, exceeded maximum size', raw);
  let value = parseIntStr(s);
  if (value === null) {
    const dot = s.indexOf('.');
    if (dot !== -1 && /^0+$/.test(s.slice(dot + 1))) value = parseIntStr(s.slice(0, dot));
  }
  return value === null ? fail('int_parsing', INT_PARSING, raw) : ok(value === 0 ? 0 : value);
}

export function validateInt(input, { ge = null, le = null } = {}) {
  let result;
  if (typeof input === 'boolean') result = ok(input ? 1 : 0);
  else if (typeof input === 'number') {
    if (!Number.isFinite(input)) result = fail('finite_number', 'Input should be a finite number', input);
    else if (!Number.isInteger(input)) result = fail('int_from_float', 'Input should be a valid integer, got a number with a fractional part', input);
    else result = ok(input === 0 ? 0 : input);
  } else if (typeof input === 'string') result = strAsInt(input);
  else result = fail('int_type', 'Input should be a valid integer', input);
  if (!result.ok) return result;
  if (ge !== null && !(result.value >= ge)) return fail('greater_than_equal', `Input should be greater than or equal to ${ge}`, input, { ge });
  if (le !== null && !(result.value <= le)) return fail('less_than_equal', `Input should be less than or equal to ${le}`, input, { le });
  return result;
}

// ---------------------------------------------------------------------------------------------
// bool

const TRUE_STRINGS = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_STRINGS = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

export function validateBool(input) {
  if (typeof input === 'boolean') return ok(input);
  const parsing = () => fail('bool_parsing', 'Input should be a valid boolean, unable to interpret input', input);
  if (typeof input === 'string') {
    const lower = input.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (TRUE_STRINGS.has(lower)) return ok(true);
    if (FALSE_STRINGS.has(lower)) return ok(false);
    return parsing();
  }
  if (typeof input === 'number' && Number.isInteger(input) && Math.abs(input) <= I64_MAX) {
    if (input === 0) return ok(false);
    if (input === 1) return ok(true);
    return parsing();
  }
  return fail('bool_type', 'Input should be a valid boolean', input);
}

// ---------------------------------------------------------------------------------------------
// str

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function validateStr(input, { minLength = null, maxLength = null } = {}) {
  if (typeof input !== 'string') return fail('string_type', 'Input should be a valid string', input);
  const length = [...input].length;
  if (minLength !== null && length < minLength) {
    return fail('string_too_short', `String should have at least ${plural(minLength, 'character')}`, input, { min_length: minLength });
  }
  if (maxLength !== null && length > maxLength) {
    return fail('string_too_long', `String should have at most ${plural(maxLength, 'character')}`, input, { max_length: maxLength });
  }
  return ok(input);
}

// ---------------------------------------------------------------------------------------------
// UUID (Rust `uuid` crate parser + its error diagnostics, as pydantic-core uses them)

const HEX = /^[0-9a-fA-F]$/;
const GROUP_STARTS = [0, 9, 14, 19, 24];
const GROUP_LENGTHS = [8, 4, 4, 4, 12];

function parseUuidStrict(s) {
  let core = null;
  const len = utf8Length(s);
  if (len === 32) {
    if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase();
    return null;
  }
  if (len === 36) core = s;
  else if (len === 38 && s.startsWith('{') && s.endsWith('}')) core = s.slice(1, -1);
  else if (len === 45 && s.startsWith('urn:uuid:')) core = s.slice(9);
  if (core === null || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(core)) return null;
  return core.replaceAll('-', '').toLowerCase();
}

/** `InvalidUuid::into_err` from the uuid crate. */
function uuidErrorMessage(s) {
  let body = s;
  let offset = 0;
  let simple = true;
  if (s.length >= 2 && s.startsWith('{') && s.endsWith('}')) {
    body = s.slice(1, -1);
    offset = 1;
    simple = false;
  } else if (s.startsWith('urn:uuid:')) {
    body = s.slice(9);
    offset = 9;
    simple = false;
  }
  let hyphens = 0;
  const bounds = [0, 0, 0, 0];
  let byteIndex = 0;
  for (const ch of body) {
    const code = ch.codePointAt(0);
    if (code > 0x7f) return `invalid character: found \`${ch}\` at ${byteIndex + offset + 1}`;
    if (ch === '-') {
      if (hyphens < 4) bounds[hyphens] = byteIndex;
      hyphens += 1;
    } else if (!HEX.test(ch)) {
      return `invalid character: found \`${ch}\` at ${byteIndex + offset + 1}`;
    }
    byteIndex += utf8Length(ch);
  }
  if (hyphens === 0 && simple) return `invalid length: expected length 32 for simple format, found ${utf8Length(s)}`;
  if (hyphens !== 4) return `invalid group count: expected 5, found ${hyphens + 1}`;
  for (let i = 0; i < 4; i += 1) {
    if (bounds[i] !== GROUP_STARTS[i + 1] - 1) {
      return `invalid group length in group ${i}: expected ${GROUP_LENGTHS[i]}, found ${bounds[i] - GROUP_STARTS[i]}`;
    }
  }
  return `invalid group length in group 4: expected 12, found ${utf8Length(s) - GROUP_STARTS[4]}`;
}

export function validateUuid(input) {
  if (typeof input !== 'string') return fail('uuid_type', 'UUID input should be a string, bytes or UUID object', input);
  const hex = parseUuidStrict(input);
  if (hex === null) {
    const error = uuidErrorMessage(input);
    return fail('uuid_parsing', `Input should be a valid UUID, ${error}`, input, { error });
  }
  return ok(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

// ---------------------------------------------------------------------------------------------
// HttpUrl (WHATWG URL parsing, like the Rust `url` crate; error reasons mapped to its ParseError)

const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
// WHATWG trims leading/trailing C0 controls and spaces, and removes tabs/newlines anywhere.
const trimUrl = (s) => s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');

/** Reason the url crate gives for an input the WHATWG parser rejects. */
function urlParseError(input) {
  // pydantic-core itself reports an empty string; anything else goes to the url crate.
  if (input === '') return 'input is empty';
  const s = trimUrl(input);
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!scheme) return 'relative URL without a base';
  if (!SPECIAL_SCHEMES.has(scheme[1].toLowerCase())) return 'relative URL without a base';
  // Special scheme: authority = after the scheme and any slashes/backslashes, up to the path.
  const rest = s.slice(scheme[0].length).replace(/^[/\\]*/, '');
  const authority = rest.split(/[/\\?#]/)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort === '') return 'empty host';
  let host = hostPort;
  let port = null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) return 'invalid IPv6 address';
    host = hostPort.slice(0, close + 1);
    if (hostPort.length > close + 1) port = hostPort.slice(close + 2);
    if (!URL.canParse(`http://${host}/`)) return 'invalid IPv6 address';
  } else {
    const colon = hostPort.indexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
    if (host === '') return 'empty host';
  }
  if (port !== null && port !== '' && !(/^[0-9]+$/.test(port) && Number(port) <= 65535)) return 'invalid port number';
  if (!host.startsWith('[')) {
    const labels = host.split('.');
    if (labels.at(-1) === '' && labels.length > 1) labels.pop();
    const last = labels.at(-1);
    const numeric = /^(0[xX][0-9a-fA-F]*|[0-9]+)$/.test(last);
    if (numeric && !URL.canParse(`http://${host}/`)) return 'invalid IPv4 address';
  }
  return 'invalid international domain name';
}

export function validateHttpUrl(input, { maxLength = 2083 } = {}) {
  if (typeof input !== 'string') return fail('url_type', 'URL input should be a string or URL', input);
  let url;
  try {
    url = new URL(input);
  } catch {
    const error = urlParseError(input);
    return fail('url_parsing', `Input should be a valid URL, ${error}`, input, { error });
  }
  const href = url.href;
  if (utf8Length(href) > maxLength) return fail('url_too_long', `URL should have at most ${maxLength} characters`, input, { max_length: maxLength });
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') {
    return fail('url_scheme', "URL scheme should be 'http' or 'https'", input, { expected_schemes: "'http' or 'https'" });
  }
  if (url.hostname === '') return fail('url_parsing', 'Input should be a valid URL, empty host', input, { error: 'empty host' });
  return ok(href);
}

// ---------------------------------------------------------------------------------------------
// datetime (speedate, as pydantic-core uses it)

const DATE_ERRORS = {
  TooShort: 'input is too short',
  InvalidCharYear: 'invalid character in year',
  InvalidCharDateSep: 'invalid date separator, expected `-`',
  InvalidCharMonth: 'invalid character in month',
  InvalidCharDay: 'invalid character in day',
  OutOfRangeMonth: 'month value is outside expected range of 1-12',
  OutOfRangeDay: 'day value is outside expected range',
  ExtraCharacters: 'unexpected extra characters at the end of the input',
  DateTooLarge: 'dates after 9999 are not supported as unix timestamps',
  DateTooSmall: 'dates before 0000 are not supported as unix timestamps',
  YearZero: 'year 0 is out of range',
};

class SpeedateError extends Error {}
const bad = (kind) => {
  throw new SpeedateError(kind);
};
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const pad = (n, w = 2) => String(n).padStart(w, '0');

function digits(s, start, count, kind) {
  let value = 0;
  for (let i = start; i < start + count; i += 1) {
    const c = s.charCodeAt(i);
    if (!(c >= 48 && c <= 57)) bad(kind);
    value = value * 10 + (c - 48);
  }
  return value;
}

/** speedate `Date::parse_bytes_partial` (the first 10 bytes). */
function parseDatePartial(s) {
  if (s.length < 10) bad('TooShort');
  const year = digits(s, 0, 4, 'InvalidCharYear');
  if (s[4] !== '-') bad('InvalidCharDateSep');
  const month = digits(s, 5, 2, 'InvalidCharMonth');
  if (s[7] !== '-') bad('InvalidCharDateSep');
  const day = digits(s, 8, 2, 'InvalidCharDay');
  if (month < 1 || month > 12) bad('OutOfRangeMonth');
  if (day < 1 || day > daysInMonth(year, month)) bad('OutOfRangeDay');
  return { year, month, day };
}

/** speedate `DateTime::parse_bytes_rfc3339`; returns null when the input is not such a datetime. */
function parseRfc3339(s) {
  try {
    const date = parseDatePartial(s);
    if (!['T', 't', ' ', '_'].includes(s[10])) return null;
    let i = 11;
    const hour = digits(s, i, 2, 'x');
    if (s[i + 2] !== ':') return null;
    const minute = digits(s, i + 3, 2, 'x');
    i += 5;
    let second = 0;
    let micro = 0;
    if (s[i] === ':') {
      second = digits(s, i + 1, 2, 'x');
      i += 3;
      if (s[i] === '.' || s[i] === ',') {
        let j = i + 1;
        let frac = '';
        while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
          frac += s[j];
          j += 1;
        }
        if (frac === '') return null;
        micro = Number(frac.slice(0, 6).padEnd(6, '0'));
        i = j;
      }
    }
    if (hour > 23 || minute > 59 || second > 59) return null;
    let offset = null;
    if (i < s.length) {
      const c = s[i];
      if (c === 'Z' || c === 'z') {
        offset = 0;
        i += 1;
      } else if (c === '+' || c === '-') {
        const h = digits(s, i + 1, 2, 'x');
        i += 3;
        // Minutes are required: +HH:MM or +HHMM.
        let m;
        if (s[i] === ':') {
          m = digits(s, i + 1, 2, 'x');
          i += 3;
        } else {
          m = digits(s, i, 2, 'x');
          i += 2;
        }
        if (h > 23 || m > 59) return null;
        offset = (c === '-' ? -1 : 1) * (h * 3600 + m * 60);
      } else {
        return null;
      }
    }
    if (i !== s.length) return null;
    return { ...date, hour, minute, second, micro, offset };
  } catch (err) {
    if (err instanceof SpeedateError) return null;
    throw err;
  }
}

const UNIX_0000 = -62167219200;
const UNIX_0001 = -62135596800;
const UNIX_9999 = 253402300799;
const MS_WATERSHED = 20000000000;

/** speedate `DateTime::from_timestamp` (seconds, or milliseconds above the watershed). UTC. */
function fromTimestamp(timestamp, extraMicro = 0) {
  let seconds = timestamp;
  let micro = extraMicro;
  if (Math.abs(timestamp) > MS_WATERSHED) {
    seconds = Math.trunc(timestamp / 1000);
    let ms = timestamp % 1000;
    if (ms < 0) {
      seconds -= 1;
      ms += 1000;
    }
    micro += ms * 1000;
  }
  if (seconds < UNIX_0000) bad('DateTooSmall');
  if (seconds > UNIX_9999) bad('DateTooLarge');
  seconds += Math.floor(micro / 1_000_000);
  micro %= 1_000_000;
  if (seconds < UNIX_0001) bad('YearZero'); // valid for speedate, not for Python's datetime
  const d = new Date(seconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    micro,
    offset: 0,
  };
}

/** speedate `float_parse_bytes`: an int or float string (no whitespace, exponent or underscores). */
function numericTimestamp(s) {
  if (/^[+-]?[0-9]+$/.test(s)) return { int: Number(s) };
  if (/^[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(s)) return { float: Number(s) };
  return null;
}

function floatTimestamp(value) {
  const whole = Math.floor(value);
  const micro = Math.round((value - whole) * 1_000_000);
  return fromTimestamp(whole, micro);
}

/** Python `datetime.isoformat()`. */
function isoformat(dt) {
  const base = `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}`;
  const frac = dt.micro ? `.${pad(dt.micro, 6)}` : '';
  if (dt.offset === null) return base + frac;
  const sign = dt.offset < 0 ? '-' : '+';
  const abs = Math.abs(dt.offset);
  return `${base}${frac}${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

export function validateDatetime(input) {
  const parsingError = (kind, type = 'datetime_parsing', prefix = 'Input should be a valid datetime') =>
    fail(type, `${prefix}, ${DATE_ERRORS[kind]}`, input, { error: DATE_ERRORS[kind] });
  if (typeof input === 'number') {
    try {
      return ok(isoformat(Number.isInteger(input) ? fromTimestamp(input) : floatTimestamp(input)));
    } catch (err) {
      if (err instanceof SpeedateError) return parsingError(err.message);
      throw err;
    }
  }
  if (typeof input !== 'string') return fail('datetime_type', 'Input should be a valid datetime', input);
  const parsed = parseRfc3339(input);
  if (parsed) return ok(isoformat(parsed));
  const numeric = numericTimestamp(input);
  if (numeric) {
    try {
      return ok(isoformat(numeric.int !== undefined ? fromTimestamp(numeric.int) : floatTimestamp(numeric.float)));
    } catch (err) {
      if (!(err instanceof SpeedateError)) throw err;
    }
  }
  // Fall back to a date (midnight); its error is the one reported.
  try {
    const date = parseDatePartial(input);
    if (input.length > 10) bad('ExtraCharacters');
    return ok(isoformat({ ...date, hour: 0, minute: 0, second: 0, micro: 0, offset: null }));
  } catch (err) {
    if (!(err instanceof SpeedateError)) throw err;
    return parsingError(err.message, 'datetime_from_date_parsing', 'Input should be a valid datetime or date');
  }
}

// ---------------------------------------------------------------------------------------------
// enum / list / model

export function validateEnum(input, values) {
  if (typeof input === 'string' && values.includes(input)) return ok(input);
  const quoted = values.map((v) => `'${v}'`);
  const expected = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}` : quoted[0];
  return fail('enum', `Input should be ${expected}`, input, { expected });
}

const prefixErrors = (errors, key) => errors.map((e) => ({ ...e, loc: [key, ...e.loc] }));

export function validateList(input, item, { minItems = null, maxItems = null } = {}) {
  if (!Array.isArray(input)) return fail('list_type', 'Input should be a valid list', input);
  const values = [];
  const errors = [];
  input.forEach((element, index) => {
    const result = item(element);
    if (result.ok) values.push(result.value);
    else errors.push(...prefixErrors(result.errors, index));
  });
  if (errors.length) return { ok: false, errors };
  const ctx = (limitKey, limit) => ({ field_type: 'List', [limitKey]: limit, actual_length: input.length });
  if (minItems !== null && input.length < minItems) {
    return fail('too_short', `List should have at least ${plural(minItems, 'item')} after validation, not ${input.length}`, input, ctx('min_length', minItems));
  }
  if (maxItems !== null && input.length > maxItems) {
    return fail('too_long', `List should have at most ${plural(maxItems, 'item')} after validation, not ${input.length}`, input, ctx('max_length', maxItems));
  }
  return ok(values);
}

/**
 * @param fields [{ name, validate, required, default }] in declaration order (extra keys ignored)
 */
export function validateModel(input, fields) {
  if (!isPlainObject(input)) {
    return fail('model_attributes_type', 'Input should be a valid dictionary or object to extract fields from', input);
  }
  const value = {};
  const errors = [];
  for (const field of fields) {
    if (!Object.hasOwn(input, field.name)) {
      if (field.required) errors.push({ type: 'missing', loc: [field.name], msg: 'Field required', input });
      else value[field.name] = structuredClone(field.default);
      continue;
    }
    const result = field.validate(input[field.name]);
    if (result.ok) value[field.name] = result.value;
    else errors.push(...prefixErrors(result.errors, field.name));
  }
  return errors.length ? { ok: false, errors } : ok(value);
}

export const nullable = (validate) => (input) => (input === null ? ok(null) : validate(input));
