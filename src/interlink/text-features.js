/** Lightweight text features (tokens, TF-IDF vectors) for lexical candidate retrieval (app/interlink/text_features.py). */

import { PY_WORD_CHARS, pyLen, pyLower } from '../utils/pytext.js';

const W = PY_WORD_CHARS; // Python [^\W_]
const TOKEN_RE = new RegExp(`[${W}]+(?:['’-][${W}]+)*`, 'gu');

const STOPWORDS_TEXT = `
a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for from
further get got had has have having he her here hers herself him himself his how i if in into
is it its itself just let me more most my myself no nor not now of off on once only or other
our ours ourselves out over own same she should so some such than that the their theirs them
themselves then there these they this those through to too under until up very was we were
what when where which while who whom why will with would you your yours yourself yourselves
us via per may might must shall use using used new one two three best top guide page home
www com html htm php aspx index
`;
export const STOPWORDS = new Set(STOPWORDS_TEXT.split(/\s+/).filter(Boolean));

/** Python `str.isdigit()`. GENERATED from CPython: every character whose isdigit() is true. */
const PY_DIGITS_RE = /^[\u{30}-\u{39}\u{b2}-\u{b3}\u{b9}\u{660}-\u{669}\u{6f0}-\u{6f9}\u{7c0}-\u{7c9}\u{966}-\u{96f}\u{9e6}-\u{9ef}\u{a66}-\u{a6f}\u{ae6}-\u{aef}\u{b66}-\u{b6f}\u{be6}-\u{bef}\u{c66}-\u{c6f}\u{ce6}-\u{cef}\u{d66}-\u{d6f}\u{de6}-\u{def}\u{e50}-\u{e59}\u{ed0}-\u{ed9}\u{f20}-\u{f29}\u{1040}-\u{1049}\u{1090}-\u{1099}\u{1369}-\u{1371}\u{17e0}-\u{17e9}\u{1810}-\u{1819}\u{1946}-\u{194f}\u{19d0}-\u{19da}\u{1a80}-\u{1a89}\u{1a90}-\u{1a99}\u{1b50}-\u{1b59}\u{1bb0}-\u{1bb9}\u{1c40}-\u{1c49}\u{1c50}-\u{1c59}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{a620}-\u{a629}\u{a8d0}-\u{a8d9}\u{a900}-\u{a909}\u{a9d0}-\u{a9d9}\u{a9f0}-\u{a9f9}\u{aa50}-\u{aa59}\u{abf0}-\u{abf9}\u{ff10}-\u{ff19}\u{104a0}-\u{104a9}\u{10a40}-\u{10a43}\u{10d30}-\u{10d39}\u{10d40}-\u{10d49}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{11066}-\u{1106f}\u{110f0}-\u{110f9}\u{11136}-\u{1113f}\u{111d0}-\u{111d9}\u{112f0}-\u{112f9}\u{11450}-\u{11459}\u{114d0}-\u{114d9}\u{11650}-\u{11659}\u{116c0}-\u{116c9}\u{116d0}-\u{116e3}\u{11730}-\u{11739}\u{118e0}-\u{118e9}\u{11950}-\u{11959}\u{11bf0}-\u{11bf9}\u{11c50}-\u{11c59}\u{11d50}-\u{11d59}\u{11da0}-\u{11da9}\u{11f50}-\u{11f59}\u{16130}-\u{16139}\u{16a60}-\u{16a69}\u{16ac0}-\u{16ac9}\u{16b50}-\u{16b59}\u{16d70}-\u{16d79}\u{1ccf0}-\u{1ccf9}\u{1d7ce}-\u{1d7ff}\u{1e140}-\u{1e149}\u{1e2f0}-\u{1e2f9}\u{1e4f0}-\u{1e4f9}\u{1e5f1}-\u{1e5fa}\u{1e950}-\u{1e959}\u{1f100}-\u{1f10a}\u{1fbf0}-\u{1fbf9}]+$/u;

function isDigit(token) {
  return PY_DIGITS_RE.test(token);
}

export function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  for (const raw of pyLower(text).match(TOKEN_RE) ?? []) {
    const token = raw.replaceAll('’', "'");
    if (pyLen(token) < 2 || STOPWORDS.has(token) || isDigit(token)) continue;
    tokens.push(stem(token));
  }
  return tokens;
}

/** Very light plural/suffix folding so 'agents' ~ 'agent' without a stemming dependency. */
function stem(token) {
  for (const [suffix, minLen] of [['ies', 5], ['s', 4]]) {
    if (token.endsWith(suffix) && pyLen(token) >= minLen && !token.endsWith('ss')) {
      return token.slice(0, -suffix.length) + (suffix === 'ies' ? 'y' : '');
    }
  }
  return token;
}

/** Unigrams plus bigrams (phrases such as 'voice agent' carry more signal). */
export function terms(tokens) {
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/** @param fields [[text, weight], ...] -> Map(term -> weighted count) */
export function weightedTerms(fields) {
  const counts = new Map();
  for (const [text, weight] of fields) {
    for (const term of terms(tokenize(text))) counts.set(term, (counts.get(term) ?? 0) + weight);
  }
  return counts;
}

export function idf(documents) {
  const df = new Map();
  let n = 0;
  for (const doc of documents) {
    n += 1;
    for (const term of doc.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const out = new Map();
  for (const [term, count] of df) out.set(term, Math.log((1 + n) / (1 + count)) + 1.0);
  return out;
}

export function tfidf(counts, idfValues, defaultIdf) {
  const vec = new Map();
  for (const [t, c] of counts) {
    if (c > 0) vec.set(t, (1 + Math.log(c)) * (idfValues.get(t) ?? defaultIdf));
  }
  return vec;
}

/** CPython 3.12+ `sum()` over floats (Neumaier compensated summation). */
export function pySum(values) {
  let f = 0.0;
  let c = 0.0;
  for (const x of values) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
    else c += x - t + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

export function cosine(a, b) {
  if (!a.size || !b.size) return 0.0;
  let [x, y] = [a, b];
  if (x.size > y.size) [x, y] = [y, x];
  const dot = pySum([...x].map(([t, v]) => v * (y.get(t) ?? 0.0)));
  if (dot === 0.0) return 0.0;
  const norm = Math.sqrt(pySum([...x.values()].map((v) => v * v))) * Math.sqrt(pySum([...y.values()].map((v) => v * v)));
  return dot / norm;
}
