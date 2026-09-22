/**
 * SSRF protection for outbound crawler requests (app/crawler/ssrf.py).
 *
 * Two layers:
 *
 * 1. `validateUrl` - cheap pre-check of scheme/port/host before a URL is queued or requested.
 * 2. `createGuardedDispatcher` - enforced at TCP connect time: the hostname is resolved once,
 *    every resolved address must be public, and the socket connects to that exact validated IP
 *    (the guarded `lookup` result is what `net.connect` uses). This defeats DNS rebinding (a
 *    check-then-connect race) and applies to every request the client makes, including each
 *    redirect hop. Literal-IP hosts are validated before connecting. TLS still uses the original
 *    hostname for SNI and certificate verification. The dispatcher never uses proxy env vars.
 */

import dns from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector } from 'undici';
import { parseIPv4, parseIPv6, urlsplit } from '../utils/pyurl.js';
import { pyLower, pyStrip } from '../utils/pytext.js';

export const ALLOWED_SCHEMES = new Set(['http', 'https']);
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export class SSRFError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSRFError';
  }
}

// ------------------------------------------------------------------ Python ipaddress tables

function cidr4(text) {
  const [addr, bits] = text.split('/');
  return { net: parseIPv4(addr), bits: BigInt(bits), size: 32n };
}
function cidr6(text) {
  const [addr, bits] = text.split('/');
  return { net: parseIPv6(addr), bits: BigInt(bits), size: 128n };
}
function inNet(ip, { net: base, bits, size }) {
  const shift = size - bits;
  return ip >> shift === base >> shift;
}

const V4 = {
  linkLocal: cidr4('169.254.0.0/16'),
  loopback: cidr4('127.0.0.0/8'),
  multicast: cidr4('224.0.0.0/4'),
  shared: cidr4('100.64.0.0/10'), // _public_network: not global, not private
  reserved: cidr4('240.0.0.0/4'),
  private: [
    '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
    '192.0.0.170/31', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '240.0.0.0/4', '255.255.255.255/32',
  ].map(cidr4),
  privateExceptions: ['192.0.0.9/32', '192.0.0.10/32'].map(cidr4),
};
const V6 = {
  linkLocal: cidr6('fe80::/10'),
  multicast: cidr6('ff00::/8'),
  private: [
    '::1/128', '::/128', '::ffff:0.0.0.0/96', '64:ff9b:1::/48', '100::/64', '2001::/23',
    '2001:db8::/32', '2002::/16', '3fff::/20', 'fc00::/7', 'fe80::/10',
  ].map(cidr6),
  privateExceptions: [
    '2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28',
  ].map(cidr6),
  reserved: [
    '::/8', '100::/8', '200::/7', '400::/6', '800::/5', '1000::/4', '4000::/3', '6000::/3',
    '8000::/3', 'a000::/3', 'c000::/3', 'e000::/4', 'f000::/5', 'f800::/6', 'fe00::/9',
  ].map(cidr6),
};

function classifyV4(ip) {
  const isPrivate = V4.private.some((n) => inNet(ip, n)) && !V4.privateExceptions.some((n) => inNet(ip, n));
  return {
    text: [24n, 16n, 8n, 0n].map((s) => String((ip >> s) & 255n)).join('.'),
    isPrivate,
    isGlobal: !inNet(ip, V4.shared) && !isPrivate,
    isMulticast: inNet(ip, V4.multicast),
    isReserved: inNet(ip, V4.reserved),
    isLoopback: inNet(ip, V4.loopback),
    isLinkLocal: inNet(ip, V4.linkLocal),
    isUnspecified: ip === 0n,
  };
}

function classifyV6(ip, text) {
  const isPrivate = V6.private.some((n) => inNet(ip, n)) && !V6.privateExceptions.some((n) => inNet(ip, n));
  return {
    text,
    isPrivate,
    isGlobal: !isPrivate,
    isMulticast: inNet(ip, V6.multicast),
    isReserved: V6.reserved.some((n) => inNet(ip, n)),
    isLoopback: ip === 1n,
    isLinkLocal: inNet(ip, V6.linkLocal),
    isUnspecified: ip === 0n,
  };
}

/** Python `ipaddress.ip_address()` + classification, or null if not an IP literal. */
export function parseIpAddress(address) {
  const v4 = parseIPv4(address);
  if (v4 !== null) return classifyV4(v4);
  const [addr, zone] = address.split(/%(.*)/s);
  if (zone === '' || /[%/]/.test(zone ?? '')) return null;
  const v6 = parseIPv6(addr);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 addresses are judged by the embedded IPv4 address (Python semantics).
  if (v6 >> 32n === 0xffffn) return classifyV4(v6 & 0xffffffffn);
  return classifyV6(v6, address);
}

export function checkIp(address) {
  const ip = parseIpAddress(address.split('%', 1)[0]);
  if (ip === null) throw new SSRFError(`Invalid IP address '${address}'`);
  // is_global is false for private, loopback, link-local (incl. 169.254.169.254 metadata),
  // CGNAT, documentation, benchmarking and other special-purpose ranges.
  if (!ip.isGlobal || ip.isMulticast || ip.isReserved || ip.isLoopback || ip.isLinkLocal || ip.isPrivate || ip.isUnspecified) {
    throw new SSRFError(`Address ${ip.text} is not a public address`);
  }
}

export function checkHostname(host) {
  const name = pyLower(pyStrip(host).replace(/\.+$/, ''));
  if (!name) throw new SSRFError('Empty host');
  if (BLOCKED_HOSTNAMES.has(name) || BLOCKED_SUFFIXES.some((s) => name.endsWith(s))) {
    throw new SSRFError(`Host '${host}' is not allowed`);
  }
  const literal = name.replace(/^[[\]]+|[[\]]+$/g, ''); // Python name.strip("[]")
  if (parseIpAddress(literal) !== null) checkIp(literal); // literal IP in the URL
}

/** Static checks (no DNS). Throws SSRFError. */
export function validateUrl(url, { allowedPorts = [80, 443] } = {}) {
  const parts = urlsplit(url);
  const scheme = parts.scheme.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) throw new SSRFError(`Unsupported scheme '${parts.scheme}'`);
  if (parts.username || parts.password) throw new SSRFError('Credentials in URLs are not allowed');
  if (!parts.hostname) throw new SSRFError('URL has no host');
  let port;
  try {
    port = parts.port || (scheme === 'https' ? 443 : 80);
  } catch {
    throw new SSRFError('Invalid port');
  }
  if (!new Set(allowedPorts).has(port)) throw new SSRFError(`Port ${port} is not allowed`);
  checkHostname(parts.hostname);
}

/** Resolve like getaddrinfo(host, port, SOCK_STREAM): unique addresses in resolver order. */
export async function defaultResolver(host) {
  try {
    const answers = await dns.promises.lookup(host, { all: true, verbatim: true });
    return [...new Set(answers.map((a) => a.address))];
  } catch {
    throw new SSRFError(`Cannot resolve host '${host}'`);
  }
}

/** Resolve and require *every* address to be public (a single private answer blocks). */
export async function resolvePublic(host, port, resolver = defaultResolver) {
  checkHostname(host);
  const addresses = await resolver(host, port);
  if (!addresses.length) throw new SSRFError(`Host '${host}' did not resolve`);
  for (const address of addresses) checkIp(address);
  return addresses;
}

function blocked(message) {
  const err = new SSRFError(`SSRF protection: ${message}`);
  err.code = 'ERR_SSRF_BLOCKED';
  return err;
}

/** `dns.lookup`-compatible function that only ever yields validated public addresses. */
export function guardedLookup(resolver = defaultResolver) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    resolvePublic(hostname, 0, resolver).then(
      (addresses) => {
        const entries = addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
        if (opts.all) cb(null, entries);
        else cb(null, entries[0].address, entries[0].family);
      },
      (err) => cb(blocked(err.message)),
    );
  };
}

/** A connector for undici that validates the port and literal-IP hosts, then connects via the guarded lookup. */
export function createGuardedConnect({ resolver = defaultResolver, allowedPorts = [80, 443], timeout = 15_000 } = {}) {
  const allowed = new Set(allowedPorts);
  const base = buildConnector({ lookup: guardedLookup(resolver), timeout });
  return function connect(opts, callback) {
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    if (!allowed.has(port)) {
      callback(blocked(`port ${port} is not allowed`), null);
      return;
    }
    if (opts.socketPath) {
      callback(blocked('unix sockets are not allowed'), null);
      return;
    }
    try {
      checkHostname(String(opts.hostname ?? '').replace(/^\[|\]$/g, ''));
    } catch (err) {
      callback(blocked(err.message), null);
      return;
    }
    base(opts, callback);
  };
}

/** undici dispatcher for all crawler requests: public IPs only, allowed ports only, no proxy. */
export function createGuardedDispatcher({ resolver = defaultResolver, allowedPorts = [80, 443], timeoutSeconds = 15 } = {}) {
  const ms = Math.round(timeoutSeconds * 1000);
  return new Agent({
    connect: createGuardedConnect({ resolver, allowedPorts, timeout: ms }),
    headersTimeout: ms,
    bodyTimeout: ms,
    connections: 10,
  });
}

/** True when an error (or any error in its `cause` chain) is an SSRF block. */
export function isSsrfBlock(err) {
  for (let e = err, depth = 0; e && depth < 10; e = e.cause, depth += 1) {
    if (e instanceof SSRFError || String(e.message ?? '').includes('SSRF protection')) return true;
  }
  return false;
}

/** Message of the SSRF error inside a cause chain. */
export function ssrfMessage(err) {
  for (let e = err, depth = 0; e && depth < 10; e = e.cause, depth += 1) {
    if (String(e.message ?? '').includes('SSRF protection')) return e.message;
  }
  return String(err?.message ?? err);
}
